// Reading an upstream payload without trusting it.
//
// Every provider below answers with JSON this service did not design and cannot
// version. So each field it uses goes through one of these readers, and a field that
// is not what the contract says it is makes that feed `upstream-invalid` — never a
// five hundred, and never a zero standing in for a number that was not there.
//
// That last part is a deliberate break from v1, which defaulted missing provider
// numbers to zero: a real zero and an absent field were then indistinguishable, and
// a published "volume 0" could mean either. Here absent is absent.

import { FeedFailure } from './feed-failure.js';

export type UpstreamRecord = Readonly<Record<string, unknown>>;

const invalid = (): never => {
  throw new FeedFailure('upstream-invalid');
};

export function asRecord(value: unknown): UpstreamRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UpstreamRecord)
    : invalid();
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : invalid();
}

export function asText(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid();
}

/** A number the provider may send as a number or as a decimal string. */
export function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A positive price. Zero is not a price, and the providers use it for "absent". */
export function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/** A bid: a fraction of one dollar, zero included — a bid of nothing is a bid. */
export function optionalBid(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

/** An ask: a fraction of one dollar above zero. Zero means "not offered". */
export function optionalAsk(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed !== undefined && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

/** A time the provider sent as an ISO string or epoch milliseconds. */
export function optionalInstant(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch;
  }
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A field a provider double-encodes as a JSON string inside its JSON. */
export function asEncodedArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return invalid();
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : invalid();
  } catch {
    return invalid();
  }
}

/** Refuses an envelope whose own error field is populated. */
export function assertNoUpstreamErrors(value: unknown): UpstreamRecord {
  const record = asRecord(value);
  const errors = record.error;
  if (Array.isArray(errors) && errors.length > 0) throw new FeedFailure('upstream-invalid');
  return record;
}
