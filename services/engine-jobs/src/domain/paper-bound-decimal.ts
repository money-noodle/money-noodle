// Exact bound arithmetic for the persisted regime profile columns.
//
// Migration 0006 states these bounds in `numeric`, where `resume_confidence <=
// pause_confidence - 0.01` is decided on the recorded digits. Deciding the same rule in
// binary64 disagrees with the column in both directions: it refuses legal pairs
// (`0.94`/`0.93`, `0.9007`/`0.8907`) and admits illegal values whose excess digits round
// away (`0.99990000000000000001` is outside the column's domain, yet `Number` makes it
// `0.9999`). Every comparison here is therefore carried out over scaled integers.
//
// This introduces NO bound, tolerance, epsilon, rounding rule or strategy value, and NO
// new text grammar: accepted text is exactly the gate writer's existing unsigned
// `::numeric` spelling, so `'2.50'`, `'2.5'`, `'08'` and `'0.970'` all stay acceptable and
// compare by value. The qualified transport codec is used, never altered.
import { encodePaperSourceBinary64 } from './paper-decimal-codec.js';

/** The gate writer's own text bound for a value handed to `::numeric`. */
export const PAPER_BOUND_DECIMAL_MAX_TEXT = 24;
/** The margin 0006 writes literally as `pause_confidence-0.01`. Not a tunable. */
export const PAPER_CONFIDENCE_MARGIN = '0.01';

interface ScaledDecimal {
  coefficient: bigint;
  scale: number;
}

/** The writer grammar, parsed without normalising the spelling away: unsigned digits with
 * an optional fraction, no sign, exponent, space or padding. */
const scaled = (value: unknown): ScaledDecimal | undefined => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PAPER_BOUND_DECIMAL_MAX_TEXT ||
    !/^[0-9]+(\.[0-9]+)?$/.test(value)
  )
    return undefined;
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(whole! + fraction), scale: fraction.length };
};

const align = (left: ScaledDecimal, right: ScaledDecimal, floor = 0): [bigint, bigint, number] => {
  const scale = Math.max(left.scale, right.scale, floor);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
};

/** `-1`, `0` or `1` by value, so `'2.50'` and `'2.5'` compare equal; `undefined` when
 * either side is not writer-grammar decimal text. */
export function comparePaperBoundDecimals(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = scaled(left);
  const b = scaled(right);
  if (!a || !b) return undefined;
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Inclusive `minimum <= value <= maximum`, exactly. Unparsable text is outside every
 * range rather than silently coerced. */
export function paperBoundDecimalWithin(value: unknown, minimum: string, maximum: string): boolean {
  const low = comparePaperBoundDecimals(value, minimum);
  const high = comparePaperBoundDecimals(value, maximum);
  return low !== undefined && low >= 0 && high !== undefined && high <= 0;
}

/** `lower + margin <= upper`, which is 0006's `lower <= upper - margin` without a
 * subtraction that binary64 would have to round. */
export function paperBoundMarginSatisfied(
  lower: unknown,
  upper: unknown,
  margin: string = PAPER_CONFIDENCE_MARGIN,
): boolean {
  const a = scaled(lower);
  const b = scaled(upper);
  const m = scaled(margin);
  if (!a || !b || !m) return false;
  const [x, y, scale] = align(a, b, m.scale);
  return x + m.coefficient * 10n ** BigInt(scale - m.scale) <= y;
}

/** The exact decimal spelling of an existing binary64 value — the shortest round-trip
 * spelling, expanded, by the qualified transport codec. It is the value the number
 * already is, not a rounded or widened one, so a margin decided on it is decided on the
 * number in hand. `undefined` for anything the codec will not spell (non-finite, out of
 * its transport magnitude, or a spelling longer than the writer's text bound), and a
 * caller treats that as a refusal rather than guessing. */
export function paperBoundDecimalFromNumber(value: unknown): string | undefined {
  const text = encodePaperSourceBinary64(value);
  return text !== undefined && scaled(text) !== undefined ? text : undefined;
}

/** The margin rule for settings that are already numbers: compared on each number's own
 * exact decimal spelling. This removes the subtraction's rounding, and nothing more — two
 * distinct column spellings that became the same binary64 before reaching here are still
 * the same number, which is why the bounds are decided on the persisted text first. */
export function paperNumberMarginSatisfied(lower: unknown, upper: unknown): boolean {
  const a = paperBoundDecimalFromNumber(lower);
  const b = paperBoundDecimalFromNumber(upper);
  return a !== undefined && b !== undefined && paperBoundMarginSatisfied(a, b);
}

/** The three decimal profile fields as the EXACT text a `numeric` column holds. Carried
 * alongside the numeric settings so validity can be decided on the recorded digits; the
 * arithmetic still runs on the numbers. */
export interface PaperExactRegimeSettingsSource {
  readonly evidenceHalfLifeWindows: string;
  readonly pauseConfidence: string;
  readonly resumeConfidence: string;
}

/** The 0006 domains and the margin, on exact text. The bound literals live here only, so
 * the request validator, the row mapping and the evaluator cannot drift apart. */
export function paperExactRegimeSourceWithinDomains(
  source: unknown,
): source is PaperExactRegimeSettingsSource {
  if (!source || typeof source !== 'object') return false;
  const s = source as Record<string, unknown>;
  return (
    paperBoundDecimalWithin(s.evidenceHalfLifeWindows, '2', '500') &&
    paperBoundDecimalWithin(s.pauseConfidence, '0.9', '0.9999') &&
    paperBoundDecimalWithin(s.resumeConfidence, '0.5', '0.98') &&
    paperBoundMarginSatisfied(s.resumeConfidence, s.pauseConfidence)
  );
}

/** Whether an exact source may decide validity for THESE numbers.
 *
 * It must be a real source: writer-grammar text inside the domains with the margin
 * satisfied on digits, AND projecting onto exactly these numbers under the SAME `Number`
 * conversion the row mapping performs. Lost digits are never reconstructed from the
 * rounded number; agreement is proved in the one direction that is sound, text to number.
 * A source that fails any part of this is not a shortcut and not silently ignored: the
 * caller refuses. There is no flag, token or option anywhere that skips this. */
export function paperExactRegimeSourceAdmits(
  source: unknown,
  numeric: {
    readonly evidenceHalfLifeWindows: number;
    readonly pauseConfidence: number;
    readonly resumeConfidence: number;
  },
): boolean {
  if (!paperExactRegimeSourceWithinDomains(source)) return false;
  return (
    Number(source.evidenceHalfLifeWindows) === numeric.evidenceHalfLifeWindows &&
    Number(source.pauseConfidence) === numeric.pauseConfidence &&
    Number(source.resumeConfidence) === numeric.resumeConfidence
  );
}
