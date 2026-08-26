/**
 * Contract-basis probability model.
 *
 * Both venues resolve a 15-minute contract by comparing a settlement average near close against a
 * reference price fixed at cycle open. The probability that matters is therefore not "is this asset
 * bullish" but "will the settlement print finish at or above an already-known reference".
 */

/**
 * The basis term has no resolved track record yet, so it is deliberately capped short of certainty.
 * Widen these bounds only after the calibration gate reports a real edge.
 */
export const MIN_BASIS_PROBABILITY = 0.05;
export const MAX_BASIS_PROBABILITY = 0.95;
/** Settlement averages the final minute, so the effective diffusion horizon ends mid-window. */
export const SETTLEMENT_WINDOW_SECONDS = 60;
export const MIN_EFFECTIVE_SECONDS = 2;

export function clampProbability(value: number, min = MIN_BASIS_PROBABILITY, max = MAX_BASIS_PROBABILITY): number {
  return Math.min(max, Math.max(min, value));
}

export function logit(probability: number): number {
  const p = clampProbability(probability, 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
}

export function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** Zelen & Severo normal CDF approximation; absolute error below 7.5e-8. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const density = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const tail = density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

export interface VolatilityEstimate {
  perSecond: number;
  samples: number;
}

/**
 * Realized volatility from evenly spaced closes, expressed per second so it can be scaled to any
 * remaining horizon. Returns no estimate rather than a fabricated default when data is too thin.
 */
export function realizedVolatility(closes: number[], intervalSeconds: number): VolatilityEstimate | null {
  const usable = closes.filter((price) => Number.isFinite(price) && price > 0);
  if (usable.length < 12 || intervalSeconds <= 0) return null;
  const returns: number[] = [];
  for (let index = 1; index < usable.length; index += 1) returns.push(Math.log(usable[index] / usable[index - 1]));
  const finite = returns.filter(Number.isFinite);
  if (finite.length < 10) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1);
  const perInterval = Math.sqrt(Math.max(variance, 0));
  if (!Number.isFinite(perInterval) || perInterval <= 0) return null;
  return { perSecond: perInterval / Math.sqrt(intervalSeconds), samples: finite.length };
}

/**
 * Picks the first usable estimate in priority order.
 *
 * This previously took the widest estimate, which looked conservative but is the opposite in an
 * expected-value model: inflating volatility pulls probabilities toward 50%, which fabricates edge
 * on cheap contracts and biases the desk into buying longshots. Volatility must be unbiased, and
 * safety belongs in the edge threshold and entry-price range instead.
 */
export function resolveVolatility(estimates: Array<VolatilityEstimate | null>): VolatilityEstimate | null {
  return estimates.find((estimate): estimate is VolatilityEstimate => Boolean(estimate) && estimate!.perSecond > 0) ?? null;
}

/** Acklam's rational approximation of the inverse normal CDF; absolute error below 1.15e-9. */
export function normalInverseCdf(p: number): number {
  if (!(p > 0) || !(p < 1)) return Number.NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Backs the market's implied volatility out of a venue price.
 *
 * Basis and time to settlement are public, so volatility is the only input on which our estimate can
 * legitimately differ from the venue's. Comparing the two turns "do we have edge?" into a measurable
 * question. Returns null when the market disagrees with the direction of the basis, since no positive
 * volatility can reconcile that.
 */
export function impliedVolatility(input: { logBasis: number; marketProbability: number; secondsRemaining: number }): number | null {
  const { logBasis, marketProbability, secondsRemaining } = input;
  const effectiveSeconds = Math.max(MIN_EFFECTIVE_SECONDS, secondsRemaining - SETTLEMENT_WINDOW_SECONDS / 2);
  const z = normalInverseCdf(clampProbability(marketProbability, 1e-6, 1 - 1e-6));
  if (!Number.isFinite(z) || Math.abs(z) < 1e-6 || Math.abs(logBasis) < 1e-12) return null;
  const perSecond = logBasis / (z * Math.sqrt(effectiveSeconds));
  return Number.isFinite(perSecond) && perSecond > 0 ? perSecond : null;
}

export interface BasisInput {
  referencePrice: number;
  currentPrice: number;
  secondsRemaining: number;
  volatilityPerSecond: number;
  volatilitySamples?: number;
}

export interface BasisResult {
  probabilityUp: number;
  logBasis: number;
  standardDeviation: number;
  zScore: number;
  effectiveSeconds: number;
}

/**
 * Driftless log-normal diffusion to settlement. Short-horizon crypto drift is not estimable from
 * 15-minute samples, so assuming zero drift is deliberately more honest than fitting noise.
 */
export function basisProbability(input: BasisInput): BasisResult | null {
  const { referencePrice, currentPrice, secondsRemaining, volatilityPerSecond } = input;
  if (!(referencePrice > 0) || !(currentPrice > 0) || !(volatilityPerSecond > 0) || !Number.isFinite(secondsRemaining)) return null;
  const effectiveSeconds = Math.max(MIN_EFFECTIVE_SECONDS, secondsRemaining - SETTLEMENT_WINDOW_SECONDS / 2);
  const logBasis = Math.log(currentPrice / referencePrice);
  // No safety multiplier is applied here. Any padding of volatility biases the probability, and a
  // biased probability feeds straight into the edge calculation as fabricated expected value.
  const standardDeviation = volatilityPerSecond * Math.sqrt(effectiveSeconds);
  if (!(standardDeviation > 0)) return null;
  const zScore = logBasis / standardDeviation;
  return {
    probabilityUp: clampProbability(normalCdf(zScore)),
    logBasis, standardDeviation, zScore, effectiveSeconds,
  };
}
