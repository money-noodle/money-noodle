import { normalCdf } from './basis-model';
import type { MakerFillEstimate } from './types';

export const MANAGED_MAKER_HORIZON_SECONDS = 12;

interface TimedQuote { time: number; ask: number }

export function quoteVolatilityPerSecond(points: TimedQuote[]): { volatility: number; samples: number } | null {
  const valid = points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.ask) && point.ask > 0 && point.ask < 1).sort((a, b) => a.time - b.time);
  if (valid.length < 4) return null;
  const normalizedChanges: number[] = [];
  for (let index = 1; index < valid.length; index += 1) {
    const seconds = (valid[index].time - valid[index - 1].time) / 1000;
    if (!(seconds > 0)) continue;
    normalizedChanges.push((valid[index].ask - valid[index - 1].ask) / Math.sqrt(seconds));
  }
  if (normalizedChanges.length < 3) return null;
  const mean = normalizedChanges.reduce((sum, value) => sum + value, 0) / normalizedChanges.length;
  const variance = normalizedChanges.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (normalizedChanges.length - 1);
  const volatility = Math.sqrt(Math.max(variance, 0));
  return volatility > 1e-8 && Number.isFinite(volatility) ? { volatility, samples: normalizedChanges.length } : null;
}

/**
 * Brownian first-passage proxy for the ask touching our passive bid during the managed-order window.
 * Touch is not fill: queue priority and informed selling are deliberately left for empirical validation.
 */
export function estimateMakerTouch(input: {
  currentAsk: number;
  passiveBid: number;
  horizonSeconds?: number;
  quoteHistory: TimedQuote[];
}): MakerFillEstimate | null {
  const horizonSeconds = input.horizonSeconds ?? MANAGED_MAKER_HORIZON_SECONDS;
  if (!(input.currentAsk > 0) || !(input.currentAsk < 1) || !(input.passiveBid > 0) || input.passiveBid >= input.currentAsk || !(horizonSeconds > 0)) return null;
  const estimate = quoteVolatilityPerSecond(input.quoteHistory);
  if (!estimate) return null;
  const quoteDistance = input.currentAsk - input.passiveBid;
  const z = quoteDistance / (estimate.volatility * Math.sqrt(horizonSeconds));
  const probability = Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
  return {
    probability, horizonSeconds, quoteDistance, quoteVolatilityPerSecond: estimate.volatility,
    samples: estimate.samples, model: 'quote-first-passage-v1',
  };
}
