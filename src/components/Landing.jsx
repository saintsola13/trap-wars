import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { COSIGNER_API_URL } from '../lib/constants';

export function Landing() {
  const { setShowWalletModal, setShowDegenModal } = useApp();
  const [leaders, setLeaders] = useState([]);
  const [bigWins, setBigWins] = useState([]);

  useEffect(() => {
    fetch(`${COSIGNER_API_URL}/leaderboard`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setLeaders(data); })
      .catch(() => {});
    fetch(`${COSIGNER_API_URL}/leaderboard/bigwin`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setBigWins(data); })
      .catch(() => {});
  }, []);

  const scrollTo = id => {
    const el = document.getElementById(id);
    if (!el) return;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY, behavior: 'smooth' });
  };

  return (
    <div id="landing">
      <div className="hero">
        <img className="bg" src="/trap-wars-hero.jpg" alt="Trap Wars" draggable="false" />
        <div className="overlay">
          <div className="btn-overlay btn-how"         onClick={() => scrollTo('how-it-works')} />
          <div className="btn-overlay btn-leaderboard" onClick={() => scrollTo('leaderboard')} />
          <div className="btn-overlay btn-enter-nav"   onClick={() => setShowWalletModal(true)} />
          <div className="btn-overlay btn-connect"     onClick={() => setShowWalletModal(true)} />
          <div className="btn-overlay btn-pvp"         onClick={() => setShowWalletModal(true)} />
          <div className="btn-overlay btn-winbig"      onClick={() => scrollTo('leaderboard')} />
          <div className="btn-overlay btn-nomercy"     onClick={() => scrollTo('how-it-works')} />
          <div className="btn-overlay btn-degen"       onClick={() => setShowDegenModal(true)} />
        </div>
      </div>

      <div className="sections">
        <div id="how-it-works">
          <h2>HOW IT WORKS</h2>
          <div className="steps">
            <div className="step">
              <div className="step-num">1</div>
              <h3>Connect Wallet</h3>
              <p>Link your Phantom, Backpack, or Solflare wallet. No account needed. No rats allowed.</p>
            </div>
            <div className="step">
              <div className="step-num">2</div>
              <h3>Enter The War</h3>
              <p>Pick your stake, find an opponent. Prize locks in Squads Protocol escrow. Timer starts.</p>
            </div>
            <div className="step">
              <div className="step-num">3</div>
              <h3>Best Trader Wins</h3>
              <p>When time's up, P&L gets compared via Jupiter. The better trader takes the whole pot. Game recognize game.</p>
            </div>
          </div>
        </div>

        <div id="leaderboard">
          <h2>LEADERBOARD</h2>
          <table>
            <thead>
              <tr>
                <th>#</th><th>WALLET</th><th>WARS WON</th><th>TOTAL EARNED</th>
              </tr>
            </thead>
            <tbody>
              {leaders.length === 0 ? (
                <tr><td colSpan="4" style={{textAlign:'center',color:'#444',padding:'32px',fontFamily:'VT323, monospace',fontSize:'1.2rem',letterSpacing:'2px'}}>NO BATTLES YET. BE THE FIRST.</td></tr>
              ) : leaders.map((row, i) => (
                <tr key={row.wallet}>
                  <td>{i + 1}</td>
                  <td style={{fontFamily:'monospace',fontSize:'0.85rem'}}>{row.wallet.slice(0,4)}...{row.wallet.slice(-4)}</td>
                  <td>{row.wins}</td>
                  <td style={{color:'#4ade80'}}>{row.total_earned.toFixed(3)} SOL</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ marginTop: '40px' }}>🔥 BIGGEST WIN TODAY</h2>
          <table>
            <thead>
              <tr>
                <th>#</th><th>WALLET</th><th>P&amp;L</th><th>EARNED</th>
              </tr>
            </thead>
            <tbody>
              {bigWins.length === 0 ? (
                <tr><td colSpan="4" style={{textAlign:'center',color:'#444',padding:'32px',fontFamily:'VT323, monospace',fontSize:'1.2rem',letterSpacing:'2px'}}>NO WINS YET TODAY. GET IN.</td></tr>
              ) : bigWins.map((row, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td style={{fontFamily:'monospace',fontSize:'0.85rem'}}>{row.wallet.slice(0,4)}...{row.wallet.slice(-4)}</td>
                  <td style={{color: row.win_pct >= 0 ? '#4ade80' : '#f87171'}}>
                    {row.win_pct != null ? `${row.win_pct >= 0 ? '+' : ''}${(row.win_pct * 100).toFixed(2)}%` : '-'}
                  </td>
                  <td style={{color:'#ffd700'}}>{row.earned.toFixed(3)} SOL</td>

                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="footer-links">
        <a href="/whitepaper.html" target="_blank" rel="noopener noreferrer">WHITEPAPER</a>
        <span>|</span>
        <span>LOYALTY OVER EVERYTHING</span>
      </div>
    </div>
  );
}
