/**
 * Trap Wars Platform Co-Signer API
 * Runs on VPS — approves Squads settlement proposals as the platform member.
 *
 * Flow:
 *   1. Client proposes vaultTransaction + creates proposal (player signs)
 *   2. Client calls POST /cosign with battle data
 *   3. We re-verify winner via Jupiter, build proposalApprove tx, sign + send it
 *   4. Client executes the vault transaction
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  SystemProgram,
} = require('@solana/web3.js');
const multisig = require('@sqds/multisig');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
const RPC_URL = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=282628c0-7331-4c9a-b997-cdd22dea9e25';

// Platform keypair — generated 2026-05-22
const PLATFORM_SECRET = JSON.parse(process.env.PLATFORM_SECRET_KEY || '[]');
const platformKeypair = Keypair.fromSecretKey(Uint8Array.from(PLATFORM_SECRET));

console.log('Platform pubkey:', platformKeypair.publicKey.toBase58());

const connection = new Connection(RPC_URL, 'confirmed');
const app = express();
app.use(cors({ origin: ['https://trapwars.win', 'https://trap-wars.pages.dev', 'http://localhost:5173'] }));
app.use(express.json());

// ─── SQLITE BATTLE REGISTRY ───────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'battles.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS battles (
    id TEXT PRIMARY KEY,
    create_key TEXT,
    vault_address TEXT,
    player1 TEXT,
    player2 TEXT,
    stake REAL,
    duration_sec INTEGER,
    duration_label TEXT,
    fee_bps INTEGER,
    share_url TEXT,
    status TEXT DEFAULT 'OPEN',
    start_time INTEGER,
    end_time INTEGER,
    player1_snapshot TEXT,
    player2_snapshot TEXT,
    player1_initial_usd REAL,
    player2_initial_usd REAL,
    winner TEXT,
    player1_score REAL,
    player2_score REAL,
    settle_sig TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, pubkey: platformKeypair.publicKey.toBase58() });
});

// ─── BATTLE REGISTRY ENDPOINTS ────────────────────────────────────────────────

// POST /battle/register — register new battle when P1 creates it
app.post('/battle/register', (req, res) => {
  const { multisigPda, vaultAddress, player1, stake, durationSec, durationLabel, feeBps, createKey, shareUrl } = req.body;

  if (!multisigPda || !player1) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO battles
        (id, create_key, vault_address, player1, stake, duration_sec, duration_label, fee_bps, share_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `).run(multisigPda, createKey || null, vaultAddress || null, player1, stake || null, durationSec || null, durationLabel || null, feeBps || null, shareUrl || null);

    res.json({ ok: true });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /battle/:id — fetch battle record
app.get('/battle/:id', (req, res) => {
  const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
  if (!battle) return res.status(404).json({ error: 'Battle not found' });

  if (battle.player1_snapshot) {
    try { battle.player1_snapshot = JSON.parse(battle.player1_snapshot); } catch {}
  }
  if (battle.player2_snapshot) {
    try { battle.player2_snapshot = JSON.parse(battle.player2_snapshot); } catch {}
  }

  res.json(battle);
});

// POST /battle/:id/update — called when P2 joins
app.post('/battle/:id/update', (req, res) => {
  const {
    player2, player1Snapshot, player2Snapshot,
    startTime, endTime, status,
    player1InitialUsd, player2InitialUsd,
  } = req.body;

  try {
    db.prepare(`
      UPDATE battles
      SET player2 = ?, player1_snapshot = ?, player2_snapshot = ?,
          start_time = ?, end_time = ?, status = ?,
          player1_initial_usd = ?, player2_initial_usd = ?
      WHERE id = ?
    `).run(
      player2 || null,
      player1Snapshot ? JSON.stringify(player1Snapshot) : null,
      player2Snapshot ? JSON.stringify(player2Snapshot) : null,
      startTime || null,
      endTime || null,
      status || null,
      player1InitialUsd != null ? player1InitialUsd : null,
      player2InitialUsd != null ? player2InitialUsd : null,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Update error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /battle/:id/settle — called after settlement completes
app.post('/battle/:id/settle', (req, res) => {
  const { winner, player1Score, player2Score, settleSig } = req.body;

  try {
    db.prepare(`
      UPDATE battles
      SET status = 'SETTLED', winner = ?, player1_score = ?, player2_score = ?, settle_sig = ?
      WHERE id = ?
    `).run(winner || null, player1Score ?? null, player2Score ?? null, settleSig || null, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Settle error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /battle/:id/cancel — refund player1 when no opponent has joined
app.post('/battle/:id/cancel', async (req, res) => {
  const { requestor } = req.body;

  const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
  if (!battle) return res.status(404).json({ error: 'Battle not found' });
  if (battle.player2) return res.status(400).json({ error: 'Battle already has an opponent — cannot cancel' });
  if (!['OPEN', 'FUNDED'].includes(battle.status)) {
    return res.status(400).json({ error: `Cannot cancel battle with status: ${battle.status}` });
  }
  if (requestor !== battle.player1) {
    return res.status(403).json({ error: 'Only player1 can cancel this battle' });
  }

  try {
    const multisigKey = new PublicKey(battle.id);
    const [vaultPda] = multisig.getVaultPda({ multisigPda: multisigKey, index: 0 });

    const vaultBalance = await connection.getBalance(vaultPda);

    // Nothing deposited yet — just mark cancelled
    if (vaultBalance < 5000) {
      db.prepare("UPDATE battles SET status = 'CANCELLED' WHERE id = ?").run(battle.id);
      return res.json({ ok: true, sig: null, transactionIndex: 1 });
    }

    const refundLamports = vaultBalance - 5000;
    const txIndex = BigInt(1);

    // Step 1: Create vault transaction (cancel/refund)
    const { blockhash: innerBlockhash } = await connection.getLatestBlockhash();
    const innerMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: innerBlockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: vaultPda,
          toPubkey: new PublicKey(battle.player1),
          lamports: refundLamports,
        }),
      ],
    }).compileToV0Message();

    const createVaultTxIx = multisig.instructions.vaultTransactionCreate({
      multisigPda: multisigKey,
      transactionIndex: txIndex,
      creator: platformKeypair.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: innerMessage,
      memo: 'Trap Wars Cancel Refund',
    });

    const { blockhash: bh1 } = await connection.getLatestBlockhash();
    const createVaultTx = new Transaction().add(createVaultTxIx);
    createVaultTx.recentBlockhash = bh1;
    createVaultTx.feePayer = platformKeypair.publicKey;
    createVaultTx.sign(platformKeypair);
    const createVaultSig = await connection.sendRawTransaction(createVaultTx.serialize());
    await connection.confirmTransaction(createVaultSig, 'confirmed');

    // Step 2: Create proposal
    const proposalCreateIx = multisig.instructions.proposalCreate({
      multisigPda: multisigKey,
      transactionIndex: txIndex,
      creator: platformKeypair.publicKey,
      isDraft: false,
    });

    const { blockhash: bh2 } = await connection.getLatestBlockhash();
    const createProposalTx = new Transaction().add(proposalCreateIx);
    createProposalTx.recentBlockhash = bh2;
    createProposalTx.feePayer = platformKeypair.publicKey;
    createProposalTx.sign(platformKeypair);
    const createProposalSig = await connection.sendRawTransaction(createProposalTx.serialize());
    await connection.confirmTransaction(createProposalSig, 'confirmed');

    // Step 3: Platform approves (1-of-2)
    const approveIx = multisig.instructions.proposalApprove({
      multisigPda: multisigKey,
      transactionIndex: txIndex,
      member: platformKeypair.publicKey,
      memo: 'Trap Wars platform cancel approval',
    });

    const { blockhash: bh3 } = await connection.getLatestBlockhash();
    const approveTx = new Transaction().add(approveIx);
    approveTx.recentBlockhash = bh3;
    approveTx.feePayer = platformKeypair.publicKey;
    approveTx.sign(platformKeypair);
    const approveSig = await connection.sendRawTransaction(approveTx.serialize());
    await connection.confirmTransaction(approveSig, 'confirmed');

    // Mark as cancelled — player1 needs to approve + execute on-chain to complete the refund
    db.prepare("UPDATE battles SET status = 'CANCELLED' WHERE id = ?").run(battle.id);

    console.log(`Cancel initiated: ${battle.id}, platform approved tx ${txIndex}. Player1 (${battle.player1}) must approve + execute.`);
    res.json({ ok: true, sig: approveSig, transactionIndex: Number(txIndex) });

  } catch (e) {
    console.error('Cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── COSIGN ENDPOINT ──────────────────────────────────────────────────────────
/**
 * POST /cosign
 * Body: {
 *   multisigPda: string,
 *   transactionIndex: number,
 *   winner: string,
 *   loser: string,
 *   player1Snapshot: object,
 *   player2Snapshot: object,
 *   player1: string,
 *   player2: string,
 *   battleEndTime: number,
 *   winnerLamports: number,
 *   feeLamports: number,
 *   player1InitialUsd: number,   // optional — used for fair % gain verification
 *   player2InitialUsd: number,
 * }
 */
