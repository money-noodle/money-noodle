// What a public feed failure is allowed to say.
//
// The same discipline the projection adapter applies to a driver error, for the same
// reason: an upstream's own words carry its hostname, its URL, its status line and
// sometimes a request identifier, and v1 passed those straight through to callers —
// its hourly route published `"<status> from <hostname>"` as a user-visible reason.
// None of that may reach a response, a log line or a span (SECURITY.md).
//
// So an adapter never re-throws what it caught and never copies a message. Every
// failure becomes one of four codes from the port's own vocabulary, and the original
// is dropped: a `cause` chain would travel with the error and undo the point.

import { type FeedFailureCode } from '../../domain/market-feeds.js';

const SAFE_MESSAGES: Readonly<Record<FeedFailureCode, string>> = Object.freeze({
  'upstream-invalid': 'An upstream feed returned a payload this API does not understand.',
  'upstream-rate-limited': 'An upstream feed declined the request for rate reasons.',
  'upstream-timeout': 'An upstream feed did not answer within the deadline.',
  'upstream-unavailable': 'An upstream feed could not be reached.',
});

/** A feed failure, safe to print anywhere this service prints. */
export class FeedFailure extends Error {
  readonly code: FeedFailureCode;

  constructor(code: FeedFailureCode) {
    super(SAFE_MESSAGES[code]);
    // Matched structurally by `feedFailureCode`, which is how the cache classifies a
    // failure without importing anything from an adapter it does not own.
    this.name = 'FeedFailure';
    this.code = code;
  }
}

/** The code of a feed failure, or `undefined` for anything else. */
export function feedFailureCode(error: unknown): FeedFailureCode | undefined {
  return error instanceof FeedFailure ? error.code : undefined;
}
