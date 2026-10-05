// Display formatting, and the only arithmetic this app is allowed to do.
//
// Every figure the site shows is the API's own. What happens here is formatting plus
// three unit conversions that change no value: cents to dollars, a ratio to a
// percentage, and a contract price to cents. Nothing below rounds a number before
// comparing it, derives a new statistic, or substitutes a value for a missing one —
// an absent figure becomes a dash, which is a statement that the API did not publish
// it rather than a zero that reads as a measurement.
//
// The locale is fixed to en-US and times are rendered as the API's own ISO-8601 UTC
// strings. v1 formatted times in the browser's locale, which cannot be reproduced on a
// server and would make the same page render differently per reader; a `<time
// dateTime>` element carries the machine-readable instant either way.

/** What a figure the API did not publish looks like. Never a zero. */
export const DASH = '—';

const LOCALE = 'en-US';

const usd = new Intl.NumberFormat(LOCALE, {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
});

const compactUsd = new Intl.NumberFormat(LOCALE, {
  currency: 'USD',
  maximumFractionDigits: 1,
  notation: 'compact',
  style: 'currency',
});

const counts = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

const finite = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Applies `format` to a value the API published, or renders the dash. */
export function orDash<T>(value: T | null | undefined, format: (value: T) => string): string {
  return value === null || value === undefined ? DASH : format(value);
}

/**
 * An amount the API publishes in US cents, as dollars.
 *
 * Division by one hundred is a unit change, not a rounding: the API's own description
 * says these are cents, and a reader is owed dollars.
 */
export function formatCents(cents: number | null | undefined): string {
  const value = finite(cents);
  return value === undefined ? DASH : usd.format(value / 100);
}

/** The same, with an explicit sign, for a profit or loss. */
export function formatSignedCents(cents: number | null | undefined): string {
  const value = finite(cents);
  if (value === undefined) return DASH;
  return value > 0 ? `+${usd.format(value / 100)}` : usd.format(value / 100);
}

/**
 * A spot price in dollars, at v1's precision thresholds.
 *
 * A sub-cent asset needs five decimals to be a price at all, and a four-figure one
 * reads as noise with them, so the precision follows the magnitude.
 */
export function formatSpotPrice(price: number | null | undefined): string {
  const value = finite(price);
  if (value === undefined) return DASH;
  const digits = Math.abs(value) < 0.1 ? 5 : Math.abs(value) < 10 ? 3 : 2;
  return new Intl.NumberFormat(LOCALE, {
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: 'currency',
  }).format(value);
}

/** A large dollar figure, compactly: liquidity and volume. */
export function formatCompactUsd(value: number | null | undefined): string {
  const amount = finite(value);
  return amount === undefined ? DASH : compactUsd.format(amount);
}

/** A whole count, grouped. */
export function formatCount(value: number | null | undefined): string {
  const amount = finite(value);
  return amount === undefined ? DASH : counts.format(amount);
}

/** A ratio the API publishes as a fraction, as a percentage. */
export function formatRatio(ratio: number | null | undefined, digits = 1): string {
  const value = finite(ratio);
  return value === undefined ? DASH : `${(value * 100).toFixed(digits)}%`;
}

/** A percentage the API already publishes in percent units. */
export function formatPercentUnits(percent: number | null | undefined, digits = 2): string {
  const value = finite(percent);
  if (value === undefined) return DASH;
  const rendered = `${Math.abs(value).toFixed(digits)}%`;
  return value > 0 ? `+${rendered}` : value < 0 ? `-${rendered}` : rendered;
}

/**
 * A model probability, with v1's readable bounds.
 *
 * Below a tenth of a percent and above 99.9 the exact figure says less than the fact
 * that it is past the edge of what an estimate from two hours of minutes can support,
 * so it is shown as an inequality rather than a precise-looking decimal.
 */
export function formatModelProbability(ratio: number | null | undefined): string {
  const value = finite(ratio);
  if (value === undefined) return DASH;
  if (value < 0.001) return '<0.1%';
  if (value > 0.999) return '>99.9%';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A contract price as cents of its one-dollar settlement.
 *
 * Two decimals under one cent, one above: a price of 0.004 is four tenths of a cent
 * and rounding it to "0.4¢" at one decimal is right, while rounding it to "0¢" is not.
 */
export function formatContractPrice(price: number | null | undefined): string {
  const value = finite(price);
  if (value === undefined) return DASH;
  const cents = value * 100;
  return `${cents < 1 ? cents.toFixed(2) : cents.toFixed(1)}¢`;
}

/** A difference between two probabilities, in signed probability points. */
export function formatSignedPoints(ratio: number | null | undefined): string {
  const value = finite(ratio);
  if (value === undefined) return DASH;
  const points = value * 100;
  return `${points >= 0 ? '+' : '-'}${Math.abs(points).toFixed(1)} pp`;
}

/** A small number, at the precision it was published with. */
export function formatNumber(value: number | null | undefined, digits = 6): string {
  const amount = finite(value);
  return amount === undefined ? DASH : amount.toPrecision(digits).replace(/\.?0+$/u, '');
}

/**
 * How long ago a feed value was obtained, in words.
 *
 * Read from the age the API published rather than from a clock here: comparing the
 * API's time to this machine's would make freshness depend on clock skew between two
 * servers, and the API has already measured it.
 */
export function formatAge(seconds: number | null | undefined): string {
  const value = finite(seconds);
  if (value === undefined) return DASH;
  const whole = Math.max(0, Math.round(value));
  if (whole < 2) return 'just now';
  if (whole < 90) return `${whole} seconds ago`;
  const minutes = Math.round(whole / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hours ago` : `${hours} hours ${rest} minutes ago`;
}

/** Seconds until a contract settles, in words. */
export function formatRemaining(seconds: number | null | undefined): string {
  const value = finite(seconds);
  if (value === undefined) return DASH;
  const whole = Math.max(0, Math.floor(value));
  const minutes = Math.floor(whole / 60);
  return minutes === 0 ? `${whole} seconds` : `${minutes} min ${whole % 60} s`;
}

/**
 * A lifecycle label, as v1 showed it.
 *
 * The source does not constrain these strings, so an unrecognised value is shown as
 * the value it is with its first underscore opened out — never mapped to a friendlier
 * word that might not mean the same thing.
 */
export function formatLifecycle(status: string, noFillReason?: string): string {
  const value = noFillReason ?? status;
  return value.replace('_', ' ');
}
