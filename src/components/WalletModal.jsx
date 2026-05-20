import { useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useApp } from '../context/AppContext';

const WALLET_LOGOS = {
  Phantom: 'https://www.phantom.app/img/phantom-logo.png',
  Backpack: 'https://avatars.githubusercontent.com/u/97634650',
  Solflare: 'https://solflare.com/favicon.ico',
};

export function WalletModal() {
  const { showWalletModal, setShowWalletModal, showToast } = useApp();
  const { wallets, select } = useWallet();

  const handleConnect = useCallback((walletName) => {
    try {
      select(walletName);
      setShowWalletModal(false);
      showToast(`Connecting to ${walletName}...`);
    } catch (e) {
      showToast('Connection failed. Try opening in your wallet browser.');
    }
  }, [select, setShowWalletModal, showToast]);

  if (!showWalletModal) return null;

  const TARGET = new Set(['Phantom', 'Solflare', 'Backpack']);
  const targetWallets = wallets.filter(w => TARGET.has(w.adapter.name));

  // On mobile, wallets are Loadable (deep link) not Installed (extension)
  // Allow connecting to both Installed and Loadable
  const canConnect = (readyState) =>
    readyState === WalletReadyState.Installed ||
    readyState === WalletReadyState.Loadable;

  const available = targetWallets.filter(w => canConnect(w.readyState));
  const unavailable = targetWallets.filter(w => !canConnect(w.readyState));
  const ordered = [...available, ...unavailable];

  return (
    <div className="modal-bg active" onClick={e => e.target === e.currentTarget && setShowWalletModal(false)}>
      <div className="modal">
        <button className="modal-close" onClick={() => setShowWalletModal(false)}>✕</button>
        <h2>CONNECT WALLET</h2>
        <p>Choose your weapon</p>

        {ordered.map(({ adapter, readyState }) => {
          const enabled = canConnect(readyState);
          return (
            <button
              key={adapter.name}
              className="wallet-btn"
              onClick={() => enabled && handleConnect(adapter.name)}
              disabled={!enabled}
              title={enabled ? '' : `Install ${adapter.name} first`}
            >
              <img
                src={WALLET_LOGOS[adapter.name] || adapter.icon}
                onError={e => (e.target.style.display = 'none')}
                alt=""
              />
              {adapter.name.toUpperCase()}
              {!enabled && <span className="not-installed">NOT AVAILABLE</span>}
            </button>
          );
        })}

        <p style={{ color: '#444', fontSize: '0.85rem', marginTop: '16px', fontFamily: 'sans-serif' }}>
          Connecting to Solana mainnet
        </p>
      </div>
    </div>
  );
}
