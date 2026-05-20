import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export function calcFeeAmountSol(totalPotSol, feeBps) {
  return (totalPotSol * feeBps) / 10000;
}

export function calcWinnerAmountSol(totalPotSol, feeBps) {
  return totalPotSol - calcFeeAmountSol(totalPotSol, feeBps);
}

export function toFeePercent(feeBps) {
  return `${feeBps / 100}%`;
}

export function toLamports(sol) {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function truncateAddress(address, chars = 4) {
  if (!address) return '';
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
