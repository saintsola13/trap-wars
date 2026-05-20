import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useApp } from './context/AppContext';
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

  // Check for ?battle=... in URL (Player 2 flow)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const battleId = params.get('battle');
    if (battleId) setJoinBattleId(battleId);
  }, []);

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

  // If Player 2 clicks a join link and isn't connected yet, open wallet modal
  const handleJoinClose = () => {
    setJoinBattleId(null);
    // Clean URL
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
        // Prompt connection first, then join
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
