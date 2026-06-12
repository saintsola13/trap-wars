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

// ─── RENT / GAS CONSTANTS ──────────────────────────────────────────
// A system (0-data) account must hold >= the rent-exempt minimum or be fully
// drained to 0. Draining a vault to tiny dust fails on-chain. Resolve + cache.
let RENT_EXEMPT_MIN = 890880; // safe default (~0.00089 SOL)
connection.getMinimumBalanceForRentExemption(0)
  .then(v => { RENT_EXEMPT_MIN = v; console.log('Rent-exempt min:', v); })
  .catch(() => {});

const PLATFORM_GAS_FLOOR = 30_000_000; // 0.03 SOL warn threshold
const TX_FEE_BUFFER = 5_000;           // per-tx fee buffer (lamports)

// ─── SHARED MULTISIG HELPERS ───────────────────────────────────
async function sendPlatformIx(ix, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = platformKeypair.publicKey;
  tx.sign(platformKeypair);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`  [${label}]`, sig);
  return sig;
}

// Full-drain split: amounts sum to exactly vaultBalance (no rent dust left).
function rentSafeSplit(vaultBalance, weights) {
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const amounts = weights.map(w => Math.floor((vaultBalance * w) / totalWeight));
  const distributed = amounts.reduce((a, b) => a + b, 0);
  amounts[0] += vaultBalance - distributed; // remainder to first recipient
  return amounts;
}

// Build vaultTx + proposal + platform approval for transfer ixs at txIndex.
// NOTE: SDK 2.1.4 wants the RAW TransactionMessage (NOT .compileToV0Message()).
async function buildAndApproveVaultTx(multisigPda, vaultPda, txIndex, transfers, memo) {
  const { blockhash } = await connection.getLatestBlockhash();
  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: transfers,
  });
  await sendPlatformIx(multisig.instructions.vaultTransactionCreate({
    multisigPda, transactionIndex: txIndex, creator: platformKeypair.publicKey,
    vaultIndex: 0, ephemeralSigners: 0, transactionMessage: innerMessage, memo,
  }), 'vaultTxCreate');
  await sendPlatformIx(multisig.instructions.proposalCreate({
    multisigPda, transactionIndex: txIndex, creator: platformKeypair.publicKey, isDraft: false,
  }), 'proposalCreate');
  await sendPlatformIx(multisig.instructions.proposalApprove({
    multisigPda, transactionIndex: txIndex, member: platformKeypair.publicKey,
    memo: 'Trap Wars platform approval',
  }), 'platformApprove');
}

// Execute an already-2of2-approved vault tx from the platform key.
// Adds a rent cushion to the vault so the drain never leaves invalid dust.
async function executeVaultTx(multisigPda, vaultPda, txIndex) {
  const cushion = RENT_EXEMPT_MIN + TX_FEE_BUFFER;
  await sendPlatformIx(SystemProgram.transfer({
    fromPubkey: platformKeypair.publicKey, toPubkey: vaultPda, lamports: cushion,
  }), 'vaultRentCushion');
  const execRes = await multisig.instructions.vaultTransactionExecute({
    connection, multisigPda, transactionIndex: txIndex, member: platformKeypair.publicKey,
  });
  const execIx = execRes.instruction || execRes.instructions?.[0] || execRes;
  return sendPlatformIx(execIx, 'vaultExecute');
}

