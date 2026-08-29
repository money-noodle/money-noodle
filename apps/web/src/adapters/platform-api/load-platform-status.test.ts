import { describe, expect, it, vi } from 'vitest';

import { createCorrelationContext, loadPlatformStatus } from './load-platform-status';

const correlation = {
  requestId: 'web-request-123',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};
const validStatus = {
  asOf: '2026-08-29T20:00:00.000Z',
  requestId: 'web-request-123',
  schemaVersion: '1',
  service: { name: 'platform-api', version: 'git-abc1234' },
  state: 'available',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    status,
  });
}

describe('loadPlatformStatus', () => {
  it('uses the generated operation once with bounded correlation and no caching', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse(validStatus));

    await expect(
      loadPlatformStatus({
        baseUrl: 'https://api.example.test',
        correlation,
        fetch: fetchImplementation,
      }),
    ).resolves.toEqual({
      asOf: validStatus.asOf,
      serviceVersion: 'git-abc1234',
      state: 'available',
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const request = fetchImplementation.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe('https://api.example.test/v1/platform/status');
    expect((request as Request).cache).toBe('no-store');
    expect((request as Request).headers.get('traceparent')).toBe(correlation.traceparent);
    expect((request as Request).headers.get('x-request-id')).toBe(correlation.requestId);
  });

  it.each([
    ['unavailable API', async () => Promise.reject(new Error('network unavailable'))],
    ['malformed response', async () => jsonResponse({ ...validStatus, state: 'unknown' })],
    ['incompatible schema', async () => jsonResponse({ ...validStatus, schemaVersion: '2' })],
    [
      'problem response',
      async () =>
        jsonResponse(
          {
            errorCode: 'MN-INTERNAL-ERROR',
            requestId: 'api-request',
            status: 500,
            title: 'Internal Server Error',
            type: 'about:blank',
          },
          500,
        ),
    ],
  ])('maps %s to unknown without retry', async (_name, implementation) => {
    const fetchImplementation = vi.fn<typeof fetch>(implementation);

    await expect(
      loadPlatformStatus({
        baseUrl: 'https://api.example.test',
        correlation,
        fetch: fetchImplementation,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('maps a bounded timeout to unknown without retry', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = input instanceof Request ? input.signal : init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    await expect(
      loadPlatformStatus({
        baseUrl: 'https://api.example.test',
        correlation,
        fetch: fetchImplementation,
        timeoutMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('creates W3C-compatible random correlation values', () => {
    const created = createCorrelationContext();

    expect(created.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u);
  });
});
