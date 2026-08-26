import { clampProbability, normalCdf } from './basis-model';
import type { SettlementAverageEstimate } from './types';

export const SETTLEMENT_AVERAGE_SECONDS = 60;

interface TimedPrice { time: number; price: number }

function observedLogIntegral(observations: TimedPrice[], startMs: number, endMs: number, currentPrice: number): number | null {
  const valid = observations.filter((item) => Number.isFinite(item.time) && item.price > 0).sort((a, b) => a.time - b.time);
  const before = [...valid].reverse().find((item) => item.time <= startMs);
  const inside = valid.filter((item) => item.time > startMs && item.time < endMs);
  const first = before ?? inside[0];
  if (!first) return null;
  const points = [{ time: startMs, price: first.price }, ...inside, { time: endMs, price: currentPrice }];
  let integral = 0;
  for (let index = 1; index < points.length; index += 1) {
    const seconds = (points[index].time - points[index - 1].time) / 1000;
    if (!(seconds >= 0)) return null;
    // Trapezoidal integration in log-price space approximates the geometric settlement average.
    integral += seconds * (Math.log(points[index - 1].price) + Math.log(points[index].price)) / 2;
  }
  return integral;
}

/**
 * Explicit distribution of the final-minute average under driftless log-price Brownian motion.
 * This is recorded beside the production estimate but is not yet allowed to influence trading.
 */
export function estimateSettlementAverage(input: {
  referencePrice: number;
  currentPrice: number;
  closesAtMs: number;
  nowMs: number;
  volatilityPerSecond: number;
  windowSeconds?: number;
  observations?: TimedPrice[];
}): SettlementAverageEstimate | null {
  const { referencePrice, currentPrice, closesAtMs, nowMs, volatilityPerSecond } = input;
  if (!(referencePrice > 0) || !(currentPrice > 0) || !(volatilityPerSecond > 0) || ![closesAtMs, nowMs].every(Number.isFinite)) return null;
  const remainingSeconds = Math.max(0, (closesAtMs - nowMs) / 1000);
  const window = Number.isFinite(input.windowSeconds) && input.windowSeconds! > 0
    ? input.windowSeconds! : SETTLEMENT_AVERAGE_SECONDS;
  let meanLogPrice: number;
  let effectiveVarianceSeconds: number;
  let observedSettlementSeconds = 0;
  let method: SettlementAverageEstimate['method'];
  if (remainingSeconds >= window) {
    meanLogPrice = Math.log(currentPrice);
    // Variance of the average of Brownian motion over [T-W,T] is σ²(T-2W/3).
    effectiveVarianceSeconds = remainingSeconds - 2 * window / 3;
    method = 'future-window';
  } else {
    observedSettlementSeconds = window - remainingSeconds;
    const startMs = closesAtMs - window * 1000;
    const integral = observedLogIntegral(input.observations ?? [], startMs, nowMs, currentPrice);
    if (integral === null) return null;
    meanLogPrice = (integral + remainingSeconds * Math.log(currentPrice)) / window;
    // Conditional variance of the unobserved integral is σ²r³/3, divided by W².
    effectiveVarianceSeconds = remainingSeconds ** 3 / (3 * window ** 2);
    method = 'partially-observed-window';
  }
  const standardDeviation = volatilityPerSecond * Math.sqrt(Math.max(0, effectiveVarianceSeconds));
  const logBasis = meanLogPrice - Math.log(referencePrice);
  const probabilityUp = standardDeviation > 1e-12
    ? clampProbability(normalCdf(logBasis / standardDeviation), 0.001, 0.999)
    : logBasis >= 0 ? 0.999 : 0.001;
  return {
    probabilityUp, windowSeconds: window, expectedAveragePrice: Math.exp(meanLogPrice),
    standardDeviationPercent: standardDeviation * 100,
    effectiveVarianceSeconds, observedSettlementSeconds, method,
  };
}
