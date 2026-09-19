import { describe, expect, it, vi } from 'vitest';

import { createTelemetryDegradation } from './telemetry-degradation.js';
import { TELEMETRY_LIMITS } from './telemetry-limits.js';
import {
  TelemetryEndpointError,
  assertApprovedTelemetryEndpoint,
  createWorkloadIdentityHeaders,
  type TelemetryTokenSource,
} from './workload-identity-headers.js';

// Assembled at runtime from inert fragments: no credential-shaped literal is
// written to this file, and none is snapshotted.
const syntheticToken = (suffix = '1') => ['ya', '29', '.', 'x'.repeat(40), suffix].join('');
const bearerPrefix = ['Bear', 'er'].join('');

const APPROVED = 'https://telemetry.googleapis.com';

function credentialedUrl(): string {
  const url = new URL(APPROVED);
  url.username = 'user';
  url.password = 'secret';
  return url.toString();
}

describe('assertApprovedTelemetryEndpoint', () => {
  it('accepts the approved HTTPS Google telemetry origin', () => {
    expect(assertApprovedTelemetryEndpoint(APPROVED).hostname).toBe('telemetry.googleapis.com');
  });

  it.each([
    ['a credential-bearing URL', credentialedUrl()],
    ['a plaintext URL', 'http://telemetry.googleapis.com'],
    ['an unapproved host', 'https://telemetry.invalid'],
    ['a query string', 'https://telemetry.googleapis.com/?project=example-project'],
    ['a fragment', 'https://telemetry.googleapis.com/#x'],
    ['a non-URL', 'telemetry.googleapis.com'],
  ])('refuses %s', (_label, raw) => {
    expect(() => assertApprovedTelemetryEndpoint(raw)).toThrow(TelemetryEndpointError);
  });

  it('refuses a credential-bearing loopback URL even under the test seam', () => {
    const url = new URL('http://127.0.0.1:4318');
    url.username = 'user';
    url.password = 'secret';
    expect(() =>
      assertApprovedTelemetryEndpoint(url.toString(), { allowLoopbackForTests: true }),
    ).toThrow(TelemetryEndpointError);
  });

  it('permits a loopback sink only under the explicit test seam', () => {
    expect(() => assertApprovedTelemetryEndpoint('http://127.0.0.1:4318')).toThrow();
    expect(
      assertApprovedTelemetryEndpoint('http://127.0.0.1:4318', { allowLoopbackForTests: true })
        .hostname,
    ).toBe('127.0.0.1');
  });
});

function sourceReturning(
  tokens: readonly string[],
  options: { readonly expiresInMillis?: number; readonly now?: () => number } = {},
): { source: TelemetryTokenSource; calls: () => number } {
  let index = 0;
  const now = options.now ?? Date.now;
  return {
    calls: () => index,
    source: {
      async fetchToken() {
        const value = tokens[Math.min(index, tokens.length - 1)] ?? '';
        index += 1;
        return { expiresAtMillis: now() + (options.expiresInMillis ?? 3_600_000), value };
      },
    },
  };
}

