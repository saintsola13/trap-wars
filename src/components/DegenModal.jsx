import { useApp } from '../context/AppContext';

export function DegenModal() {
  const { showDegenModal, setShowDegenModal, setIsDegenMode, showWalletModal, setShowWalletModal, showToast } = useApp();

  const handleEnable = () => {
    setIsDegenMode(true);
    setShowDegenModal(false);
    showToast('Degen Mode enabled. No mercy.');
    if (!showWalletModal) setShowWalletModal(true);
  };

  if (!showDegenModal) return null;

  return (
    <div className="modal-bg active" onClick={e => e.target === e.currentTarget && setShowDegenModal(false)}>
      <div className="modal">
        <button className="modal-close" onClick={() => setShowDegenModal(false)}>✕</button>
        <h2>⚠️ DEGEN MODE</h2>
        <p>
          Max stake: <strong style={{ color: '#ffd700' }}>5 SOL</strong>. No safety net. No mercy.
          For those who don't play it safe.
        </p>
        <div style={{ background: '#1a0a0a', border: '1px solid #ff3a00', borderRadius: '10px', padding: '14px', marginBottom: '20px' }}>
          <p style={{ color: '#ff6b6b', fontSize: '0.9rem', fontFamily: 'sans-serif' }}>
            ⚠️ This mode is for experienced degens only. You can lose it all.
          </p>
        </div>
        <button className="action-btn" style={{ background: '#ff3a00' }} onClick={handleEnable}>
          I UNDERSTAND. ENTER DEGEN MODE
        </button>
      </div>
    </div>
  );
}
