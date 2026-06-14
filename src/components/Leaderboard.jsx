import { useState, useEffect } from 'react';
import { COSIGNER_API_URL } from '../lib/constants';

export function Leaderboard() {
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

  return (
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
  );
}