describe('createWorkloadIdentityHeaders', () => {
  it('attaches a bearer credential and the quota project to the approved origin', async () => {
    const token = syntheticToken();
    const { source } = sourceReturning([token]);
    const factory = createWorkloadIdentityHeaders({
      degradation: createTelemetryDegradation(),
      endpoint: assertApprovedTelemetryEndpoint(APPROVED),
      quotaProject: 'example-project',
      tokenSource: source,
    });

    const headers = await factory.headers();
    expect(headers.authorization).toBe(`${bearerPrefix} ${token}`);
    expect(headers['x-goog-user-project']).toBe('example-project');
  });

  it('never attaches a credential to a loopback sink', async () => {
    const { source, calls } = sourceReturning([syntheticToken()]);
    const factory = createWorkloadIdentityHeaders({
      degradation: createTelemetryDegradation(),
      endpoint: assertApprovedTelemetryEndpoint('http://127.0.0.1:4318', {
        allowLoopbackForTests: true,
      }),
      tokenSource: source,
    });

    expect(await factory.headers()).toEqual({});
    // Not merely withheld from the header: never minted at all.
    expect(calls()).toBe(0);
  });

  it('coalesces concurrent acquisitions into a single in-flight request', async () => {
    let resolve: ((value: { expiresAtMillis: number; value: string }) => void) | undefined;
    let calls = 0;
    const source: TelemetryTokenSource = {
      fetchToken() {
        calls += 1;
        return new Promise((r) => {
          resolve = r;
        });
      },
    };
    const factory = createWorkloadIdentityHeaders({
      degradation: createTelemetryDegradation(),
      endpoint: assertApprovedTelemetryEndpoint(APPROVED),
      tokenSource: source,
    });

    const pending = [factory.headers(), factory.headers(), factory.headers()];
    await vi.waitFor(() => expect(resolve).toBeDefined());
    resolve?.({ expiresAtMillis: Date.now() + 3_600_000, value: syntheticToken() });
    const results = await Promise.all(pending);

    expect(calls).toBe(1);
    for (const headers of results) expect(headers.authorization).toBeDefined();
  });

  it('caches a fresh token and refreshes one inside the skew window', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const { source, calls } = sourceReturning([syntheticToken('1'), syntheticToken('2')], {
      // Expires just outside the skew window, so the first call caches.
      expiresInMillis: TELEMETRY_LIMITS.tokenRefreshSkewMillis + 10_000,
      now,
    });
    const factory = createWorkloadIdentityHeaders({
      degradation: createTelemetryDegradation(),
      endpoint: assertApprovedTelemetryEndpoint(APPROVED),
      now,
      tokenSource: source,
    });

    const first = await factory.headers();
    expect(await factory.headers()).toEqual(first);
    expect(calls()).toBe(1);

    // Move inside the refresh skew: the next export must not use a token that
    // would expire mid-flight.
    clock += 11_000;
    const refreshed = await factory.headers();
    expect(calls()).toBe(2);
    expect(refreshed.authorization).not.toBe(first.authorization);

    factory.reset();
    await factory.headers();
    expect(calls()).toBe(3);
  });

  it('returns no header and records degradation when the token source fails', async () => {
    const degradation = createTelemetryDegradation();
    const factory = createWorkloadIdentityHeaders({
      degradation,
      endpoint: assertApprovedTelemetryEndpoint(APPROVED),
      tokenSource: {
        async fetchToken() {
          throw new Error('metadata-unavailable');
        },
      },
    });

    // The exporter contract forbids a throwing headers factory.
    await expect(factory.headers()).resolves.toEqual({});
    expect(degradation.snapshot()).toContainEqual({
      occurrences: 1,
      reason: 'auth-token-unavailable',
      signal: 'auth',
    });
  });

  it('bounds the underlying work and classifies a timeout', async () => {
    const degradation = createTelemetryDegradation();
    let observed: AbortSignal | undefined;
    const factory = createWorkloadIdentityHeaders({
      degradation,
      endpoint: assertApprovedTelemetryEndpoint(APPROVED),
      tokenSource: {
        fetchToken(signal) {
          observed = signal;
          // Never resolves on its own: only the deadline can end this.
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      },
    });

    vi.useFakeTimers();
    try {
      const pending = factory.headers();
      await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.tokenTimeoutMillis + 1);
      await expect(pending).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }

    // The signal proves the work was cancelled, not merely abandoned.
    expect(observed?.aborted).toBe(true);
    expect(degradation.snapshot()).toContainEqual({
      occurrences: 1,
      reason: 'auth-token-timeout',
      signal: 'auth',
    });
  });

  it('treats an empty token as unavailable rather than attaching an empty credential', async () => {
    const degradation = createTelemetryDegradation();
    const factory = createWorkloadIdentityHeaders({
      degradation,
      endpoint: assertApprovedTelemetryEndpoint(APPROVED),
      tokenSource: sourceReturning(['']).source,
    });
    await expect(factory.headers()).resolves.toEqual({});
    expect(degradation.degraded).toBe(true);
  });
});
