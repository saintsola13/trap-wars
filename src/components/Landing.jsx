import { useApp } from '../context/AppContext';

export function Landing() {
  const { setShowWalletModal, setShowDegenModal } = useApp();

  const scrollTo = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

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
              <tr><td className="rank-1">1</td><td>7xKp...3mNq</td><td>14</td><td>18.4 SOL</td></tr>
              <tr><td className="rank-2">2</td><td>Bb9R...kW2z</td><td>11</td><td>12.1 SOL</td></tr>
              <tr><td className="rank-3">3</td><td>5hJx...9pLm</td><td>9</td><td>9.5 SOL</td></tr>
              <tr><td>4</td><td>Qz2F...vT8n</td><td>7</td><td>6.8 SOL</td></tr>
              <tr><td>5</td><td>Yw4A...rN1c</td><td>5</td><td>4.2 SOL</td></tr>
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
