// RFC 8785 JSON canonicalisation and the digests the M1 catalog derives from it.
//
// The catalog's canonical encoding is the foundation every other adapter here
// stands on: `grantKey`, `approvalBodyDigest` and `consentDigest` are all
// SHA-256 over these exact bytes, so a serialisation difference is an
// authorisation difference. See
// `docs/operations/production-control-plane.md#consent-artifact-and-owner-binding`.
//
// Deliberately strict rather than lenient. A value this module cannot encode
// exactly is refused instead of encoded approximately, because an approximate
// preimage silently changes a grant key.

import { createHash } from 'node:crypto';

// The catalog allows "finite integers for counts" and says nothing about
// fractions. Serialising an ES double per RFC 8785 section 3.2.2.3 is subtle
// enough that getting it wrong would be invisible; refusing is honest.
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;

export class CanonicalEncodingError extends Error {
  constructor(message, path) {
    super(path ? `${message} at ${path}` : message);
    this.name = 'CanonicalEncodingError';
    this.path = path ?? '';
  }
}

function encode(value, path) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalEncodingError('non-finite numbers cannot be canonicalised', path);
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalEncodingError('only integer numbers are canonicalised', path);
      }
      if (Math.abs(value) > MAX_EXACT_INTEGER) {
        throw new CanonicalEncodingError('integer exceeds the exactly representable range', path);
      }
      // `-0` and `0` must not produce different preimages.
      return String(value === 0 ? 0 : value);
    case 'string':
      // ES2019 well-formed `JSON.stringify` is exactly RFC 8785 section 3.2.2.2,
      // including lone-surrogate escaping.
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalEncodingError('undefined is not a canonical value; use null', path);
    case 'bigint':
      throw new CanonicalEncodingError('bigint is not a canonical value', path);
    default:
      break;
  }

  if (typeof value !== 'object') {
    throw new CanonicalEncodingError(`${typeof value} is not a canonical value`, path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => encode(entry, `${path}[${index}]`)).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalEncodingError('only plain objects are canonicalised', path);
  }

  const keys = Object.keys(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new CanonicalEncodingError('symbol keys are not canonical', path);
  }

  // RFC 8785 sorts by UTF-16 code unit, which is the default `Array#sort` order
  // for strings. Spelled out so a future "friendlier" comparator is a visible
  // change rather than a silent one.
  const ordered = [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${ordered
    .map((key) => `${JSON.stringify(key)}:${encode(value[key], path ? `${path}.${key}` : key)}`)
    .join(',')}}`;
}

/** Canonical RFC 8785 text for `value`. Throws rather than approximating. */
export function canonicalize(value) {
  return encode(value, '');
}

/** Lowercase SHA-256 hex of the UTF-8 bytes of `text`, with no trailing newline. */
export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Lowercase SHA-256 hex over the canonical encoding of `value`. */
export function canonicalDigest(value) {
  return sha256Hex(canonicalize(value));
}

export const isSha256Hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const isGitObjectId = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/**
 * Returns the keys of `value` that are not in `allowed`.
 *
 * Unknown fields deny under the catalog, so callers treat a non-empty result as
 * a refusal rather than as something to strip and continue with.
 */
export function unknownKeys(value, allowed) {
  const permitted = new Set(allowed);
  return Object.keys(value ?? {}).filter((key) => !permitted.has(key));
}

/** Returns the entries of `required` that `value` does not carry at all. */
export function missingKeys(value, required) {
  const present = new Set(Object.keys(value ?? {}));
  // Field omission is not null substitution: a key present with value `null`
  // counts as present, an absent key does not.
  return [...required].filter((key) => !present.has(key));
}
