// The only outbound HTTP this service does, and the limits it does it under.
//
// Built-in `fetch`, no SDK, no retry. The bounds are the interesting part, because a
// public read endpoint over seven third-party providers is an invitation to find out
// what happens when one of them is slow:
//
//   * **A deadline per call.** Four seconds, as v1 used. A caller of this API waits
//     for one upstream round trip at most, not for a chain of them.
//   * **No retry inside a request.** A retry doubles the load on an upstream that is
//     already struggling and doubles the latency of the request that triggered it.
//     Recovery is the cache's last-good value, not a second attempt.
//   * **A concurrency cap across every feed.** The overview touches up to sixteen
//     upstream calls on a cold cache; without a cap one request could open sixteen
//     sockets at once, and a handful of concurrent requests could look like an attack
//     on a provider that has done nothing wrong.
//   * **A response size cap.** A feed that answers with something enormous fails as
//     an unusable payload rather than being parsed into memory.
//
// Nothing here holds a credential. Every endpoint these adapters call is public and
// keyless; a capability that needed a key is out of scope for this slice by decision.

import { FeedFailure } from './feed-failure.js';
import { UPSTREAM_CONCURRENCY_LIMIT, UPSTREAM_TIMEOUT_MS } from '../../domain/market-registry.js';

/** The largest payload a feed may answer with, before it is refused unparsed. */
export const MAX_FEED_BYTES = 4_194_304;

export interface FeedHttpClient {
  readonly getJson: (url: string) => Promise<unknown>;
  readonly getText: (url: string, accept?: string) => Promise<string>;
  readonly postJson: (url: string, body: unknown) => Promise<unknown>;
}

export interface FeedHttpClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBytes?: number;
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
  /**
   * How this service identifies itself to a provider.
   *
   * Generic on purpose: it names the service and a contact-free project URL, carries
   * no deployment, revision or account identifier, and is the same string for every
   * caller. A provider that wants to rate-limit or block this traffic can.
   */
  readonly userAgent?: string;
}

export const DEFAULT_FEED_USER_AGENT =
  'money-noodle-platform-api/1 (+https://github.com/money-noodle/money-noodle)';

/** A permit gate. Bounds sockets across every feed, not per feed. */
function createGate(limit: number): (work: () => Promise<Response>) => Promise<Response> {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  return async (work) => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

/** Everything an upstream can do wrong, reduced to one of four codes. */
function classify(error: unknown): FeedFailure {
  if (error instanceof FeedFailure) return error;
  const name = error instanceof Error ? error.name : '';
  // `AbortSignal.timeout` rejects with `TimeoutError`; an aborted fetch rejects with
  // `AbortError`. Both mean the deadline, not a refusal.
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new FeedFailure('upstream-timeout');
  }
  return new FeedFailure('upstream-unavailable');
}

export function createFeedHttpClient(options: FeedHttpClientOptions = {}): FeedHttpClient {
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_FEED_USER_AGENT;
  const gate = createGate(options.maxConcurrent ?? UPSTREAM_CONCURRENCY_LIMIT);

  const request = async (
    url: string,
    init: { readonly accept: string; readonly body?: string; readonly method: 'GET' | 'POST' },
  ): Promise<string> => {
    let response: Response;
    try {
      response = await gate(async () =>
        call(url, {
          headers: {
            accept: init.accept,
            'user-agent': userAgent,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          method: init.method,
          ...(init.body === undefined ? {} : { body: init.body }),
          // No redirect following into somewhere else's host: every URL here is a
          // literal in this repository and should answer directly.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (error) {
      throw classify(error);
    }

    // A refusal for rate reasons is kept distinct, because it is the one failure a
    // caller of this API can do something about: ask less often.
    if (response.status === 429) throw new FeedFailure('upstream-rate-limited');
    if (!response.ok) throw new FeedFailure('upstream-unavailable');

    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FeedFailure('upstream-invalid');
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw classify(error);
    }
    if (text.length > maxBytes) throw new FeedFailure('upstream-invalid');
    return text;
  };

  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new FeedFailure('upstream-invalid');
    }
  };

  return Object.freeze({
    getJson: async (url: string) =>
      parse(await request(url, { accept: 'application/json', method: 'GET' })),
    getText: async (url: string, accept = 'application/xml, text/xml, */*') =>
      request(url, { accept, method: 'GET' }),
    postJson: async (url: string, body: unknown) =>
      parse(
        await request(url, {
          accept: 'application/json',
          body: JSON.stringify(body),
          method: 'POST',
        }),
      ),
  });
}
