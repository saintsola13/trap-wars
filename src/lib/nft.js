import { PublicKey } from '@solana/web3.js';
import { BANDO_KIDS_COLLECTION_MINT, TRAP_STARS_COLLECTION_MINT, HOLDER_FEE_BPS, PLATFORM_FEE_BPS } from './constants';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function deriveMetadataPda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
    METADATA_PROGRAM
  );
  return pda;
}

// Scan raw metadata bytes for a verified collection key.
// We use a sliding window because the collection field's offset is variable
// (depends on variable-length creators array and option flags before it).
function hasVerifiedCollection(data, collectionKey) {
  const keyBytes = collectionKey.toBytes();
  // Collection field appears after a chain of option bytes; search from offset 300
  for (let i = 300; i < data.length - 33; i++) {
    if (data[i] !== 1) continue;      // option Some flag
    if (data[i + 1] !== 1) continue;  // verified = true
    let match = true;
    for (let j = 0; j < 32; j++) {
      if (data[i + 2 + j] !== keyBytes[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// Checks if wallet holds at least one verified NFT from the given collection
export async function checkNFTHolder(connection, walletPubkey, collectionMint) {
  if (!collectionMint || collectionMint.length < 32) return false;

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_PROGRAM,
    });

    const nftMints = tokenAccounts.value
      .filter(
        acc =>
          acc.account.data.parsed.info.tokenAmount.uiAmount === 1 &&
          acc.account.data.parsed.info.tokenAmount.decimals === 0
      )
      .map(acc => acc.account.data.parsed.info.mint);

    const collectionKey = new PublicKey(collectionMint);

    for (const mint of nftMints) {
      const metaPda = deriveMetadataPda(mint);
      const metaAccount = await connection.getAccountInfo(metaPda);
      if (!metaAccount || metaAccount.data.length < 300) continue;
      if (hasVerifiedCollection(metaAccount.data, collectionKey)) return true;
    }
    return false;
  } catch (e) {
    console.warn('NFT holder check failed:', e.message);
    return false;
  }
}

// Returns fee info for a wallet — checks both collections
export async function getFeeInfo(connection, walletPubkey) {
  if (!BANDO_KIDS_COLLECTION_MINT && !TRAP_STARS_COLLECTION_MINT) {
    return { feeBps: PLATFORM_FEE_BPS, isHolder: false, collectionName: null };
  }

  try {
    const [isBando, isTrapStars] = await Promise.all([
      checkNFTHolder(connection, walletPubkey, BANDO_KIDS_COLLECTION_MINT),
      checkNFTHolder(connection, walletPubkey, TRAP_STARS_COLLECTION_MINT),
    ]);

    if (isBando) return { feeBps: HOLDER_FEE_BPS, isHolder: true, collectionName: 'Bando Kids' };
    if (isTrapStars) return { feeBps: HOLDER_FEE_BPS, isHolder: true, collectionName: 'Trap Stars' };
  } catch {
    // Fall through to default
  }

  return { feeBps: PLATFORM_FEE_BPS, isHolder: false, collectionName: null };
}
