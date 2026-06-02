import { useState, useEffect, useCallback, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useApp } from '../context/AppContext';
import { TREASURY_WALLET, PLATFORM_WALLET, COSIGNER_API_URL } from '../lib/constants';
import {
  getTokenPrices,
  evaluatePortfolio,
  calcPercentChange,
  collectMints,
} from '../lib/jupiter';
import {
  buildSettlementProposal,
  buildProposalCreate,
  buildProposalApprove,
  buildVaultExecute,
  deriveMultisigPda,
} from '../lib/squads';
import { toLamports, calcFeeAmountSol, calcWinnerAmountSol, toFeePercent, truncateAddress } from '../lib/fees';

const REFRESH_INTERVAL_MS = 30_000;

export function ActiveBattle() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { battle, setBattle, clearBattle, showToast } = useApp();

  const [p1ValueUsd, setP1ValueUsd] = useState(null);
  const [p2ValueUsd, setP2ValueUsd] = useState(null);
  const [p1Score, setP1Score] = useState(null);
  const [p2Score, setP2Score] = useState(null);
  const [timeLeft, setTimeLeft] = useState(null);
  const [settling, setSettling] = useState(false);
  const [settled, setSettled] = useState(battle?.status === 'SETTLED');
  const [warningDismissed, setWarningDismissed] = useState(false);

  const p1InitialRef = useRef(null);
  const p2InitialRef = useRef(null);

  // Seed initial refs from stored initialUsd (fair baseline computed at join time)
  useEffect(() => {
    if (battle?.player1InitialUsd && p1InitialRef.current === null) {
      p1InitialRef.current = battle.player1InitialUsd;
    }
    if (battle?.player2InitialUsd && p2InitialRef.current === null) {
      p2InitialRef.current = battle.player2InitialUsd;
    }
  }, [battle?.player1InitialUsd, battle?.player2InitialUsd]);

  // Price refresh
  const refreshPrices = useCallback(async () => {
    if (!battle?.player1Snapshot || !battle?.player2Snapshot) return;

    const mints = collectMints(battle.player1Snapshot, battle.player2Snapshot);
    const prices = await getTokenPrices(mints).catch(() => ({}));
    if (!Object.keys(prices).length) return;

    const [p1Now, p2Now] = await Promise.all([
      evaluatePortfolio(battle.player1Snapshot, prices),
      evaluatePortfolio(battle.player2Snapshot, prices),
    ]);

    // Fall back to current prices if no stored initial value
    if (p1InitialRef.current === null) {
      p1InitialRef.current = battle.player1InitialUsd || await evaluatePortfolio(battle.player1Snapshot, prices);
    }
    if (p2InitialRef.current === null) {
      p2InitialRef.current = battle.player2InitialUsd || await evaluatePortfolio(battle.player2Snapshot, prices);
    }

    setP1ValueUsd(p1Now);
    setP2ValueUsd(p2Now);
    setP1Score(calcPercentChange(p1InitialRef.current, p1Now));
    setP2Score(calcPercentChange(p2InitialRef.current, p2Now));
  }, [battle]);

  useEffect(() => {
    if (battle?.status !== 'ACTIVE') return;
    refreshPrices();
    const interval = setInterval(refreshPrices, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [battle?.status, refreshPrices]);

  // Countdown timer
  useEffect(() => {
    if (!battle?.endTime) return;
    const tick = () => {
      const remaining = Math.max(0, battle.endTime - Date.now());
      setTimeLeft(remaining);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [battle?.endTime]);

  // Settlement - Phase 3: 2-of-2 multisig flow
  const handleSettle = useCallback(async () => {
    if (!publicKey || !battle) return;
    if (p1Score === null || p2Score === null) {
      showToast('Price data not ready. Try again in a moment.');
      return;
    }

    setSettling(true);
    const winner = p1Score >= p2Score ? battle.player1 : battle.player2;
    const loser = winner === battle.player1 ? battle.player2 : battle.player1;
    const totalPot = battle.stake * 2;
    const feeLamports = toLamports(calcFeeAmountSol(totalPot, battle.feeBps));
    const winnerLamports = toLamports(totalPot) - feeLamports;
    const multisigPda = deriveMultisigPda(battle.createKey);
    const TX_INDEX = 1;

    try {
      // Step 1: Create vault transaction (payout proposal)
      showToast('Step 1/4: Proposing settlement...');
      const proposalTx = await buildSettlementProposal({
        connection,
        multisigPda,
        transactionIndex: TX_INDEX,
        proposer: publicKey,
        winnerPubkey: winner,
        treasuryPubkey: TREASURY_WALLET,
        winnerLamports,
        feeLamports,
      });
      const proposalSig = await sendTransaction(proposalTx, connection);
      await connection.confirmTransaction(proposalSig, 'confirmed');

      // Step 2: Create proposal (make it voteable)
      showToast('Step 2/4: Creating proposal...');
      const createProposalTx = await buildProposalCreate({
        connection,
        multisigPda,
        transactionIndex: TX_INDEX,
        creator: publicKey,
      });
      const createProposalSig = await sendTransaction(createProposalTx, connection);
      await connection.confirmTransaction(createProposalSig, 'confirmed');

      // Step 3: Player approves
      showToast('Step 3/4: Your approval...');
      const playerApproveTx = await buildProposalApprove({
        connection,
        multisigPda,
        transactionIndex: TX_INDEX,
        member: publicKey,
      });
      const playerApproveSig = await sendTransaction(playerApproveTx, connection);
      await connection.confirmTransaction(playerApproveSig, 'confirmed');

      // Step 4: Platform co-signs via backend
      showToast('Step 4/4: Platform co-signing...');
      const cosignRes = await fetch(`${COSIGNER_API_URL}/cosign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          multisigPda: multisigPda.toBase58(),
          transactionIndex: TX_INDEX,
          winner,
          loser,
          player1: battle.player1,
          player2: battle.player2,
          player1Snapshot: battle.player1Snapshot,
          player2Snapshot: battle.player2Snapshot,
          player1InitialUsd: battle.player1InitialUsd ?? null,
          player2InitialUsd: battle.player2InitialUsd ?? null,
          battleEndTime: battle.endTime,
          winnerLamports,
          feeLamports,
        }),
      });
      if (!cosignRes.ok) {
        const err = await cosignRes.json();
        throw new Error(`Platform co-sign failed: ${err.error}`);
      }
      const { sig: cosignSig } = await cosignRes.json();

      // Execute vault transaction (threshold met, funds released)
      showToast('Executing payout...');
      const executeTx = await buildVaultExecute({
        connection,
        multisigPda,
        transactionIndex: TX_INDEX,
        executor: publicKey,
        winnerPubkey: winner,
        treasuryPubkey: TREASURY_WALLET,
      });
      const executeSig = await sendTransaction(executeTx, connection);
      await connection.confirmTransaction(executeSig, 'confirmed');

      setBattle(prev => ({
        ...prev,
        status: 'SETTLED',
        winner,
        loser,
        player1Score: finalP1Score,
        player2Score: finalP2Score,
        settleSig: executeSig,
        cosignSig,
      }));
      setSettled(true);
      showToast('Battle settled. Funds released!');

      // Notify server of settlement result
      fetch(`${COSIGNER_API_URL}/battle/${battle.id}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          winner,
          player1Score: finalP1Score,
          player2Score: finalP2Score,
          settleSig: executeSig,
        }),
      }).catch(() => {});

    } catch (e) {
      console.error(e);
      showToast(e.message?.includes('rejected') ? 'Rejected.' : 'Settlement failed: ' + e.message);
    } finally {
      setSettling(false);
    }
  }, [publicKey, connection, sendTransaction, battle, p1Score, p2Score, setBattle, showToast]);

  if (!battle || !['ACTIVE', 'SETTLED'].includes(battle.status)) return null;

  const myKey = publicKey?.toBase58();
  const p1IsMe = myKey === battle.player1;
  const p2IsMe = myKey === battle.player2;
  const myScore = p1IsMe ? p1Score : p2IsMe ? p2Score : null;
  const oppScore = p1IsMe ? p2Score : p2IsMe ? p1Score : null;
  const isWinner = battle.status === 'SETTLED' && battle.winner === myKey;
  const totalPot = battle.stake * 2;
  const winnerAmt = calcWinnerAmountSol(totalPot, battle.feeBps);
  const feeAmt = calcFeeAmountSol(totalPot, battle.feeBps);

  const formatTime = ms => {
    if (ms === null) return '--:--:--';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  const timeExpired = timeLeft === 0;

  return (
    <div>
      {battle.status === 'SETTLED' ? (
        <>
          <h2>{isWinner ? 'YOU WON' : 'YOU LOST'}</h2>
          <p className="sub">BATTLE SETTLED</p>

          <div className="winner-banner" style={!isWinner ? { borderColor: '#f87171' } : {}}>
            <h3>{isWinner ? 'VICTORY' : 'DEFEAT'}</h3>
            <p style={{ color: '#aaa', fontFamily: 'sans-serif', fontSize: '0.9rem', marginTop: '8px', marginBottom: 0 }}>
              Winner: {truncateAddress(battle.winner)}
            </p>
          </div>

          <div className="fee-breakdown">
            <div className="fee-row">
              <span>Total pot</span>
              <span>{totalPot.toFixed(3)} SOL</span>
            </div>
            <div className="fee-row">
              <span>Platform fee ({toFeePercent(battle.feeBps)})</span>
              <span>-{feeAmt.toFixed(4)} SOL</span>
            </div>
            <div className="fee-row">
              <span>Winner receives</span>
              <span style={{ color: '#4ade80' }}>{winnerAmt.toFixed(4)} SOL</span>
            </div>
          </div>

          <div className="battle-live">
            <div className={`player-card ${(battle.player1Score ?? 0) >= (battle.player2Score ?? 0) ? 'winning' : 'losing'}`}>
              <div className="you-badge">P1</div>
              <div className="player-addr">{truncateAddress(battle.player1)}</div>
              <div className={`player-score ${(battle.player1Score ?? 0) >= 0 ? 'up' : 'down'}`}>
                {battle.player1Score !== null ? `${battle.player1Score >= 0 ? '+' : ''}${battle.player1Score.toFixed(2)}%` : '-'}
              </div>
              <div className="score-label">P&L</div>
            </div>
            <div className={`player-card ${(battle.player2Score ?? 0) > (battle.player1Score ?? 0) ? 'winning' : 'losing'}`}>
              <div className="you-badge">P2</div>
              <div className="player-addr">{truncateAddress(battle.player2)}</div>
              <div className={`player-score ${(battle.player2Score ?? 0) >= 0 ? 'up' : 'down'}`}>
                {battle.player2Score !== null ? `${battle.player2Score >= 0 ? '+' : ''}${battle.player2Score.toFixed(2)}%` : '-'}
              </div>
              <div className="score-label">P&L</div>
            </div>
          </div>

          {battle.settleSig && (
            <p style={{ color: '#555', fontSize: '0.75rem', fontFamily: 'monospace', marginTop: '12px' }}>
              Settled: {truncateAddress(battle.settleSig, 8)}
            </p>
          )}

          <button
            className="action-btn"
            style={{ marginTop: '16px', background: '#1a1a1a', border: '1px solid #333', fontSize: '1rem' }}
            onClick={clearBattle}
          >
            NEW BATTLE
          </button>
        </>
      ) : (
        <>
          <h2>BATTLE LIVE</h2>

          {/* Device switch warning */}
          {!warningDismissed && (
            <div style={{
              background: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: '8px',
              padding: '10px 14px',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}>
              <span style={{ color: '#92400e', fontSize: '0.8rem', fontFamily: 'sans-serif', lineHeight: '1.4' }}>
                ⚠️ DO NOT SWITCH DEVICES — Battle state is tied to this browser. Switching devices may prevent settlement.
              </span>
              <button
                onClick={() => setWarningDismissed(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: '1rem', padding: '0 4px', flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
          )}

          <div className="timer-label">TIME REMAINING</div>
          <div className="timer-display" style={timeExpired ? { color: '#f87171' } : {}}>
            {timeExpired ? "TIME'S UP" : formatTime(timeLeft)}
          </div>

          <div className="battle-live">
            <div className={`player-card${p1Score !== null && p2Score !== null ? (p1Score >= p2Score ? ' winning' : ' losing') : ''}`}>
              {p1IsMe && <div className="you-badge">YOU</div>}
              <div className="player-addr">{truncateAddress(battle.player1)}</div>
              <div className={`player-score${p1Score !== null ? (p1Score >= 0 ? ' up' : ' down') : ''}`}>
                {p1Score !== null ? `${p1Score >= 0 ? '+' : ''}${p1Score.toFixed(2)}%` : '-'}
              </div>
              <div className="score-label">PORTFOLIO P&L</div>
              {p1ValueUsd !== null && (
                <div style={{ color: '#555', fontSize: '0.8rem', marginTop: '4px', fontFamily: 'sans-serif' }}>
                  ${p1ValueUsd.toFixed(2)}
                </div>
              )}
            </div>

            <div className={`player-card${p1Score !== null && p2Score !== null ? (p2Score > p1Score ? ' winning' : ' losing') : ''}`}>
              {p2IsMe && <div className="you-badge">YOU</div>}
              <div className="player-addr">{truncateAddress(battle.player2)}</div>
              <div className={`player-score${p2Score !== null ? (p2Score >= 0 ? ' up' : ' down') : ''}`}>
                {p2Score !== null ? `${p2Score >= 0 ? '+' : ''}${p2Score.toFixed(2)}%` : '-'}
              </div>
              <div className="score-label">PORTFOLIO P&L</div>
              {p2ValueUsd !== null && (
                <div style={{ color: '#555', fontSize: '0.8rem', marginTop: '4px', fontFamily: 'sans-serif' }}>
                  ${p2ValueUsd.toFixed(2)}
                </div>
              )}
            </div>
          </div>

          <div style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: '8px', padding: '12px', margin: '12px 0', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>POT</span>
            <span style={{ color: '#ffd700' }}>{totalPot.toFixed(3)} SOL</span>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>FEE</span>
            <span style={{ color: '#aaa' }}>{toFeePercent(battle.feeBps)}</span>
            <span style={{ color: '#555', fontFamily: 'sans-serif', fontSize: '0.85rem' }}>WINNER GETS</span>
            <span style={{ color: '#4ade80' }}>{winnerAmt.toFixed(3)} SOL</span>
          </div>

          {timeExpired && (
            <button
              className="action-btn"
              onClick={handleSettle}
              disabled={settling}
            >
              {settling
                ? <><span className="spinner" />SETTLING...</>
                : 'SETTLE BATTLE'}
            </button>
          )}

          <p style={{ color: '#333', fontSize: '0.75rem', fontFamily: 'sans-serif', marginTop: '12px' }}>
            Prices refresh every 30s via Jupiter. Score = portfolio % gain from battle start.
          </p>
        </>
      )}
    </div>
  );
}
