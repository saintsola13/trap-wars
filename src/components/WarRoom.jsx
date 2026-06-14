import { useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useApp } from '../context/AppContext';
import { BattlePanel } from './BattlePanel';
import { ActiveBattle } from './ActiveBattle';
import { Leaderboard } from './Leaderboard';
import { truncateAddress } from '../lib/fees';

export function WarRoom() {
  const { publicKey, disconnect } = useWallet();
  const { battle, clearBattle, showToast } = useApp();

  const handleDisconnect = useCallback(async () => {
    if (!confirm('Disconnect wallet?')) return;
    await disconnect();
    clearBattle();
  }, [disconnect, clearBattle]);

  const addr = publicKey ? truncateAddress(publicKey.toBase58()) : '';
  const isActiveBattle = battle && ['ACTIVE', 'SETTLED'].includes(battle?.status);

  return (
    <div id="warroom" className="active fade-in">
      <div className="wr-bg" />
      <div className="wr-overlay" />
      <div className="wr-content">
        <div className="wr-nav">
          <div className="wr-logo">TRAP WARS</div>
          <div className="wr-wallet" onClick={handleDisconnect}>
            {addr} ▾
          </div>
        </div>
        <div className="wr-body">
          <div className="wr-panel">
            {isActiveBattle ? <ActiveBattle /> : <BattlePanel />}
          </div>
        </div>
        <div className="wr-leaderboard">
          <Leaderboard />
        </div>
      </div>
    </div>
  );
}
