import { PublicKey } from '@solana/web3.js';
import { WSOL_MINT } from './constants';

// Jupiter Price API v3. v2 was deprecated -> returned empty body -> portfolios
// showed "—" and winner couldn't be scored. v3 returns { MINT: { usdPrice } }
// directly (no .data wrapper, field is usdPrice not price).
const PRICE_API = 'https://lite-api.jup.ag/price/v3';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export async function getTokenPrices(mints) {
  if (!mints.length) return {};
  try {
    const ids = [...new Set([...mints, WSOL_MINT])].join(',');
    const res = await fetch(`${PRICE_API}?ids=${ids}`);
    const json = await res.json();
    return json || {};
  } catch {
    return {};
  }
}

// Returns { tokens: [{mint, amount}], solAmount, initialUsd }
export async function snapshotPortfolio(connection, walletPublicKey) {
  const [tokenAccounts, solBalance] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(walletPublicKey, { programId: TOKEN_PROGRAM }),
    connection.getBalance(walletPublicKey),
  ]);

  const tokens = tokenAccounts.value
    .map(acc => ({
      mint: acc.account.data.parsed.info.mint,
      amount: acc.account.data.parsed.info.tokenAmount.uiAmount || 0,
    }))
    .filter(t => t.amount > 0);

  const solAmount = solBalance / 1e9;
  const snapshot = { tokens, solAmount };

  try {
    const mints = [WSOL_MINT, ...tokens.map(t => t.mint)];
    const prices = await getTokenPrices(mints);
    const initialUsd = await evaluatePortfolio(snapshot, prices);
    return { tokens, solAmount, initialUsd };
  } catch {
    return { tokens, solAmount, initialUsd: 0 };
  }
}

// Returns total portfolio value in USD terms (using Jupiter prices)
export async function evaluatePortfolio(snapshot, priceData) {
  if (!snapshot) return 0;
  const tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens : [];
  const solAmount = snapshot.solAmount || 0;
  const solPriceUsd = priceData?.[WSOL_MINT]?.usdPrice || priceData?.[WSOL_MINT]?.price || 0;

  let totalUsd = solAmount * solPriceUsd;

  for (const token of tokens) {
    const priceUsd = priceData[token.mint]?.usdPrice || priceData[token.mint]?.price || 0;
    totalUsd += token.amount * priceUsd;
  }

  return totalUsd;
}

// Returns % gain/loss relative to initial snapshot
export function calcPercentChange(initialUsd, currentUsd) {
  if (!initialUsd || initialUsd === 0) return 0;
  return ((currentUsd - initialUsd) / initialUsd) * 100;
}

// Fetch all relevant mints from two snapshots for a batch price call
export function collectMints(snap1, snap2) {
  const mints = new Set([WSOL_MINT]);
  [snap1, snap2].forEach(snap => {
    if (snap && Array.isArray(snap.tokens)) {
      snap.tokens.forEach(t => t?.mint && mints.add(t.mint));
    }
  });
  return [...mints];
}
