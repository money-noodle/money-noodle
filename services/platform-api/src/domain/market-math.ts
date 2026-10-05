// The arithmetic the market-data reads publish, and nothing else.
//
// Three pure pieces: a normal distribution, a realized-volatility estimator over
// one-minute closes, and the zero-drift threshold model that turns a strike and a
// spot price into a probability. All three are public arithmetic over public data,
// which is why they are in scope while the forecasting model and the entry policy
// they sit next to in v1 are not (#211, decision 1).
//
// Two properties are worth stating because they are easy to lose:
//
//   * **Completed minutes only.** Every estimate here is computed from closes the
//     caller has already filtered to finished candles. The still-forming minute is
//     dropped by the adapter, which is a deliberate difference from v1: v1 fed the
//     in-progress candle into both the current price and the last return, so its
//     newest "return" described a partial minute and moved as the minute filled
//     (#211, decision 3).
//   * **No clamp on the threshold model.** A probability near zero or one is the
//     answer the model gives for a contract that is nearly settled, and flattening
//     it would be inventing confidence this arithmetic does not have.

import {
  MINIMUM_EFFECTIVE_SECONDS,
  SETTLEMENT_WINDOW_SECONDS,
  VOLATILITY_CANDLE_ROWS,
} from './market-registry.js';

/** The fewest closes an estimate is computed from. */
export const MINIMUM_VOLATILITY_CLOSES = 12;

/** The fewest returns an estimate is computed from. */
export const MINIMUM_VOLATILITY_RETURNS = 10;

/**
 * The standard normal cumulative distribution.
 *
 * Zelen & Severo's five-term approximation, absolute error below 7.5e-8 — the same
 * function v1 used, so a probability published here matches the one published there
 * for the same inputs. A non-finite input is the limit it is approaching rather
 * than a thrown error, because the caller has already decided the inputs are usable.
 */
export function standardNormalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;

  const absolute = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp((-absolute * absolute) / 2);
  const tail =
    density *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));

  return z >= 0 ? 1 - tail : tail;
}

/**
 * The inverse of the above, for reading an implied volatility out of a quote.
 *
 * Acklam's rational approximation, relative error below 1.15e-9 across the open
 * interval. Returns `undefined` at or outside the bounds rather than an infinity: a
 * venue quoting exactly zero or one implies no finite volatility, and that is an
 * absent answer rather than a huge one.
 */
export function standardNormalQuantile(probability: number): number | undefined {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return undefined;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (probability > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }

  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Closes worth estimating from: finite, positive, and bounded to the window. */
export function usableCloses(closes: readonly number[]): readonly number[] {
  return Object.freeze(
    closes.filter((close) => Number.isFinite(close) && close > 0).slice(-VOLATILITY_CANDLE_ROWS),
  );
}

export interface RealizedVolatility {
  /** Returns the estimate was computed from. */
  readonly samples: number;
  /** Standard deviation of log return per square-root second. */
  readonly perSecond: number;
}

/**
 * Realized volatility of one-minute log returns, as volatility per second.
 *
 * The sample standard deviation of the log returns, divided by the square root of
 * the interval — no annualization, no weighting, no outlier handling, which keeps it
 * the same number v1 published. `undefined` when there is not enough data to say
 * anything: a volatility invented from three candles is worse than none, because the
 * threshold model would happily use it.
 */
export function realizedVolatilityPerSecond(
  closes: readonly number[],
  intervalSeconds = 60,
): RealizedVolatility | undefined {
  const usable = usableCloses(closes);
  if (usable.length < MINIMUM_VOLATILITY_CLOSES) return undefined;

  const returns: number[] = [];
  for (let index = 1; index < usable.length; index += 1) {
    const value = Math.log(usable[index]! / usable[index - 1]!);
    if (Number.isFinite(value)) returns.push(value);
  }
  if (returns.length < MINIMUM_VOLATILITY_RETURNS) return undefined;

  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance =
    returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1);
  const perInterval = Math.sqrt(Math.max(variance, 0));
  if (!Number.isFinite(perInterval) || perInterval <= 0) return undefined;

  const perSecond = perInterval / Math.sqrt(intervalSeconds);
  return Number.isFinite(perSecond) && perSecond > 0
    ? Object.freeze({ perSecond, samples: returns.length })
    : undefined;
}

/**
 * Effective seconds to settlement.
 *
 * Half the settlement averaging window is subtracted, because a contract settling on
 * an average over its final minute stops being exposed to the full remaining time
 * halfway through that window. Floored, so a contract in its last seconds still has
 * a finite standard deviation to divide by.
 */
export function effectiveSecondsRemaining(secondsRemaining: number): number {
  return Math.max(MINIMUM_EFFECTIVE_SECONDS, secondsRemaining - SETTLEMENT_WINDOW_SECONDS / 2);
}

export interface ThresholdModelInput {
  readonly currentPrice: number;
  readonly secondsRemaining: number;
  readonly strike: number;
  readonly volatilityPerSecond: number;
}

/**
 * The probability the price is above `strike` at settlement.
 *
 * Zero-drift log-normal diffusion: no expected return, no fees, no clamp. `ABOVE` and
 * `BELOW` contracts carry different strikes, so one is not the complement of the
 * other and each is computed from its own.
 */
export function probabilityAboveStrike(input: ThresholdModelInput): number | undefined {
  const { currentPrice, secondsRemaining, strike, volatilityPerSecond } = input;
  if (!Number.isFinite(strike) || strike <= 0) return undefined;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return undefined;
  if (!Number.isFinite(volatilityPerSecond) || volatilityPerSecond <= 0) return undefined;
  if (!Number.isFinite(secondsRemaining) || secondsRemaining < 0) return undefined;

  const standardDeviation =
    volatilityPerSecond * Math.sqrt(effectiveSecondsRemaining(secondsRemaining));
  if (!Number.isFinite(standardDeviation) || standardDeviation <= 0) return undefined;

  return standardNormalCdf(Math.log(currentPrice / strike) / standardDeviation);
}

/** The lower and upper bound v1 applied to the basis probability. */
export const BASIS_PROBABILITY_BOUNDS = Object.freeze({ lower: 0.05, upper: 0.95 });

/** Clamps to the basis bounds, which is what the published basis figure carries. */
export function boundedBasisProbability(probability: number): number {
  return Math.min(
    BASIS_PROBABILITY_BOUNDS.upper,
    Math.max(BASIS_PROBABILITY_BOUNDS.lower, probability),
  );
}
