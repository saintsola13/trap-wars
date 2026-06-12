// Co-signer API URL. MUST be SAME-ORIGIN to survive Phantom/Solflare in-app
// browsers (WebKit). Cross-origin fetches to api.trapwars.win throw
// "TypeError: Load failed" / "failed to get recent blockhash" inside the wallet
// webview even with correct CORS. We route everything through the same-origin
// Pages proxy: trapwars.win/api/* -> api.trapwars.win/* (see public/_redirects, 200 rewrite).
// Override only with a same-origin path if ever needed.
// NOTE: intentionally NOT honoring VITE_COSIGNER_API_URL anymore. Cloudflare
// Pages has it set to the cross-origin https://api.trapwars.win, which WebKit
// wallet webviews block ("TypeError: Load failed" / blockhash errors). We force
// the same-origin /api proxy here so a stale Pages env var can't reintroduce the
// cross-origin bug. (Same pattern already used to ignore VITE_RPC_URL.)
const _envCosigner = import.meta.env.VITE_COSIGNER_API_URL;
export const COSIGNER_API_URL =
  _envCosigner && _envCosigner.startsWith('/') ? _envCosigner : '/api';

// Same-origin RPC proxy -> /api/rpc -> api.trapwars.win/rpc. Keeps the Helius
// key server-side and avoids cross-origin webview fetch failures entirely.
// web3.js Connection requires an ABSOLUTE url, so resolve against the current
// origin when COSIGNER_API_URL is a relative path.
const _absBase =
  COSIGNER_API_URL.startsWith('http')
    ? COSIGNER_API_URL
    : (typeof window !== 'undefined'
        ? `${window.location.origin}${COSIGNER_API_URL}`
        : `https://trapwars.win${COSIGNER_API_URL}`);
export const SOLANA_RPC_URL = `${_absBase}/rpc`;

// Platform fee in basis points (300 = 3%)
export const PLATFORM_FEE_BPS = 300;
// Discounted fee for NFT holders (150 = 1.5%)
export const HOLDER_FEE_BPS = 150;

// Treasury wallet — receives platform fees on settlement
export const TREASURY_WALLET =
  import.meta.env.VITE_TREASURY_WALLET || 'GB6CqqrhVj8cZZDpvY1Kh77bvESbypEc4aFUWWFBK16y';

// Platform co-signer wallet (Phase 3 keypair — public key only in frontend)
// NOTE: Hardcoded intentionally — must match the VPS co-signer keypair pubkey.
// Do NOT override via VITE_PLATFORM_WALLET env var (Cloudflare had this set to treasury by mistake).
export const PLATFORM_WALLET = 'G2YGgGN94wF5SbFgnXjTDFYEnQ7DTDoKZHNXLsZ8WX8g';

// NFT collection mints — set via env vars
export const BANDO_KIDS_COLLECTION_MINT =
  import.meta.env.VITE_BANDO_KIDS_MINT || '';
export const TRAP_STARS_COLLECTION_MINT =
  import.meta.env.VITE_TRAP_STARS_MINT || '';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const STAKE_OPTIONS = ['0.1', '0.5', '1'];
export const DEGEN_STAKE = '5';

export const BATTLE_DURATIONS = {
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
};
