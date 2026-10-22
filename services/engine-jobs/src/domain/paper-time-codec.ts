// Representation only: no store, source receipt, current authority or runtime admission.
// Source observations use the existing exact JS ISO-millisecond contract. Database
// cutoff/record/control clocks must arrive as exact signed epoch-microsecond TEXT,
// extracted in PostgreSQL before any driver Date/Number conversion.
const MAX_SOURCE_MS = 8_640_000_000_000_000;
const MAX_DB_MICROSECONDS = 8_640_000_000_000_000_000n;
export function decodePaperDbMicroseconds(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/.test(value))
    return undefined;
  const time = BigInt(value);
  return time >= -MAX_DB_MICROSECONDS && time <= MAX_DB_MICROSECONDS ? time : undefined;
}
export function paperSourceIsoToDbMicroseconds(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || value.length > 27) return undefined;
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_SOURCE_MS) return undefined;
  return new Date(ms).toISOString() === value ? BigInt(ms) * 1000n : undefined;
}
export function comparePaperDbTimes(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = decodePaperDbMicroseconds(left),
    b = decodePaperDbMicroseconds(right);
  if (a === undefined || b === undefined) return undefined;
  return a < b ? -1 : a > b ? 1 : 0;
}
// This refuses non-millisecond-aligned DB instants; NEVER floor/truncate them into
// an apparently canonical source observation or fresh/current-authority clock.
export function paperDbTimeToSourceIso(value: unknown): string | undefined {
  const microseconds = decodePaperDbMicroseconds(value);
  if (microseconds === undefined || microseconds % 1000n !== 0n) return undefined;
  return new Date(Number(microseconds / 1000n)).toISOString();
}
export function paperSourceAtOrBeforeDbCutoff(
  source: unknown,
  cutoff: unknown,
): boolean | undefined {
  const observed = paperSourceIsoToDbMicroseconds(source),
    bound = decodePaperDbMicroseconds(cutoff);
  if (observed === undefined || bound === undefined) return undefined;
  return observed <= bound;
}
// The finite domain is explicit JS Date representability, NOT every PostgreSQL
// timestamp. Invalid/unsupported precision or range stays unavailable, not zero.
// JSON transport must retain integer TEXT; callers cannot stringify a rounded
// driver Number/Date and claim original precision. No chronology/CAS proof here.
