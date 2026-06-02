/**
 * Trap Wars Platform Co-Signer API
 * Runs on VPS — approves Squads settlement proposals as the platform member.
 * Also hosts battle registry (SQLite) and cancel/refund logic.
 *
 * Flow:
 *   1. Client registers battle via POST /battle/register
 *   2. Client proposes vaultTransaction + creates proposal (player signs)
 *   3. Client calls POST /cosign with battle data
 *   4. We re-verify winner via Jupiter, build proposalApprove tx, sign + send it
 *   5. Client executes the vault transaction
 *   6. Client calls POST /battle/:id/settle to record outcome
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
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const multisig = require('@sqds/multisig');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
const RPC_URL = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=282628c0-7331-4c9a-b997-cdd22dea9e25';

const PLATFORM_SECRET = JSON.parse(process.env.PLATFORM_SECRET_KEY || '[]');
const platformKeypair = Keypair.fromSecretKey(Uint8Array.from(PLATFORM_SECRET));
const SQUADS_TREASURY = new PublicKey('BSTq9w3kZwNwpBXJEvTZz2G9ZTNY7BLdbxGd3SqNPMZy');

console.log('Platform pubkey:', platformKeypair.publicKey.toBase58());

const connection = new Connection(RPC_URL, 'confirmed');
const app = express();

app.use(cors({
  origin: [
    'https://trapwars.win',
    'https://trap-wars.pages.dev',
    'http://localhost:5173',
  ],
}));
app.use(express.json());

// ─── SQLITE BATTLE REGISTRY ───────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'battles.db');
const db = new Database(DB_PATH);

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

// ─── BATTLE RECOVERY PAGE ─────────────────────────────────────────────────────
// GET /recover/:id — serves a page that restores battle state to localStorage then redirects
app.get('/recover/:id', (req, res) => {
  const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
  if (!battle) return res.status(404).send('Battle not found');
  if (battle.player1_snapshot) battle.player1_snapshot = JSON.parse(battle.player1_snapshot);
  if (battle.player2_snapshot) battle.player2_snapshot = JSON.parse(battle.player2_snapshot);

  const battleObj = {
    id: battle.id,
    createKey: battle.create_key,
    vaultAddress: battle.vault_address,
    player1: battle.player1,
    player2: battle.player2,
    stake: battle.stake,
    status: battle.status,
    startTime: battle.start_time,
    endTime: battle.end_time,
    feeBps: battle.fee_bps,
    durationLabel: battle.duration_label,
    shareUrl: battle.share_url,
    player1InitialUsd: battle.player1_initial_usd,
    player2InitialUsd: battle.player2_initial_usd,
    player1Snapshot: battle.player1_snapshot,
    player2Snapshot: battle.player2_snapshot,
  };

  const script = JSON.stringify(battleObj);
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recovering...</title></head><body>
<p style="font-family:monospace;padding:20px">Restoring battle... redirecting to Trap Wars.</p>
<script>
try{
localStorage.setItem('trapwars_battle_v2', ${JSON.stringify(script)});
}catch(e){}
window.location.href = 'https://trapwars.win';
</script></body></html>`);
});

// ─── BATTLE REGISTRY ENDPOINTS ────────────────────────────────────────────────

/** POST /battle/register — called when P1 creates a battle */
app.post('/battle/register', (req, res) => {
  try {
    const {
      multisigPda, vaultAddress, player1, stake,
      durationSec, durationLabel, feeBps, createKey, shareUrl,
    } = req.body;

    if (!multisigPda || !player1 || !stake) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO battles
        (id, create_key, vault_address, player1, stake, duration_sec, duration_label, fee_bps, share_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `);
    stmt.run(multisigPda, createKey, vaultAddress, player1, stake, durationSec, durationLabel, feeBps, shareUrl);

    res.json({ ok: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /battle/:id — fetch battle by multisig PDA */
app.get('/battle/:id', (req, res) => {
  const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
  if (!battle) return res.status(404).json({ error: 'Battle not found' });

  // Parse JSON fields
  if (battle.player1_snapshot) battle.player1_snapshot = JSON.parse(battle.player1_snapshot);
  if (battle.player2_snapshot) battle.player2_snapshot = JSON.parse(battle.player2_snapshot);

  res.json(battle);
});

/** POST /battle/:id/update — called when P2 joins */
app.post('/battle/:id/update', (req, res) => {
  try {
    const { player2, player1Snapshot, player2Snapshot, player1InitialUsd, player2InitialUsd, startTime, endTime, status } = req.body;
    db.prepare(`
      UPDATE battles SET
        player2 = ?, player1_snapshot = ?, player2_snapshot = ?,
        player1_initial_usd = ?, player2_initial_usd = ?,
        start_time = ?, end_time = ?, status = ?
      WHERE id = ?
    `).run(
      player2,
      JSON.stringify(player1Snapshot),
      JSON.stringify(player2Snapshot),
      player1InitialUsd,
      player2InitialUsd,
      startTime,
      endTime,
      status || 'ACTIVE',
      req.params.id,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /battle/:id/settle — called after settlement is confirmed */
app.post('/battle/:id/settle', (req, res) => {
  try {
    const { winner, player1Score, player2Score, settleSig } = req.body;
    db.prepare(`
      UPDATE battles SET
        winner = ?, player1_score = ?, player2_score = ?, settle_sig = ?, status = 'SETTLED'
      WHERE id = ?
    `).run(winner, player1Score, player2Score, settleSig, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Settle record error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /battle/:id/cancel — P1 cancels and gets refunded */
app.post('/battle/:id/cancel', async (req, res) => {
  try {
    const { requestor } = req.body;
    const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);

    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    if (battle.player1 !== requestor) return res.status(403).json({ error: 'Only P1 can cancel' });
    if (battle.player2) return res.status(400).json({ error: 'Battle already has an opponent. Cannot cancel.' });
    if (!['OPEN', 'FUNDED'].includes(battle.status)) {
      return res.status(400).json({ error: `Cannot cancel battle in status: ${battle.status}` });
    }

    const multisigPda = new PublicKey(battle.id);
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

    // Check vault balance
    const vaultBalance = await connection.getBalance(vaultPda);

    if (vaultBalance === 0) {
      // Nothing in vault — just mark cancelled (battle was OPEN but not funded)
      db.prepare("UPDATE battles SET status = 'CANCELLED' WHERE id = ?").run(battle.id);
      return res.json({ ok: true, refundedLamports: 0, note: 'No funds in vault' });
    }

    // Reserve enough for tx fees
    const TX_FEE_RESERVE = 10_000; // lamports
    const refundLamports = vaultBalance - TX_FEE_RESERVE;

    if (refundLamports <= 0) {
      return res.status(400).json({ error: 'Vault balance too low to refund (less than tx fees)' });
    }

    const player1Pubkey = new PublicKey(battle.player1);
    const TX_INDEX = BigInt(1);

    // Step 1: Create vault transaction (refund to P1)
    const { blockhash: bh1 } = await connection.getLatestBlockhash();
    const innerMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: bh1,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: vaultPda,
          toPubkey: player1Pubkey,
          lamports: refundLamports,
        }),
      ],
    }).compileToV0Message();

    const vaultTxIx = multisig.instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex: TX_INDEX,
      creator: platformKeypair.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: innerMessage,
      memo: 'Trap Wars Refund',
    });

    const { blockhash: bh2 } = await connection.getLatestBlockhash();
    const vaultTx = new Transaction().add(vaultTxIx);
    vaultTx.recentBlockhash = bh2;
    vaultTx.feePayer = platformKeypair.publicKey;
    vaultTx.sign(platformKeypair);
    const vaultSig = await connection.sendRawTransaction(vaultTx.serialize());
    await connection.confirmTransaction(vaultSig, 'confirmed');

    // Step 2: Create proposal (make it voteable)
    const propIx = multisig.instructions.proposalCreate({
      multisigPda,
      transactionIndex: TX_INDEX,
      creator: platformKeypair.publicKey,
      isDraft: false,
    });
    const { blockhash: bh3 } = await connection.getLatestBlockhash();
    const propTx = new Transaction().add(propIx);
    propTx.recentBlockhash = bh3;
    propTx.feePayer = platformKeypair.publicKey;
    propTx.sign(platformKeypair);
    const propSig = await connection.sendRawTransaction(propTx.serialize());
    await connection.confirmTransaction(propSig, 'confirmed');

    // Step 3: Platform approves
    const approveIx = multisig.instructions.proposalApprove({
      multisigPda,
      transactionIndex: TX_INDEX,
      member: platformKeypair.publicKey,
      memo: 'Trap Wars refund approval',
    });
    const { blockhash: bh4 } = await connection.getLatestBlockhash();
    const approveTx = new Transaction().add(approveIx);
    approveTx.recentBlockhash = bh4;
    approveTx.feePayer = platformKeypair.publicKey;
    approveTx.sign(platformKeypair);
    const approveSig = await connection.sendRawTransaction(approveTx.serialize());
    await connection.confirmTransaction(approveSig, 'confirmed');

    // Step 4: Execute vault transaction (2-of-2 met if multisig has platform+player,
    // but for cancel we need player approval too — or if threshold=1 for refunds)
    // NOTE: With 2-of-2 multisig, platform alone cannot execute. We return the
    // proposal approval sig so the client can execute (player signs the execute tx).
    db.prepare("UPDATE battles SET status = 'CANCEL_PENDING' WHERE id = ?").run(battle.id);

    console.log(`Cancel approved. Multisig: ${battle.id}, P1: ${battle.player1}, RefundSig: ${approveSig}`);
    res.json({
      ok: true,
      platformApprovedSig: approveSig,
      refundLamports,
      multisigPda: battle.id,
      transactionIndex: 1,
      note: 'Platform approved. Player must now execute the vault transaction to receive refund.',
    });

  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /battle/:id/cancel-confirm — called after player executes the refund */
app.post('/battle/:id/cancel-confirm', (req, res) => {
  try {
    db.prepare("UPDATE battles SET status = 'CANCELLED' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── COSIGN ENDPOINT ──────────────────────────────────────────────────────────
app.post('/cosign', async (req, res) => {
  try {
    const {
      multisigPda,
      transactionIndex,
      winner,
      loser,
      player1Snapshot,
      player2Snapshot,
      player1InitialUsd,
      player2InitialUsd,
      player1,
      player2,
      battleEndTime,
      winnerLamports,
      feeLamports,
    } = req.body;

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
      player1InitialUsd, player2InitialUsd,
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
async function verifyWinner(player1, player2, snapshot1, snapshot2, p1InitialUsd, p2InitialUsd) {
  try {
    if (!snapshot1 || !snapshot2) return null;

    const mints = collectMints(snapshot1, snapshot2);
    if (!mints.length) return null;

    const priceRes = await fetch(`https://api.jup.ag/price/v2?ids=${mints.join(',')}`);
    const priceJson = await priceRes.json();
    const prices = priceJson.data || {};

    const WSOL = 'So11111111111111111111111111111111111111112';
    const solPrice = prices[WSOL]?.price || 0;

    const val1End = evalPortfolio(snapshot1, prices, solPrice);
    const val2End = evalPortfolio(snapshot2, prices, solPrice);

    // If we have initial USD values, use true % gain (most accurate)
    if (p1InitialUsd > 0 && p2InitialUsd > 0) {
      const pct1 = (val1End - p1InitialUsd) / p1InitialUsd;
      const pct2 = (val2End - p2InitialUsd) / p2InitialUsd;
      console.log(`Winner verify: P1 ${(pct1*100).toFixed(2)}% vs P2 ${(pct2*100).toFixed(2)}%`);
      return pct1 >= pct2 ? player1 : player2;
    }

    // Fallback: absolute value (less accurate but better than nothing)
    console.warn('No initialUsd provided — falling back to absolute value comparison');
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
  console.log(`Trap Wars co-signer + registry running on port ${PORT}`);
});
