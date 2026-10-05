// The outbound client, against a fetch the test provides.
//
// Two groups of cases. The first is what the client sends: a generic identity, no
// credential of any kind, no redirect following, and a deadline on every call. The
// second is what it does with an answer it does not like — each one has to become one
// of four codes, because those four are the only things a public response may say.

import { describe, expect, it, vi } from 'vitest';

import { FeedFailure } from './feed-failure.js';
import {
  createFeedHttpClient,
  DEFAULT_FEED_USER_AGENT,
  MAX_FEED_BYTES,
} from './feed-http-client.js';

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), init);

/** Rejects with an error named like the one the platform raises for a deadline. */
const named = (name: string): Error => {
  const error = new Error('whatever the runtime said, with a host in it');
  error.name = name;
  return error;
};

describe('createFeedHttpClient', () => {
  it('identifies itself generically and carries no credential', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    await client.getJson('https://provider.example/data');

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://provider.example/data');
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toBe(DEFAULT_FEED_USER_AGENT);
    expect(headers.accept).toBe('application/json');
    // Nothing that could be a secret, and no deployment or account identifier.
    expect(Object.keys(headers).sort()).toEqual(['accept', 'user-agent']);
    expect(DEFAULT_FEED_USER_AGENT).not.toMatch(/key|token|secret|@/iu);
    // A public endpoint should answer directly; a redirect is refused rather than
    // followed to somewhere this repository never named.
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe('GET');
  });

  it('posts a JSON body for the read that needs one', async () => {
    const fetch = vi.fn(async () => json([{ asset_id: 'token' }]));
    const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    await client.postJson('https://provider.example/books', [{ token_id: 'token' }]);

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('[{"token_id":"token"}]');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('asks for XML on the document read', async () => {
    const fetch = vi.fn(async () => new Response('<rss></rss>'));
    const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    expect(await client.getText('https://provider.example/rss')).toBe('<rss></rss>');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).accept).toContain('xml');
  });

  const refusals: readonly [string, Response | Error, string][] = [
    ['a rate refusal', new Response('slow down', { status: 429 }), 'upstream-rate-limited'],
    ['a server error', new Response('boom', { status: 503 }), 'upstream-unavailable'],
    ['a deadline', named('TimeoutError'), 'upstream-timeout'],
    ['an abort', named('AbortError'), 'upstream-timeout'],
    ['a refused connection', named('TypeError'), 'upstream-unavailable'],
  ];

  for (const [label, outcome, code] of refusals) {
    it(`reduces ${label} to ${code}`, async () => {
      const fetch = vi.fn(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });

      const failure = await client
        .getJson('https://provider.example/data')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FeedFailure);
      expect((failure as FeedFailure).code).toBe(code);
      // Whatever the runtime said about the host stays inside the adapter.
      expect((failure as FeedFailure).message).not.toContain('host');
    });
  }

  it('refuses a payload that is not JSON', async () => {
    const fetch = vi.fn(async () => new Response('<html>not json</html>'));
    const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.getJson('https://provider.example/data')).rejects.toMatchObject({
      code: 'upstream-invalid',
    });
  });

  it('refuses a payload that declares itself too large, unparsed', async () => {
    const fetch = vi.fn(
      async () => new Response('{}', { headers: { 'content-length': String(MAX_FEED_BYTES + 1) } }),
    );
    const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.getJson('https://provider.example/data')).rejects.toMatchObject({
      code: 'upstream-invalid',
    });
  });

  it('refuses a payload that turns out to be too large', async () => {
    const fetch = vi.fn(async () => new Response('"' + 'x'.repeat(64) + '"'));
    const client = createFeedHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxBytes: 16,
    });
    await expect(client.getJson('https://provider.example/data')).rejects.toMatchObject({
      code: 'upstream-invalid',
    });
  });

  it('refuses a body that fails while being read', async () => {
    const fetch = vi.fn(
      async () =>
        ({
          headers: new Headers(),
          ok: true,
          status: 200,
          text: async () => {
            throw named('TimeoutError');
          },
        }) as unknown as Response,
    );
    const client = createFeedHttpClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.getJson('https://provider.example/data')).rejects.toMatchObject({
      code: 'upstream-timeout',
    });
  });

  it('holds concurrent calls to the cap', async () => {
    let active = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const fetch = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return json({ ok: true });
    });
    const client = createFeedHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxConcurrent: 2,
    });

    const calls = Promise.all(
      Array.from({ length: 5 }, async () => client.getJson('https://provider.example/data')),
    );
    // Let every queued call reach the gate, then drain it one permit at a time.
    for (let drained = 0; drained < 5; drained += 1) {
      await Promise.resolve();
      release.shift()?.();
      await Promise.resolve();
    }
    while (release.length > 0) {
      release.shift()?.();
      await Promise.resolve();
    }
    await calls;

    // Without the cap one request could open a socket per feed per asset, which looks
    // like an attack on a provider that has done nothing wrong.
    expect(peak).toBeLessThanOrEqual(2);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('applies the deadline it was configured with', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(named('TimeoutError'));
        });
        setTimeout(resolve, 5_000);
      });
      return json({ ok: true });
    });
    const client = createFeedHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 5,
    });

    await expect(client.getJson('https://provider.example/data')).rejects.toMatchObject({
      code: 'upstream-timeout',
    });
  });
});
