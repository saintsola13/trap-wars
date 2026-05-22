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
// Phase 3: 2-of-2 multisig (player + platform). Both must approve settlement.
// Returns { tx, createKeyBase58, multisigPda, vaultPda }
export async function buildCreateBattleMultisig({ connection, creator, platformPubkey }) {
  const createKey = Keypair.generate();
  const multisigPda = deriveMultisigPda(createKey.publicKey);
  const vaultPda = deriveVaultPda(multisigPda);

  const members = [
    { key: creator, permissions: Permissions.all() },
    { key: new PublicKey(platformPubkey), permissions: Permissions.all() },
  ];

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
    threshold: 2, // Phase 3: 2-of-2, player + platform both must approve
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

// ─── SETTLEMENT — STEP 1: Create vault transaction proposal ──────────────────
// Player calls this first. Creates the payout transaction on-chain.
// transactionIndex is always 1 for a fresh battle.
export async function buildSettlementProposal({
  connection,
  multisigPda,
  transactionIndex,
  proposer,
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

// ─── SETTLEMENT — STEP 2: Create proposal (makes it voteable) ────────────────
export async function buildProposalCreate({
  connection,
  multisigPda,
  transactionIndex,
  creator,
}) {
  const ix = multisig.instructions.proposalCreate({
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    creator,
    isDraft: false,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = creator;
  return tx;
}

// ─── SETTLEMENT — STEP 3: Player approves (their vote) ───────────────────────
export async function buildProposalApprove({
  connection,
  multisigPda,
  transactionIndex,
  member,
}) {
  const ix = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    member,
    memo: 'Trap Wars player approval',
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = member;
  return tx;
}

// ─── SETTLEMENT — STEP 4: Execute (after both approvals) ─────────────────────
export async function buildVaultExecute({
  connection,
  multisigPda,
  transactionIndex,
  executor,
  winnerPubkey,
  treasuryPubkey,
}) {
  const ix = await multisig.instructions.vaultTransactionExecute({
    connection,
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    member: executor,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(...ix.instructions);
  tx.recentBlockhash = blockhash;
  tx.feePayer = executor;
  return tx;
}