// Read proposal approval state for a txIndex.
async function getProposalState(multisigPda, txIndex) {
  const [propPda] = multisig.getProposalPda({ multisigPda, transactionIndex: txIndex });
  try {
    const p = await multisig.accounts.Proposal.fromAccountAddress(connection, propPda);
    return {
      exists: true,
      status: Object.keys(p.status?.__kind ? { [p.status.__kind]: 1 } : p.status)[0] || String(p.status),
      approved: (p.approved || []).map(k => k.toBase58()),
    };
  } catch {
    return { exists: false, status: 'None', approved: [] };
  }
}

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
// POST /rpc — same-origin Solana RPC proxy (avoids Phantom in-app CORS blocks)
app.post('/rpc', async (req, res) => {
  try {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    const j = await r.json();
    res.json(j);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /recover-sol — one-click stuck-battle refund page
app.get('/recover-sol', (req, res) => {
  res.sendFile(path.join(__dirname, 'recover-sol.html'));
});

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

// ─── PLATFORM GAS STATUS ────────────────────────────────────────────────────
// GET /platform/gas — balance + whether it's above the safe floor.
app.get('/platform/gas', async (req, res) => {
  try {
    const lamports = await connection.getBalance(platformKeypair.publicKey);
    res.json({
      pubkey: platformKeypair.publicKey.toBase58(),
      lamports,
      sol: lamports / LAMPORTS_PER_SOL,
      floor: PLATFORM_GAS_FLOOR / LAMPORTS_PER_SOL,
      ok: lamports >= PLATFORM_GAS_FLOOR,
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── SERVER-DRIVEN SETTLE ───────────────────────────────────────────────────
// POST /battle/:id/settle-server
// Body: { playerApprovedTxIndex?, winner?, requestor }
// The fragile multi-tx orchestration + execute is done by the platform key so a
// flaky client wallet can't strand funds. Threshold is 2-of-2, so the client
// must have ALREADY approved its proposal (we verify on-chain). If not yet
// approved, we return needsApproval with the proposal info to sign.
app.post('/battle/:id/settle-server', async (req, res) => {
  try {
    const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    if (battle.status === 'SETTLED') return res.json({ ok: true, alreadySettled: true });
    if (!battle.player2) return res.status(400).json({ error: 'No opponent joined. Use /refund instead.' });
    if (battle.end_time && Date.now() < battle.end_time - 5000) {
      return res.status(400).json({ error: 'Battle not finished yet' });
    }

    const gas = await connection.getBalance(platformKeypair.publicKey);
    if (gas < TX_FEE_BUFFER * 6 + RENT_EXEMPT_MIN) {
      return res.status(503).json({ error: 'Platform gas low. Refill ' + platformKeypair.publicKey.toBase58(), gasLow: true });
    }

    const multisigPda = new PublicKey(battle.id);
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
    const vaultBalance = await connection.getBalance(vaultPda);
    // Treat a vault holding only rent dust as empty (nothing real to pay out).
    if (vaultBalance < RENT_EXEMPT_MIN + TX_FEE_BUFFER) {
      return res.status(400).json({ error: 'Vault empty (no stake to settle)' });
    }

    // Verify winner independently.
    let s1 = battle.player1_snapshot, s2 = battle.player2_snapshot;
    try { if (typeof s1 === 'string') s1 = JSON.parse(s1); } catch {}
    try { if (typeof s2 === 'string') s2 = JSON.parse(s2); } catch {}
    const verifiedWinner = await verifyWinner(
      battle.player1, battle.player2, s1, s2,
      battle.player1_initial_usd, battle.player2_initial_usd,
    ) || battle.player1; // default P1 on a draw / unverifiable

    const msInfo = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    const txIndex = BigInt(Number(msInfo.transactionIndex) + 1);

    // Rent-safe winner-take-all minus fee; full drain (sum == vaultBalance, no rent dust).
    // Fee is split flat 80/20: 80% -> treasury, 20% -> platform/gas wallet.
    const feeBps = battle.fee_bps || 300;
    const winnerWeight = 10000 - feeBps;
    const treasuryWeight = Math.round(feeBps * 0.8); // 80% of fee -> treasury
    const gasWeight = feeBps - treasuryWeight;       // remaining 20% of fee -> gas wallet
    const [winnerAmt, treasuryAmt, gasAmt] = rentSafeSplit(
      vaultBalance,
      [winnerWeight, treasuryWeight, gasWeight],
    );
    const winner = new PublicKey(verifiedWinner);
    // Payout: winner + treasury(80% fee) + gas(20% fee). Sum may be 1-2 lamports
    // short of vaultBalance due to floor() in rentSafeSplit; give the dust to winner.
    const dust = vaultBalance - (winnerAmt + treasuryAmt + gasAmt);
    const payout = [
      SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: winner, lamports: winnerAmt + dust }),
      SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: SQUADS_TREASURY_PAYOUT(), lamports: treasuryAmt }),
      SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: PLATFORM_GAS_PAYOUT(), lamports: gasAmt }),
    ];

    await buildAndApproveVaultTx(multisigPda, vaultPda, txIndex, payout, 'Trap Wars settle');

    // Now 1-of-2 (platform). Need the player's approval to reach threshold 2.
    const state = await getProposalState(multisigPda, txIndex);
    const playerApproved = state.approved.includes(battle.player1) || state.approved.includes(battle.player2);
    if (!playerApproved) {
      return res.json({
        ok: false, needsApproval: true,
        multisigPda: battle.id, transactionIndex: Number(txIndex), winner: verifiedWinner,
        note: 'Platform approved. Player must approve proposal, then call settle-server again to execute.',
      });
    }

    const execSig = await executeVaultTx(multisigPda, vaultPda, txIndex);
    db.prepare("UPDATE battles SET status='SETTLED', winner=?, settle_sig=? WHERE id=?")
      .run(verifiedWinner, execSig, battle.id);
    res.json({ ok: true, executed: true, winner: verifiedWinner, sig: execSig });
  } catch (e) {
    console.error('settle-server error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Treasury that receives platform fees (NOT the Squads program treasury).
function SQUADS_TREASURY_PAYOUT() {
  return new PublicKey(process.env.TREASURY_WALLET || 'GB6CqqrhVj8cZZDpvY1Kh77bvESbypEc4aFUWWFBK16y');
}

// Platform/gas wallet — receives the 20% slice of each fee (matches co-signer pubkey).
function PLATFORM_GAS_PAYOUT() {
  return new PublicKey(process.env.PLATFORM_WALLET || 'G2YGgGN94wF5SbFgnXjTDFYEnQ7DTDoKZHNXLsZ8WX8g');
}

// ─── SERVER-DRIVEN REFUND (both players) ────────────────────────────────────
// POST /battle/:id/refund-server  Body: { requestor }
// Refunds the vault split evenly to both players (or all to P1 if solo).
// Full server-driven: builds, platform-approves; executes once a player approval
// exists on-chain. Used for stuck/broken battles.
app.post('/battle/:id/refund-server', async (req, res) => {
  try {
    const battle = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    if (battle.status === 'SETTLED' || battle.status === 'CANCELLED') {
      return res.json({ ok: true, alreadyResolved: true, status: battle.status });
    }
    const gas = await connection.getBalance(platformKeypair.publicKey);
    if (gas < TX_FEE_BUFFER * 6 + RENT_EXEMPT_MIN) {
      return res.status(503).json({ error: 'Platform gas low. Refill ' + platformKeypair.publicKey.toBase58(), gasLow: true });
    }

    const multisigPda = new PublicKey(battle.id);
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
    const vaultBalance = await connection.getBalance(vaultPda);
    // Treat a vault holding only rent dust as already empty — don't burn gas.
    if (vaultBalance < RENT_EXEMPT_MIN + TX_FEE_BUFFER) {
      db.prepare("UPDATE battles SET status='CANCELLED' WHERE id=?").run(battle.id);
      return res.json({ ok: true, refunded: 0, note: 'Vault already empty' });
    }

    const msInfo = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    const txIndex = BigInt(Number(msInfo.transactionIndex) + 1);

    let transfers;
    if (battle.player2) {
      const [a, b] = rentSafeSplit(vaultBalance, [1, 1]);
      transfers = [
        SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(battle.player1), lamports: a }),
        SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(battle.player2), lamports: b }),
      ];
    } else {
      transfers = [
        SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(battle.player1), lamports: vaultBalance }),
      ];
    }

    await buildAndApproveVaultTx(multisigPda, vaultPda, txIndex, transfers, 'Trap Wars refund');

    const state = await getProposalState(multisigPda, txIndex);
    const playerApproved = state.approved.includes(battle.player1) || (battle.player2 && state.approved.includes(battle.player2));
    if (!playerApproved) {
      return res.json({
        ok: false, needsApproval: true,
        multisigPda: battle.id, transactionIndex: Number(txIndex),
        note: 'Platform approved. A player must approve the proposal, then call refund-server again to execute.',
      });
    }
    const execSig = await executeVaultTx(multisigPda, vaultPda, txIndex);
    db.prepare("UPDATE battles SET status='CANCELLED' WHERE id=?").run(battle.id);
    res.json({ ok: true, executed: true, sig: execSig, refunded: vaultBalance / LAMPORTS_PER_SOL });
  } catch (e) {
    console.error('refund-server error:', e);
    res.status(500).json({ error: e.message });
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
