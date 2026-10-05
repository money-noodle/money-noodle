// Reading a record this service does not own, without trusting it.
//
// The budget and execution rows arrive through typed column readers, but the
// performance record is one stored JSON document written by a separate system
// (ADR-0012). v1 served that document with almost no validation, so a field that
// changed shape upstream reached a client as whatever it had become. Closing that
// gap is the point of this module.
//
// Three rules, and they are the supervisor's decisions for #210 rather than
// preferences:
//
//   * **Tolerant, not lax.** Every documented field's type and nullability is
//     checked. A documented `null` is a real answer and is accepted as one; it is
//     never substituted with zero.
//   * **Unknown keys are stripped, not rejected.** Every record below is rebuilt
//     field by field, so a key the source added is dropped rather than served,
//     and a field withdrawn from this contract cannot reappear from an older
//     stored document. Rebuilding *is* the stripping; there is no separate pass.
//   * **A refusal names the path and never the value.** The failure carries
//     `summary.benchmarks[0].accuracy`, not what was there. Field paths are
//     public contract; the values may be anything the source stored, and this
//     service does not repeat them (SECURITY.md).
//
// Pure: no I/O, no driver, no clock. These are the functions most worth testing
// against hostile input, and they can be.

/** A documented field that was absent, the wrong type, or the wrong nullability. */
export class RecordShapeError extends Error {
  /** Dotted path of the offending field, with array indices. Safe to publish. */
  readonly path: string;

  constructor(path: string, expectation: string) {
    super(`${path} must be ${expectation}`);
    this.name = 'RecordShapeError';
    this.path = path;
  }
}

const fail = (path: string, expectation: string): never => {
  throw new RecordShapeError(path, expectation);
};

export type RecordReader<T> = (value: unknown, path: string) => T;

/** The field at `key`, or `undefined` when the record does not carry it. */
export const field = (record: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export function readObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(path, 'an object');
}

/**
 * An array of `item`, read element by element so a refusal names the index.
 *
 * `undefined` is **not** accepted here. Where the source may omit an array
 * entirely, the caller says so explicitly with `readArrayOrEmpty`, which keeps
 * "the source published nothing" and "the source published an empty list" from
 * being decided silently in one place.
 */
export function readArray<T>(value: unknown, path: string, item: RecordReader<T>): readonly T[] {
  if (!Array.isArray(value)) return fail(path, 'an array');
  return Object.freeze(value.map((element, index) => item(element, `${path}[${index}]`)));
}

/** An array the source may omit, which then reads as empty rather than failing. */
export function readArrayOrEmpty<T>(
  value: unknown,
  path: string,
  item: RecordReader<T>,
): readonly T[] {
  return value === undefined || value === null ? Object.freeze([]) : readArray(value, path, item);
}

export function readNumber(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(path, 'a finite number');
}

/**
 * A documented nullable number.
 *
 * `null` is accepted as the answer it is: a mean with no samples, a standard
 * error with fewer than two windows, a rate with a zero denominator. One field in
 * the source can also compute as not-a-number, which JSON carries as `null`, so
 * refusing `null` here would reject real records (v1 open question 6).
 */
export function readNullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return readNumber(value, path);
}

export function readInteger(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : fail(path, 'a whole number');
}

export function readCount(value: unknown, path: string): number {
  const count = readInteger(value, path);
  return count >= 0 ? count : fail(path, 'a count of zero or more');
}

export function readString(value: unknown, path: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fail(path, 'a non-empty string');
}

export function readBoolean(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail(path, 'a boolean');
}

export function readConstant<T extends string>(value: unknown, path: string, expected: T): T {
  return value === expected ? expected : fail(path, `exactly "${expected}"`);
}

/**
 * A time the source recorded, normalized to ISO-8601 UTC.
 *
 * The source is not consistent about format. Most times are ISO strings, but one
 * fallback path in v1 serves a database text cast of a timestamp, which is not
 * guaranteed to carry `T` and `Z` (v1 open question 2). Normalizing here is the
 * decision for #210: a client gets one format, and the instant is the source's
 * own — never this service's clock.
 */
export function readSourceTime(value: unknown, path: string): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fail(path, 'a valid time') : value.toISOString();
  }
  if (typeof value !== 'string' || value.length === 0) return fail(path, 'a time');
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fail(path, 'a valid time') : parsed.toISOString();
}

/** A field the source may omit. An explicit `null` is omission too. */
export function readOptional<T>(
  value: unknown,
  path: string,
  reader: RecordReader<T>,
): T | undefined {
  return value === undefined || value === null ? undefined : reader(value, path);
}

/**
 * Optional, but `null` is a value rather than an omission.
 *
 * Two of the path-diagnostic fields are documented as absent on older records
 * *and* nullable on newer ones, so the two cases cannot be collapsed.
 */
export function readOptionalNullableNumber(
  value: unknown,
  path: string,
): number | null | undefined {
  return value === undefined ? undefined : readNullableNumber(value, path);
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/u;

/** `-0` and `1.50` and `01` all normalize to the form `String(Number(…))` uses. */
function normalizedDecimal(text: string): string {
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = digits.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/u, '');
  const trimmedFraction = fraction.replace(/0+$/u, '');
  const magnitude = trimmedFraction === '' ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
  return magnitude === '0' ? '0' : `${negative ? '-' : ''}${magnitude}`;
}

/**
 * A JSON number from the exact value the source stored.
 *
 * The projection keeps money as 64-bit integers and prices, quantities and
 * amounts as arbitrary-precision decimals, and the port carries both without loss
 * — a `bigint` and a verbatim string. A response has to be JSON, and parity with
 * v1 means a number rather than a string, because every client of this data
 * divides by 100 and formats.
 *
 * So the conversion happens here, once, and **refuses rather than rounds**. A
 * value that cannot be represented exactly as a double is a value this
 * representation cannot carry, and silently shortening someone's balance is the
 * failure mode this port exists to avoid. In practice nothing reaches the limit:
 * it is reached at roughly ninety trillion cents, or by a decimal with more than
 * seventeen significant digits.
 */
export function readExactNumber(value: bigint | string, path: string): number {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : fail(path, 'an amount this contract can carry exactly');
  }

  const text = value.trim();
  if (!DECIMAL.test(text)) return fail(path, 'a decimal amount');
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fail(path, 'a finite amount');
  return normalizedDecimal(text) === normalizedDecimal(String(parsed))
    ? parsed
    : fail(path, 'an amount this contract can carry exactly');
}
