import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  Keypair,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

const { Permissions } = multisig.types;

// ─── PDA DERIVATION ──────────────────────────────────────────────────────────

export function deriveMultisigPda(createKeyPubkey) {
  const [pda] = multisig.getMultisigPda({ createKey: new PublicKey(createKeyPubkey) });
  return pda;
}

export function deriveVaultPda(multisigPda) {
  const [pda] = multisig.getVaultPda({ multisigPda, index: 0 });
  return pda;
}

// ─── BATTLE MULTISIG CREATION ─────────────────────────────────────────────────
// Creates a 2-of-3 multisig: player1, player2 (optional at creation), platform
// Returns { tx, createKeyBase58, multisigPda, vaultPda }
export async function buildCreateBattleMultisig({ connection, creator, platformPubkey }) {
  const createKey = Keypair.generate();
  const multisigPda = deriveMultisigPda(createKey.publicKey);
  const vaultPda = deriveVaultPda(multisigPda);

  // Squads Protocol v4 requires members sorted by public key
  const members = [
    { key: creator, permissions: Permissions.all() },
    { key: new PublicKey(platformPubkey), permissions: Permissions.all() },
  ].sort((a, b) => a.key.toBase58().localeCompare(b.key.toBase58()));

  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda
  );

  const { blockhash } = await connection.getLatestBlockhash();

  const ix = multisig.instructions.multisigCreateV2({
    createKey: createKey.publicKey,
    creator,
    multisigPda,
    treasury: programConfig.treasury,
    configAuthority: null,
    threshold: 2,
    members,
    timeLock: 0,
    rentCollector: null,
    memo: 'Trap Wars Battle',
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator;
  tx.partialSign(createKey);

  return {
    tx,
    createKeyBase58: createKey.publicKey.toBase58(),
    multisigPda,
    vaultPda,
  };
}

// ─── DEPOSIT ─────────────────────────────────────────────────────────────────
// Simple SOL transfer from player to vault PDA
export async function buildDepositTransaction({ connection, player, vaultPda, amountSol }) {
  const { blockhash } = await connection.getLatestBlockhash();
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: player, toPubkey: vaultPda, lamports })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = player;
  return tx;
}

// ─── VAULT BALANCE CHECK ─────────────────────────────────────────────────────
export async function getVaultBalance(connection, vaultPda) {
  const bal = await connection.getBalance(new PublicKey(vaultPda));
  return bal / LAMPORTS_PER_SOL;
}

// ─── SETTLEMENT TRANSACTION ───────────────────────────────────────────────────
// Proposes a vault transaction that sends winnerAmount to winner + fee to treasury.
// Requires platform co-signature off-chain before execution.
export async function buildSettlementProposal({
  connection,
  multisigPda,
  transactionIndex,
  proposer,      // PublicKey — the player requesting settlement
  winnerPubkey,
  treasuryPubkey,
  winnerLamports,
  feeLamports,
}) {
  const vaultPda = deriveVaultPda(multisigPda);
  const { blockhash } = await connection.getLatestBlockhash();

  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: vaultPda,
        toPubkey: new PublicKey(winnerPubkey),
        lamports: winnerLamports,
      }),
      SystemProgram.transfer({
        fromPubkey: vaultPda,
        toPubkey: new PublicKey(treasuryPubkey),
        lamports: feeLamports,
      }),
    ],
  }).compileToV0Message();

  const ix = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    creator: proposer,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo: 'Trap Wars Settlement',
  });

  const { blockhash: blockhash2 } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash2;
  tx.feePayer = proposer;
  return tx;
}
