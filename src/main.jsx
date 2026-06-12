import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { SOLANA_RPC_URL } from './lib/constants';
import { AppProvider } from './context/AppContext';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// Backpack may expose itself via the standard wallet-adapter detection
// PhantomWalletAdapter and SolflareWalletAdapter cover the main user base
function Root() {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    []
  );

  return (
    <ErrorBoundary>
      <ConnectionProvider endpoint={SOLANA_RPC_URL}>
        <WalletProvider wallets={wallets} autoConnect>
          <AppProvider>
            <App />
          </AppProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
