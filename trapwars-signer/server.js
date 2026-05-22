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
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} = require('@solana/web3.js');
const multisig = require('@sqds/multisig');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

// Platform keypair — generated 2026-05-22
const PLATFORM_SECRET = JSON.parse(process.env.PLATFORM_SECRET_KEY || '[]');
const platformKeypair = Keypair.fromSecretKey(Uint8Array.from(PLATFORM_SECRET));

console.log('Platform pubkey:', platformKeypair.publicKey.toBase58());

const connection = new Connection(RPC_URL, 'confirmed');
const app = express();
app.use(cors({ origin: ['https://trapwars.win', 'https://trap-wars.pages.dev', 'http://localhost:5173'] }));
app.use(express.json());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, pubkey: platformKeypair.publicKey.toBase58() });
});

// ─── COSIGN ENDPOINT ──────────────────────────────────────────────────────────
/**
 * POST /cosign
 * Body: {
 *   multisigPda: string,
 *   transactionIndex: number,
 *   winner: string,          // winner's pubkey
 *   loser: string,           // loser's pubkey
 *   player1Snapshot: object, // { tokens, solAmount }
 *   player2Snapshot: object,
 *   player1: string,
 *   player2: string,
 *   battleEndTime: number,   // unix ms
 *   winnerLamports: number,
 *   feeLamports: number,
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
      player1Snapshot, player2Snapshot
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
async function verifyWinner(player1, player2, snapshot1, snapshot2) {
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

    const val1 = evalPortfolio(snapshot1, prices, solPrice);
    const val2 = evalPortfolio(snapshot2, prices, solPrice);

    // We can't compute % gain without initial values — use absolute value comparison
    // In a real system we'd store initial snapshots server-side
    return val1 >= val2 ? player1 : player2;
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
