// The one place that knows what a Google Identity Platform token looks like.
//
// Written against `node:crypto` rather than against a provider SDK, for a reason
// that is a repository rule and not a preference: the 2026-09-15 ADR-0007
// amendment permits `google-auth-library` in exactly two files — each project's
// telemetry authentication adapter — and widening that exception to cover
// sign-in would undo the narrowness the amendment exists for. Verifying an
// RS256 JWT against a published certificate set is about a hundred lines of
// well-specified work, so the alternative was a new dependency or a weakened
// rule, and neither is worth it.
//
// What this adapter checks, in order, and refuses on any failure:
//
//   1. three base64url segments, with an `RS256` header naming a `kid`;
//   2. a signature over `header.payload` by the certificate published for that
//      `kid`;
//   3. `iss` exactly equal to the configured issuer;
//   4. `aud` exactly equal to the configured audience;
//   5. `exp` in the future and `iat`/`auth_time` not in the future, each within a
//      small clock skew;
//   6. a second factor actually used for this sign-in.
//
// The order matters: nothing from the payload is read until the signature is
// verified, so an unsigned token can never influence a decision, not even which
// key is fetched — the `kid` comes from the header and is matched against a set
// this service fetched itself.
//
// Every failure returns `null`. The caller turns that into one refusal code. The
// difference between a wrong audience, a stale key and a bad signature is useful
// to an attacker and to nobody else, so it is never returned and never logged.

import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

import type { IdentityTokenVerifier, VerifiedIdentity } from '../../domain/identity.js';

/** Tolerance for the two clocks disagreeing. Small, because both are managed. */
const CLOCK_SKEW_MS = 60_000;

/** A token longer than this is not a token worth parsing. */
const MAX_TOKEN_LENGTH = 8192;

/** Floor on how long a fetched key set is reused when the response says nothing. */
const MIN_KEY_TTL_MS = 60_000;

/** Ceiling, so a long `max-age` cannot pin a revoked key for a day. */
const MAX_KEY_TTL_MS = 6 * 60 * 60 * 1000;

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/u;

export interface GoogleIdentityPlatformVerifierOptions {
  readonly audience: string;
  readonly issuer: string;
  readonly keysUrl: string;
  readonly clock?: { now(): Date };
  /** Test seam. Production passes nothing and gets the global `fetch`. */
  readonly fetchImplementation?: typeof fetch;
}

interface CertificateSet {
  readonly certificates: ReadonlyMap<string, string>;
  readonly expiresAt: number;
}

function decodeSegment(segment: string): unknown {
  if (!JWT_SEGMENT.test(segment)) return null;
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericDate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null;
}

/**
 * Constant-time string comparison for the two claims an attacker controls.
 *
 * `iss` and `aud` are compared this way not because a timing attack on them is
 * likely, but because they are the two values a caller supplies and the cost of
 * being careful is one function.
 */
