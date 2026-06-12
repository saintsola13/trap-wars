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
  const { wallets, select, connect, wallet } = useWallet();

  const handleConnect = useCallback(async (walletName) => {
    showToast(`Connecting to ${walletName}...`);
    try {
      // 1. Select the adapter.
      select(walletName);
      setShowWalletModal(false);

      // 2. Explicitly connect. autoConnect alone silently stalls inside wallet
      //    in-app browsers (Solflare/Phantom) when the injected provider isn't
      //    ready at the exact tick after select(). We retry connect() until the
      //    adapter for this wallet is selected, then call it directly.
      const target = wallets.find((w) => w.adapter.name === walletName);
      const adapter = target?.adapter;
      if (!adapter) return;

      // Wait briefly for select() to register the adapter, then connect.
      const tryConnect = async () => {
        if (adapter.connected) return;
        try {
          await adapter.connect();
        } catch (err) {
          // 4001 = user rejected; anything else is a real failure we surface.
          if (String(err?.message || '').toLowerCase().includes('reject')) {
            showToast('Connection cancelled.');
          } else {
            throw err;
          }
        }
      };

      // Give the adapter a moment to be ready, then connect with a timeout guard.
      await new Promise((r) => setTimeout(r, 150));
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('connect-timeout')), 12000)
      );
      await Promise.race([tryConnect(), timeout]);
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('connect-timeout')) {
        showToast('Wallet did not respond. Reopen this link inside your wallet browser and retry.');
      } else {
        showToast('Connection failed. Open trapwars.win inside your wallet app browser.');
      }
    }
  }, [select, connect, wallets, setShowWalletModal, showToast]);

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
