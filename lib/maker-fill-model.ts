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

/**
 * Empirical fill estimate, replacing the first-passage probability as the reported number.
 *
 * `estimateMakerTouch` answers a real question — will the ask reach our bid — and it answers it
 * honestly. It is simply not the question the desk needs, and validation against 623 recorded attempts
 * showed it is worse than uninformative: sorted into buckets by its own prediction, observed fill rates
 * ran 66%, 61%, 57%, 52% against predictions of 12%, 41%, 64%, 86%. Perfectly monotonic, backwards.
 *
 * The mechanism is queue position, which touch cannot see. A tight spread makes a touch look easy and
 * simultaneously means a deep queue we are standing behind, so the quote reaches our price and trades
 * against someone else's order. Since the signal is inverted rather than noisy, blending it in would
 * carry the inversion with it; it is therefore recorded as a diagnostic and excluded from the estimate.
 *
 * What does predict a fill is what comparable attempts actually did, which is why this shrinks the
 * observed rate of the same price/spread cohort toward the base rate rather than modelling the book.
 */
export const MAKER_FILL_BASE_RATE = 0.55;
/** Prior weight in cohort-equivalents: a thin cohort barely moves the estimate off the base rate. */
export const MAKER_FILL_PRIOR_ATTEMPTS = 20;

export function estimateMakerFill(input: {
  touch: MakerFillEstimate | null;
  cohortLabel?: string;
  cohortAttempts?: number;
  cohortFills?: number;
  baseRate?: number;
}): MakerFillEstimate | null {
  if (!input.touch) return null;
  const base = input.baseRate ?? MAKER_FILL_BASE_RATE;
  const attempts = Math.max(0, input.cohortAttempts ?? 0);
  const fills = Math.max(0, Math.min(attempts, input.cohortFills ?? 0));
  const probability = (fills + MAKER_FILL_PRIOR_ATTEMPTS * base) / (attempts + MAKER_FILL_PRIOR_ATTEMPTS);
  return {
    ...input.touch,
    probability,
    model: 'maker-fill-empirical-v2',
    touchProbability: input.touch.probability,
    cohortLabel: input.cohortLabel,
    cohortAttempts: attempts,
    cohortFillRate: attempts ? fills / attempts : null,
  };
}
