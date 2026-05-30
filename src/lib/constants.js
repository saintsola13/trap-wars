export const SOLANA_RPC_URL =
  import.meta.env.VITE_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=282628c0-7331-4c9a-b997-cdd22dea9e25';

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

// Co-signer API URL
export const COSIGNER_API_URL =
  import.meta.env.VITE_COSIGNER_API_URL || 'https://api.trapwars.win';

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
