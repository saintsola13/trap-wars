import { useState, useEffect, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useApp } from '../context/AppContext';
import { PLATFORM_WALLET, BATTLE_DURATIONS } from '../lib/constants';
import { buildDepositTransaction, getVaultBalance, deriveVaultPda } from '../lib/squads';
import { getFeeInfo } from '../lib/nft';
import { toFeePercent, truncateAddress } from '../lib/fees';
import { snapshotPortfolio } from '../lib/jupiter';

// Shown when Player 2 opens a shareable battle link
export function JoinPanel({ battleId, onClose }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { showToast, setBattle } = useApp();

  const [battleMeta, setBattleMeta] = useState(null);
  const [vaultBalance, setVaultBalance] = useState(null);
  const [feeInfo, setFeeInfo] = useState({ feeBps: 300, isHolder: false });
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Same-device: try localStorage first
    const stored = localStorage.getItem('trapwars_battle_v2');
    if (stored) {
      try {
        const b = JSON.parse(stored);
        if (b.id === battleId) {
          setBattleMeta(b);
          return;
        }
      } catch {}
    }

    // Cross-device: reconstruct from URL params encoded in share link
    const params = new URLSearchParams(window.location.search);
    const stake = parseFloat(params.get('stake'));
    const durLabel = params.get('dur');
    const player1 = params.get('p1');

    if (stake > 0 && durLabel && BATTLE_DURATIONS[durLabel] && player1) {
      try {
        const multisigPda = new PublicKey(battleId);
        const vaultPda = deriveVaultPda(multisigPda);
        setBattleMeta({
          id: battleId,
          vaultAddress: vaultPda.toBase58(),
          player1,
          stake,
          duration: BATTLE_DURATIONS[durLabel],
          durationLabel: durLabel,
          feeBps: 300,
          status: 'FUNDED',
        });
        return;
      } catch {}
    }

    setError('Could not load battle data. Ask Player 1 to reshare the link.');
  }, [battleId]);

  useEffect(() => {
    if (!battleMeta?.vaultAddress) return;
    getVaultBalance(connection, battleMeta.vaultAddress)
      .then(setVaultBalance)
      .catch(() => setVaultBalance(null));
  }, [connection, battleMeta]);

  useEffect(() => {
    if (!publicKey) return;
    getFeeInfo(connection, publicKey).then(setFeeInfo).catch(() => {});
  }, [connection, publicKey]);

  const handleJoin = useCallback(async () => {
    if (!publicKey || !battleMeta) return;
    if (publicKey.toBase58() === battleMeta.player1) {
      showToast("That's your own battle!");
      return;
    }

    setJoining(true);
    showToast('Joining battle...');

    try {
      const vaultPda = new PublicKey(battleMeta.vaultAddress);
      const tx = await buildDepositTransaction({
        connection,
        player: publicKey,
        vaultPda,
        amountSol: battleMeta.stake,
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');

      const [p2Snapshot, p1Snapshot] = await Promise.all([
        snapshotPortfolio(connection, publicKey),
        snapshotPortfolio(connection, new PublicKey(battleMeta.player1)),
      ]);

      const now = Date.now();
      const endTime = now + battleMeta.duration * 1000;

      const updatedBattle = {
        ...battleMeta,
        player2: publicKey.toBase58(),
        player2Snapshot: p2Snapshot,
        player1Snapshot: p1Snapshot,
        status: 'ACTIVE',
        startTime: now,
        endTime,
        player2DepositSig: sig,
        feeBps: Math.min(feeInfo.feeBps, battleMeta.feeBps), // use best rate between both players
      };

      setBattle(updatedBattle);
      showToast(`Joined! Battle ends in ${battleMeta.durationLabel}.`);
      onClose();
    } catch (e) {
      console.error(e);
      showToast(e.message?.includes('rejected') ? 'Deposit rejected.' : 'Failed to join battle.');
    } finally {
      setJoining(false);
    }
  }, [publicKey, connection, sendTransaction, battleMeta, feeInfo, setBattle, showToast, onClose]);

  if (error) {
    return (
      <div className="modal-bg active" onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <button className="modal-close" onClick={onClose}>✕</button>
          <h2>JOIN BATTLE</h2>
          <p style={{ color: '#f87171' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!battleMeta) {
    return (
      <div className="modal-bg active">
        <div className="modal">
          <p style={{ color: '#aaa' }}>Loading battle...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-bg active" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>JOIN BATTLE</h2>
        <p>Opponent is ready. Put up your SOL.</p>

        <div style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: '10px', padding: '16px', marginBottom: '16px', textAlign: 'left' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>OPPONENT</span>
            <span style={{ color: '#aaa', fontFamily: 'monospace', fontSize: '0.9rem' }}>{truncateAddress(battleMeta.player1)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>STAKE</span>
            <span style={{ color: '#fff' }}>{battleMeta.stake} SOL each</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>DURATION</span>
            <span style={{ color: '#fff' }}>{battleMeta.durationLabel}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>VAULT BALANCE</span>
            <span style={{ color: '#4ade80' }}>
              {vaultBalance !== null ? `${vaultBalance.toFixed(3)} SOL` : 'Loading...'}
            </span>
          </div>
        </div>

        <div className={`fee-badge${feeInfo.isHolder ? ' discounted' : ''}`}>
          PLATFORM FEE: {toFeePercent(feeInfo.feeBps)}
          {feeInfo.isHolder && ` (${feeInfo.collectionName} holder discount)`}
        </div>

        <button
          className="action-btn"
          onClick={handleJoin}
          disabled={joining || !publicKey}
        >
          {joining
            ? <><span className="spinner" />JOINING...</>
            : `DEPOSIT ${battleMeta.stake} SOL & JOIN`}
        </button>
      </div>
    </div>
  );
}