app.post('/cosign', async (req, res) => {
  try {
    const {
      multisigPda,
      transactionIndex,
      winner,
      loser,
      player1Snapshot,
      player2Snapshot,
      player1,
      player2,
      battleEndTime,
      winnerLamports,
      feeLamports,
      player1InitialUsd,
      player2InitialUsd,
    } = req.body;

    // Basic validation
    if (!multisigPda || !transactionIndex || !winner || !winnerLamports) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't sign battles that haven't ended yet
    const now = Date.now();
    if (battleEndTime && now < battleEndTime - 5000) {
      return res.status(400).json({ error: 'Battle not finished yet' });
    }

    // Verify winner via Jupiter independently
    const verifiedWinner = await verifyWinner(
      player1, player2,
      player1Snapshot, player2Snapshot,
      player1InitialUsd, player2InitialUsd
    );

    if (verifiedWinner && verifiedWinner !== winner) {
      console.warn(`Winner mismatch! Client says ${winner}, we computed ${verifiedWinner}`);
      return res.status(400).json({ error: 'Winner verification failed. Mismatched outcome.' });
    }

    // Build and send proposalApprove transaction
    const multisigKey = new PublicKey(multisigPda);
    const txIndex = BigInt(transactionIndex);

    const ix = multisig.instructions.proposalApprove({
      multisigPda: multisigKey,
      transactionIndex: txIndex,
      member: platformKeypair.publicKey,
      memo: 'Trap Wars platform approval',
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = blockhash;
    tx.feePayer = platformKeypair.publicKey;
    tx.sign(platformKeypair);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, 'confirmed');

    console.log(`Co-signed settlement. Multisig: ${multisigPda}, Winner: ${winner}, Sig: ${sig}`);
    res.json({ ok: true, sig, platformPubkey: platformKeypair.publicKey.toBase58() });

  } catch (err) {
    console.error('Co-sign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── WINNER VERIFICATION ──────────────────────────────────────────────────────
async function verifyWinner(player1, player2, snapshot1, snapshot2, player1InitialUsd, player2InitialUsd) {
  try {
    if (!snapshot1 || !snapshot2) return null; // can't verify, allow

    const mints = collectMints(snapshot1, snapshot2);
    if (!mints.length) return null;

    const priceRes = await fetch(
      `https://api.jup.ag/price/v2?ids=${mints.join(',')}`
    );
    const priceJson = await priceRes.json();
    const prices = priceJson.data || {};

    const WSOL = 'So11111111111111111111111111111111111111112';
    const solPrice = prices[WSOL]?.price || 0;

    const val1End = evalPortfolio(snapshot1, prices, solPrice);
    const val2End = evalPortfolio(snapshot2, prices, solPrice);

    // If fair initial USD values are provided (computed at join time), use them for % gain
    if (player1InitialUsd > 0 && player2InitialUsd > 0) {
      const pct1 = (val1End - player1InitialUsd) / player1InitialUsd;
      const pct2 = (val2End - player2InitialUsd) / player2InitialUsd;
      return pct1 >= pct2 ? player1 : player2;
    }

    // Fallback: compare end values directly (no baseline, less accurate)
    return val1End >= val2End ? player1 : player2;
  } catch (e) {
    console.warn('Price verification failed:', e.message);
    return null; // allow if can't verify
  }
}

function collectMints(s1, s2) {
  const mints = new Set();
  const WSOL = 'So11111111111111111111111111111111111111112';
  mints.add(WSOL);
  for (const t of [...(s1?.tokens || []), ...(s2?.tokens || [])]) {
    if (t.mint) mints.add(t.mint);
  }
  return [...mints];
}

function evalPortfolio(snapshot, prices, solPrice) {
  const WSOL = 'So11111111111111111111111111111111111111112';
  let total = (snapshot.solAmount || 0) * solPrice;
  for (const t of snapshot.tokens || []) {
    total += (t.amount || 0) * (prices[t.mint]?.price || 0);
  }
  return total;
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Trap Wars co-signer running on port ${PORT}`);
});
