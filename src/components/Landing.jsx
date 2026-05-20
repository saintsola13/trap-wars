import { useApp } from '../context/AppContext';

export function Landing() {
  const { setShowWalletModal, setShowDegenModal } = useApp();

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
              <tr><td colSpan="4" style={{textAlign:'center',color:'#444',padding:'32px',fontFamily:'VT323, monospace',fontSize:'1.2rem',letterSpacing:'2px'}}>NO BATTLES YET. BE THE FIRST.</td></tr>
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
