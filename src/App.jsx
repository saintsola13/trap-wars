import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useApp } from './context/AppContext';
import { autoConnectInjected } from './lib/autoconnect';
import { COSIGNER_API_URL } from './lib/constants';
import { Landing } from './components/Landing';
import { WarRoom } from './components/WarRoom';
import { WalletModal } from './components/WalletModal';
import { DegenModal } from './components/DegenModal';
import { JoinPanel } from './components/JoinPanel';
import { Toast } from './components/Toast';

export function App() {
  const { connected, publicKey } = useWallet();
  const { showToast, setShowWalletModal } = useApp();
  const [joinBattleId, setJoinBattleId] = useState(null);

  // ?recover=battleId — restore lost battle state from server (e.g. localStorage cleared)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const recoverId = params.get('recover');
    if (!recoverId) return;
    fetch(`${COSIGNER_API_URL}/battle/${recoverId}`)
      .then(r => r.json())
      .then(data => {
        if (!data.id) return;
        const battle = {
          id: data.id,
          createKey: data.create_key,
          vaultAddress: data.vault_address,
          player1: data.player1,
          player2: data.player2,
          stake: data.stake,
          status: data.status,
          startTime: data.start_time,
          endTime: data.end_time,
          feeBps: data.fee_bps,
          durationLabel: data.duration_label,
          shareUrl: data.share_url,
          player1InitialUsd: data.player1_initial_usd,
          player2InitialUsd: data.player2_initial_usd,
          player1Snapshot: data.player1_snapshot,
          player2Snapshot: data.player2_snapshot,
        };
        localStorage.setItem('trapwars_battle_v2', JSON.stringify(battle));
        window.history.replaceState({}, '', window.location.pathname);
        window.location.reload();
      })
      .catch(() => {});
  }, []);

  // Check for ?battle=... in URL (Player 2 flow)
  // Persists to BOTH sessionStorage AND localStorage — mobile wallets (Phantom deep-link)
  // can wipe sessionStorage on redirect; localStorage survives.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const battleId = params.get('battle');
    if (battleId) {
      setJoinBattleId(battleId);
      sessionStorage.setItem('trapwars_pending_join', window.location.search);
      localStorage.setItem('trapwars_pending_join', window.location.search);
    } else {
      // Fallback: try sessionStorage first, then localStorage
      const pending =
        sessionStorage.getItem('trapwars_pending_join') ||
        localStorage.getItem('trapwars_pending_join');
      if (pending) {
        const savedParams = new URLSearchParams(pending);
        const savedBattleId = savedParams.get('battle');
        if (savedBattleId) {
          setJoinBattleId(savedBattleId);
          window.history.replaceState({}, '', `${window.location.pathname}${pending}`);
        }
      }
    }
  }, []);

  // When wallet connects and there's a pending join in storage (handles post-redirect case
  // where joinBattleId may not yet be set when connected flips to true)
  useEffect(() => {
    if (connected && !joinBattleId) {
      const pending =
        sessionStorage.getItem('trapwars_pending_join') ||
        localStorage.getItem('trapwars_pending_join');
      if (pending) {
        const savedParams = new URLSearchParams(pending);
        const savedBattleId = savedParams.get('battle');
        if (savedBattleId) {
          setJoinBattleId(savedBattleId);
          window.history.replaceState({}, '', `${window.location.pathname}${pending}`);
        }
      }
    }
  }, [connected]); // eslint-disable-line

  const { wallets, select } = useWallet();

  // Auto-open wallet modal when join link detected and wallet not yet connected.
  // BUT: if we're already inside a wallet's in-app browser (Solflare/Phantom),
  // connect directly to the injected provider instead of forcing a manual tap
  // that dead-ends on a blank connect screen.
  useEffect(() => {
    if (!joinBattleId || connected) return;
    let cancelled = false;
    (async () => {
      const did = await autoConnectInjected({ wallets, select, showToast });
      if (!did && !cancelled) setShowWalletModal(true);
    })();
    return () => { cancelled = true; };
  }, [joinBattleId]); // eslint-disable-line

  // When wallet connects, show war room and toast
  useEffect(() => {
    if (connected && publicKey) {
      showToast(`Connected: ${publicKey.toBase58().slice(0,4)}...${publicKey.toBase58().slice(-4)}`);
    }
  }, [connected, publicKey]); // eslint-disable-line

  // Manage body scroll lock when war room is open
  useEffect(() => {
    document.body.style.overflow = connected ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [connected]);

  const handleJoinClose = () => {
    setJoinBattleId(null);
    sessionStorage.removeItem('trapwars_pending_join');
    localStorage.removeItem('trapwars_pending_join');
    window.history.replaceState({}, '', window.location.pathname);
  };

  return (
    <>
      {!connected && <Landing />}
      {connected && <WarRoom />}

      <WalletModal />
      <DegenModal />
      <Toast />

      {/* Player 2 join flow */}
      {joinBattleId && connected && (
        <JoinPanel battleId={joinBattleId} onClose={handleJoinClose} />
      )}
      {joinBattleId && !connected && (
        // Wallet modal opens automatically; this backdrop shows while they connect
        <div className="modal-bg active">
          <div className="modal">
            <h2>JOIN BATTLE</h2>
            <p>Connect your wallet to join this battle.</p>
            <button
              className="action-btn"
              onClick={() => setShowWalletModal(true)}
            >
              CONNECT WALLET
            </button>
          </div>
        </div>
      )}
    </>
  );
}
