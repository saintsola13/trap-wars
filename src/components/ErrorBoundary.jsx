import { Component } from 'react';

// Catches render crashes so the app never shows a blank/black screen.
// Gives the user a way out (reload / clear battle) instead of being stuck.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: String(error?.message || error || 'Unknown error') };
  }

  componentDidCatch(error, info) {
    // Surface to console for debugging; never crash silently.
    console.error('Trap Wars render error:', error, info);
  }

  handleReset = () => {
    try { localStorage.removeItem('trapwars_battle_v2'); } catch {}
    window.location.href = window.location.origin;
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '16px',
        background: '#0a0a0f', color: '#fff', fontFamily: 'sans-serif', padding: '24px', textAlign: 'center',
      }}>
        <h2 style={{ margin: 0, color: '#ffd700' }}>Something glitched</h2>
        <p style={{ color: '#aaa', maxWidth: 360, margin: 0 }}>
          The battle screen hit an error. Your funds are safe on-chain. Reload to continue.
        </p>
        <p style={{ color: '#444', fontSize: '0.75rem', maxWidth: 360, wordBreak: 'break-word' }}>
          {this.state.message}
        </p>
        <button
          onClick={this.handleReset}
          style={{
            background: '#ffd700', color: '#000', border: 0, borderRadius: 12,
            padding: '14px 28px', fontWeight: 700, fontSize: 15, cursor: 'pointer',
          }}
        >
          RELOAD
        </button>
      </div>
    );
  }
}