function equals(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether the provider says a second factor was used for *this* sign-in.
 *
 * Google Identity Platform reports this in the `firebase` claim as
 * `sign_in_second_factor`, alongside a `second_factor_identifier`. Enrolment is
 * not what is being asked: a token from an account with a factor configured but
 * not exercised carries no `sign_in_second_factor`, and is refused.
 */
function secondFactorUsed(payload: Record<string, unknown>): boolean {
  const firebase = payload['firebase'];
  if (!isObject(firebase)) return false;
  const factor = firebase['sign_in_second_factor'];
  return typeof factor === 'string' && factor.length > 0;
}

function parseMaxAge(header: string | null): number | undefined {
  if (header === null) return undefined;
  const match = /max-age\s*=\s*(\d{1,9})/iu.exec(header);
  if (match === null) return undefined;
  const seconds = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function createGoogleIdentityPlatformVerifier(
  options: GoogleIdentityPlatformVerifierOptions,
): IdentityTokenVerifier {
  const now = (): number => (options.clock?.now() ?? new Date()).getTime();
  const fetchImplementation = options.fetchImplementation ?? fetch;

  // One cached set per process, refreshed on expiry. A verifier that fetched the
  // certificate set per sign-in would make the identity provider a dependency of
  // every request rather than of every few hours.
  let cached: CertificateSet | null = null;
  let inFlight: Promise<CertificateSet | null> | null = null;

  const fetchCertificates = async (): Promise<CertificateSet | null> => {
    let response: Response;
    try {
      response = await fetchImplementation(options.keysUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    if (!isObject(body)) return null;

    const certificates = new Map<string, string>();
    for (const [kid, pem] of Object.entries(body)) {
      // A certificate set is the one thing here that is not attacker-supplied, but
      // it is still parsed defensively: a malformed entry is dropped rather than
      // allowed to throw out of the cache refresh. The check is only that the entry
      // is a PEM block — the provider publishes certificates and `createPublicKey`
      // also accepts a bare public key — because the real guard is the signature,
      // and a key that cannot be parsed fails verification a few lines later.
      if (typeof pem === 'string' && pem.includes('-----BEGIN ')) {
        certificates.set(kid, pem);
      }
    }
    if (certificates.size === 0) return null;

    const maxAge = parseMaxAge(response.headers.get('cache-control'));
    const ttl = Math.min(Math.max(maxAge ?? MIN_KEY_TTL_MS, MIN_KEY_TTL_MS), MAX_KEY_TTL_MS);
    return { certificates, expiresAt: now() + ttl };
  };

  const certificatesFor = async (kid: string): Promise<string | null> => {
    const fresh = cached !== null && cached.expiresAt > now();
    if (fresh && cached !== null) {
      const hit = cached.certificates.get(kid);
      if (hit !== undefined) return hit;
      // A `kid` this service has not seen is the normal shape of a key rotation,
      // so a miss against a fresh set is worth one refetch — but only one, which
      // is what the in-flight guard below is for: an unknown `kid` must not let a
      // caller drive a fetch per request.
    }

    inFlight ??= fetchCertificates().finally(() => {
      inFlight = null;
    });
    const refreshed = await inFlight;
    if (refreshed === null) return null;
    cached = refreshed;
    return refreshed.certificates.get(kid) ?? null;
  };

  return {
    async verify(token: string): Promise<VerifiedIdentity | null> {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return null;
      }

      const segments = token.split('.');
      if (segments.length !== 3) return null;
      const [headerSegment, payloadSegment, signatureSegment] = segments as [
        string,
        string,
        string,
      ];
      if (!JWT_SEGMENT.test(signatureSegment)) return null;

      const header = decodeSegment(headerSegment);
      if (!isObject(header)) return null;
      if (header['alg'] !== 'RS256') return null;
      const kid = header['kid'];
      if (typeof kid !== 'string' || kid.length === 0 || kid.length > 128) return null;

      const certificate = await certificatesFor(kid);
      if (certificate === null) return null;

      // Signature first. Nothing below this line would be reached by a token this
      // service's configured provider did not sign.
      let verified: boolean;
      try {
        const key = createPublicKey(certificate);
        verified = createVerify('RSA-SHA256')
          .update(`${headerSegment}.${payloadSegment}`)
          .verify(key, Buffer.from(signatureSegment, 'base64url'));
      } catch {
        // A malformed certificate or signature is an unverified token and nothing
        // more specific. The provider's error text is not read.
        return null;
      }
      if (!verified) return null;

      const payload = decodeSegment(payloadSegment);
      if (!isObject(payload)) return null;

      if (!equals(payload['iss'], options.issuer)) return null;
      if (!equals(payload['aud'], options.audience)) return null;

      const subject = payload['sub'];
      if (typeof subject !== 'string' || subject.length === 0 || subject.length > 128) return null;

      const current = now();
      const expiresAt = numericDate(payload['exp']);
      if (expiresAt === null || expiresAt <= current - CLOCK_SKEW_MS) return null;

      const issuedAt = numericDate(payload['iat']);
      if (issuedAt === null || issuedAt > current + CLOCK_SKEW_MS) return null;

      const authTime = numericDate(payload['auth_time']);
      if (authTime !== null && authTime > current + CLOCK_SKEW_MS) return null;

      return Object.freeze({
        expiresAt: new Date(expiresAt),
        secondFactorUsed: secondFactorUsed(payload),
        subject,
      });
    },
  };
}
