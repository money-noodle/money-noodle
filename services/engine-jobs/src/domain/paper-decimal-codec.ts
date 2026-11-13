// Unwired representation only; not financial arithmetic, source receipts or admission.
// v1 finite transport domain: absolute magnitude <=2e12, at most324 fractional
// digits. This covers selected raw-cost bounds and binary64 subnormals, NOT all
// PostgreSQL numeric values. Field-specific economic bounds remain caller proof.
export const PAPER_DECIMAL_TRANSPORT = 'paper-bounded-decimal-source-binary64-v1';
export interface PaperExactDecimal {
  coefficient: bigint;
  scale: number;
}
export function decodePaperExactDecimal(value: unknown): PaperExactDecimal | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 339 ||
    value.trim() !== value ||
    !/^-?(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{0,323}[1-9])?$/.test(value) ||
    value === '-0'
  )
    return undefined;
  const [whole, fraction = ''] = value.split('.');
  const coefficient = BigInt(whole! + fraction);
  const scale = fraction.length;
  const bound = 2_000_000_000_000n * 10n ** BigInt(scale);
  if (coefficient < -bound || coefficient > bound) return undefined;
  return { coefficient, scale };
}
/** Exact TEXT comparison; never routes SQL numeric through a driver Number. */
export function comparePaperExactDecimals(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = decodePaperExactDecimal(left),
    b = decodePaperExactDecimal(right);
  if (!a || !b) return undefined;
  const scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale);
  const y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Decimal spelling of the existing binary64 value, NOT its exact rational value.
 * Shortest-roundtrip Number spelling expanded to plain decimal; no toFixed,
 * rounding, source arithmetic replacement or invented integer-cent conversion.
 * Signed zero is unavailable rather than silently losing its sign.
 */
export function encodePaperSourceBinary64(value: unknown): string | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    Math.abs(value) > 2_000_000_000_000
  )
    return undefined;
  const text = value.toString();
  if (!text.includes('e')) return decodePaperExactDecimal(text) ? text : undefined;
  const [mantissa, exponent] = text.split('e');
  const negative = mantissa!.startsWith('-');
  const unsigned = negative ? mantissa!.slice(1) : mantissa!;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponent);
  const expanded =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point);
  const result = (negative ? '-' : '') + expanded;
  return decodePaperExactDecimal(result) ? result : undefined;
}
/** Only accepts the canonical source spelling, not arbitrary exact DB decimal.
 * Equality after Number coercion alone would admit changed/rounded evidence.
 * undefined is transport refusal, never zero, a valid empty sample or a phase.
 */
export function decodePaperSourceBinary64(value: unknown): number | undefined {
  if (!decodePaperExactDecimal(value)) return undefined;
  const number = Number(value);
  return encodePaperSourceBinary64(number) === value ? number : undefined;
}
// No source-kind/version/cause/window provenance is generated or overwritten.
// Callers still need genuine receipts and field bounds; no runtime imports use this.
