import { useState, useEffect, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { confirmSignature } from '../lib/confirm';
import { useApp } from '../context/AppContext';
import {
  STAKE_OPTIONS,
  DEGEN_STAKE,
  BATTLE_DURATIONS,
  PLATFORM_WALLET,
  COSIGNER_API_URL,
} from '../lib/constants';
import {
  buildCreateBattleMultisig,
  buildDepositTransaction,
  deriveVaultPda,
  deriveMultisigPda,
  buildProposalApprove,
} from '../lib/squads';
import { getFeeInfo } from '../lib/nft';
import { toFeePercent, calcFeeAmountSol, calcWinnerAmountSol, truncateAddress } from '../lib/fees';
import { snapshotPortfolio } from '../lib/jupiter';

export function BattlePanel() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { isDegenMode, setIsDegenMode, showToast, setBattle, clearBattle, battle } = useApp();

  const [selectedStake, setSelectedStake] = useState('0.1');
  const [selectedDuration, setSelectedDuration] = useState('15m');
  const [feeInfo, setFeeInfo] = useState({ feeBps: 300, isHolder: false, collectionName: null });
  const [creating, setCreating] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);

  // Load fee info based on NFT holdings
  useEffect(() => {
    if (!publicKey) return;
    getFeeInfo(connection, publicKey)
      .then(setFeeInfo)
      .catch(() => {});
  }, [connection, publicKey]);

  // Poll co-signer API while P1 waits for an opponent. Bulletproof version:
  // - Server is the single source of truth (not local-only timers).
  // - Polls whenever P1 is in a pre-battle state (OPEN or FUNDED), not just FUNDED.
  // - Survives transient errors (never stops the interval on a failed fetch).
  // - Uses same-origin proxy origin so Phantom in-app browser can reach it.
  useEffect(() => {
    const myKey = publicKey?.toBase58();
    if (!battle?.id || !myKey || battle.player1 !== myKey) return;
    if (!['OPEN', 'FUNDED'].includes(battle.status)) return;

    let stopped = false;
    const poll = setInterval(async () => {
      if (stopped) return;
      try {
        const res = await fetch(`${COSIGNER_API_URL}/battle/${battle.id}`, { cache: 'no-store' });
        if (!res.ok) return; // keep polling; transient
        const data = await res.json();
        if ((data.status === 'ACTIVE' || data.status === 'SETTLED') && data.player2) {
          setBattle(prev => ({
            ...prev,
            player2: data.player2,
            player1Snapshot: data.player1_snapshot || prev.player1Snapshot,
            player2Snapshot: data.player2_snapshot || prev.player2Snapshot,
            player1InitialUsd: data.player1_initial_usd ?? prev.player1InitialUsd,
            player2InitialUsd: data.player2_initial_usd ?? prev.player2InitialUsd,
            startTime: data.start_time ?? prev.startTime,
            endTime: data.end_time ?? prev.endTime,
            status: data.status,
          }));
          showToast('Opponent joined! Battle is live.');
          stopped = true;
          clearInterval(poll);
        }
      } catch { /* network blip — keep polling */ }
    }, 4000);

    return () => { stopped = true; clearInterval(poll); };
  }, [battle?.id, battle?.status, publicKey, setBattle, showToast]);

  // ── CREATE BATTLE ─────────────────────────────────────────────────────────
  const handleCreateBattle = useCallback(async () => {
    if (!publicKey) return;
    setCreating(true);
    showToast('Creating battle on Squads...');

    try {
      const { tx, createKeyBase58, multisigPda, vaultPda } = await buildCreateBattleMultisig({
        connection,
        creator: publicKey,
        platformPubkey: PLATFORM_WALLET,
      });

      const sig = await sendTransaction(tx, connection);
      await confirmSignature(connection, sig);

      // CRITICAL: verify multisig was actually created on-chain.
      // If it failed, do NOT deposit — funds would be permanently locked.
      const txDetails = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (txDetails?.meta?.err) {
        throw new Error('Multisig creation failed on-chain. No funds deposited. Try again.');
      }

      const stakeAmount = parseFloat(isDegenMode && selectedStake !== DEGEN_STAKE
        ? selectedStake
        : selectedStake);

      const durationSec = BATTLE_DURATIONS[selectedDuration];
      const shareUrl = `${window.location.origin}${window.location.pathname}?battle=${multisigPda.toBase58()}&stake=${stakeAmount}&dur=${selectedDuration}&p1=${publicKey.toBase58()}`;

      setBattle({
        id: multisigPda.toBase58(),
        createKey: createKeyBase58,
        vaultAddress: vaultPda.toBase58(),
        player1: publicKey.toBase58(),
        player2: null,
        stake: stakeAmount,
        duration: durationSec,
        durationLabel: selectedDuration,
        status: 'OPEN',
        startTime: null,
        endTime: null,
        player1Snapshot: null,
        player2Snapshot: null,
        player1InitialUsd: null,
        player2InitialUsd: null,
        player1Score: null,
        player2Score: null,
        winner: null,
        feeBps: feeInfo.feeBps,
        isDegenMode,
        shareUrl,
        createSig: sig,
      });

      // Register battle server-side
      fetch(`${COSIGNER_API_URL}/battle/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          multisigPda: multisigPda.toBase58(),
          vaultAddress: vaultPda.toBase58(),
          player1: publicKey.toBase58(),
          stake: stakeAmount,
          durationSec,
          durationLabel: selectedDuration,
          feeBps: feeInfo.feeBps,
          createKey: createKeyBase58,
          shareUrl,
        }),
      }).catch(() => {});

      showToast('Battle created! Deposit to lock it in.');
    } catch (e) {
      console.error(e);
      showToast(e.message?.includes('rejected') ? 'Transaction rejected.' : `Failed: ${e.message?.slice(0, 80) || 'unknown error'}`);
    } finally {
      setCreating(false);
    }
  }, [publicKey, connection, sendTransaction, selectedStake, selectedDuration, feeInfo, isDegenMode, setBattle, showToast]);

  // ── DEPOSIT ───────────────────────────────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    if (!publicKey || !battle) return;
    setDepositing(true);
    showToast('Depositing to Squads vault...');

    try {
      const vaultPda = new PublicKey(battle.vaultAddress);
      const tx = await buildDepositTransaction({
        connection,
        player: publicKey,
        vaultPda,
        amountSol: battle.stake,
      });

      const sig = await sendTransaction(tx, connection);
      await confirmSignature(connection, sig);

      // Snapshot portfolio at deposit time (holdings baseline for player 1)
      const snapshot = await snapshotPortfolio(connection, publicKey);

      setBattle(prev => ({
        ...prev,
        status: 'FUNDED',
        player1Snapshot: snapshot,
        player1InitialUsd: snapshot.initialUsd || null,
        player1DepositSig: sig,
      }));

      showToast(`Deposited ${battle.stake} SOL. Waiting for opponent.`);
    } catch (e) {
      console.error(e);
      showToast(e.message?.includes('rejected') ? 'Deposit rejected.' : 'Deposit failed.');
    } finally {
      setDepositing(false);
    }
  }, [publicKey, connection, sendTransaction, battle, setBattle, showToast]);

  // ── CANCEL LOBBY (local only) ─────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    clearBattle();
  }, [clearBattle]);

  // ── CANCEL & REFUND (SERVER-DRIVEN, robust) ──────────────────────────────
  // The platform key drives the fragile orchestration + execute. The player
  // signs at most ONE proposalApprove. No more "Refund error: Load failed".
  const handleCancelRefund = useCallback(async () => {
    if (!publicKey || !battle) return;
    if (!window.confirm('Cancel this battle? Your SOL will be refunded minus gas.')) return;

    setCancelling(true);
    showToast('Requesting refund...');
    const refundUrl = `${COSIGNER_API_URL}/battle/${battle.id}/refund-server`;
    const multisigPda = deriveMultisigPda(battle.createKey);

    try {
      // Round 1: server builds refund proposal + platform-approves (1 of 2).
      let res = await fetch(refundUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestor: publicKey.toBase58() }),
      });
      let data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refund failed');

      if (data.executed || data.alreadyResolved || data.refunded === 0) {
        clearBattle();
        showToast('Refunded!');
        return;
      }

      if (data.needsApproval) {
        // Player provides the 2nd approval — single reliable signature.
        showToast('Approve refund in your wallet...');
        const approveTx = await buildProposalApprove({
          connection, multisigPda,
          transactionIndex: data.transactionIndex, member: publicKey,
        });
        const sig = await sendTransaction(approveTx, connection);
        await confirmSignature(connection, sig);

        // Round 2: server executes once it sees 2-of-2.
        showToast('Releasing your SOL...');
        res = await fetch(refundUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestor: publicKey.toBase58() }),
        });
        data = await res.json();
        if (!res.ok || !data.executed) throw new Error(data.error || 'Execute failed');
        clearBattle();
        showToast('Refunded!');
        return;
      }

      throw new Error('Unexpected refund response');
    } catch (e) {
      console.error(e);
      const msg = e.message?.includes('rejected') ? 'Cancelled.'
        : e.message?.includes('gas') ? 'Platform low on gas — pinged the team, try again shortly.'
        : `Refund error: ${e.message?.slice(0, 80)}`;
      showToast(msg);
    } finally {
      setCancelling(false);
    }
  }, [publicKey, battle, connection, sendTransaction, clearBattle, showToast]);

  // ── COPY SHARE LINK ───────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    if (!battle?.shareUrl) return;
    navigator.clipboard.writeText(battle.shareUrl).then(() => showToast('Link copied!'));
  }, [battle, showToast]);

  const stakeOptions = isDegenMode ? [...STAKE_OPTIONS, DEGEN_STAKE] : STAKE_OPTIONS;
  const totalPot = parseFloat(selectedStake) * 2;
  const feeAmt = calcFeeAmountSol(totalPot, feeInfo.feeBps);
  const winnerAmt = calcWinnerAmountSol(totalPot, feeInfo.feeBps);

  // ── FUNDED STATE — waiting for opponent ───────────────────────────────────
  if (battle && battle.status === 'FUNDED' && battle.player1 === publicKey?.toBase58()) {
    return (
      <div>
        <h2>ENTER THE WAR</h2>
        <p className="sub">WAITING FOR OPPONENT</p>

        {/* Device switch warning */}
        {!warningDismissed && (
          <div style={{
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            borderRadius: '8px',
            padding: '10px 14px',
            marginBottom: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}>
            <span style={{ color: '#92400e', fontSize: '0.8rem', fontFamily: 'sans-serif', lineHeight: '1.4' }}>
              ⚠️ DO NOT SWITCH DEVICES — Battle state is tied to this browser. Switching devices may prevent settlement.
            </span>
            <button
              onClick={() => setWarningDismissed(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: '1rem', padding: '0 4px', flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        )}

        <div className="lobby-state active">
          <p style={{ color: '#aaa', marginBottom: '8px', fontSize: '0.95rem', fontFamily: 'sans-serif' }}>
            Share this link with your opponent
          </p>
          <div className="share-link">{battle.shareUrl}</div>
          <button className="copy-btn" onClick={handleCopy}>COPY LINK</button>
          <br /><br />
          <div className="lobby-code">{truncateAddress(battle.id, 6)}</div>
          <p className="waiting-text">WAITING FOR OPPONENT...</p>
          <p style={{ color: '#555', fontSize: '0.85rem', fontFamily: 'sans-serif', margin: '8px 0' }}>
            Stake: {battle.stake} SOL · Duration: {battle.durationLabel} · Fee: {toFeePercent(battle.feeBps)}
          </p>
          <button
            className="action-btn"
            style={{ marginTop: '16px', background: '#1a1a1a', border: '1px solid #333', fontSize: '1rem' }}
            onClick={handleCancel}
          >
            CANCEL
          </button>
          <button
            className="action-btn"
            style={{ marginTop: '8px', background: '#1a0000', border: '1px solid #7f1d1d', fontSize: '0.95rem', color: '#fca5a5' }}
            onClick={handleCancelRefund}
            disabled={cancelling}
          >
            {cancelling ? <><span className="spinner" />CANCELLING...</> : 'CANCEL & REFUND'}
          </button>
        </div>

        <div className="stats-row">
          <div className="stat-tile"><div className="val">0</div><div className="lbl">WARS WON</div></div>
          <div className="stat-tile"><div className="val">0</div><div className="lbl">SOL EARNED</div></div>
          <div className="stat-tile"><div className="val">—</div><div className="lbl">WIN RATE</div></div>
        </div>
      </div>
    );
  }

  // ── OPEN STATE — deposit needed ───────────────────────────────────────────
  if (battle && battle.status === 'OPEN' && battle.player1 === publicKey?.toBase58()) {
    return (
      <div>
        <h2>ENTER THE WAR</h2>
        <p className="sub">DEPOSIT TO LOCK IT IN</p>

        <div style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
          <p style={{ color: '#aaa', fontSize: '0.9rem', fontFamily: 'sans-serif', marginBottom: '8px' }}>
            Battle created on-chain. Deposit your {battle.stake} SOL to the Squads vault to activate it.
          </p>
          <p style={{ color: '#555', fontSize: '0.8rem', fontFamily: 'monospace' }}>
            Vault: {truncateAddress(battle.vaultAddress, 6)}
          </p>
        </div>

        <div className={`fee-badge${feeInfo.isHolder ? ' discounted' : ''}`}>
          PLATFORM FEE: {toFeePercent(battle.feeBps)}
          {feeInfo.isHolder && ` (${feeInfo.collectionName} holder discount)`}
        </div>

        <button
          className="action-btn"
          onClick={handleDeposit}
          disabled={depositing}
        >
          {depositing ? <><span className="spinner" />DEPOSITING...</> : `DEPOSIT ${battle.stake} SOL`}
        </button>

        <button
          className="action-btn"
          style={{ marginTop: '10px', background: '#1a1a1a', border: '1px solid #333', fontSize: '1rem' }}
          onClick={handleCancel}
        >
          CANCEL
        </button>
      </div>
    );
  }

  // ── DEFAULT — create new battle ───────────────────────────────────────────
  return (
    <div>
      <h2>ENTER THE WAR</h2>
      <p className="sub">CHOOSE YOUR STAKE</p>

      <div className="stake-row">
        {stakeOptions.map(opt => (
          <button
            key={opt}
            className={`stake-btn${selectedStake === opt ? ' selected' : ''}`}
            onClick={() => setSelectedStake(opt)}
          >
            {opt} SOL{opt === DEGEN_STAKE ? ' 🔥' : ''}
          </button>
        ))}
      </div>

      <p style={{ color: '#666', fontSize: '0.9rem', letterSpacing: '1px', margin: '6px 0 4px' }}>
        BATTLE DURATION
      </p>
      <div className="duration-row">
        {Object.keys(BATTLE_DURATIONS).map(dur => (
          <button
            key={dur}
            className={`dur-btn${selectedDuration === dur ? ' selected' : ''}`}
            onClick={() => setSelectedDuration(dur)}
          >
            {dur.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="degen-toggle">
        <span>DEGEN MODE</span>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={isDegenMode}
            onChange={e => setIsDegenMode(e.target.checked)}
          />
          <span className="slider" />
        </label>
        <span style={{ color: '#9333ea', fontSize: '0.95rem' }}>MAX RISK</span>
      </div>

      {/* Fee display */}
      <div className={`fee-badge${feeInfo.isHolder ? ' discounted' : ''}`}>
        FEE: {toFeePercent(feeInfo.feeBps)} · Winner gets {winnerAmt.toFixed(3)} SOL
        {feeInfo.isHolder && ` (${feeInfo.collectionName} discount)`}
      </div>

      <div id="find-state">
        <button
          className="action-btn"
          onClick={handleCreateBattle}
          disabled={creating}
        >
          {creating ? <><span className="spinner" />CREATING BATTLE...</> : 'CREATE BATTLE'}
        </button>
      </div>

      <div className="stats-row">
        <div className="stat-tile"><div className="val">0</div><div className="lbl">WARS WON</div></div>
        <div className="stat-tile"><div className="val">0</div><div className="lbl">SOL EARNED</div></div>
        <div className="stat-tile"><div className="val">—</div><div className="lbl">WIN RATE</div></div>
      </div>
    </div>
  );
}
