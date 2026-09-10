/* v8 ignore file -- @preserve -- Test-only bridge, executed by the dedicated runtime-contract Vitest config. */
import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlatformPage from '../../app/page';
import { GET as getLiveness } from '../../app/health/live/route';
import { GET as getReadiness } from '../../app/health/ready/route';
import { readRuntimeConfig } from './read-runtime-config';

vi.mock('server-only', () => ({}));

interface Rendering {
  run: string;
  env: Record<string, string>;
  image: string;
  port: number;
  livePath: string;
  readyPath: string;
  expected: { version: string; sourceCommit: string; digest: string; origin: string };
}
const path = process.env.RUNTIME_CONTRACT_RENDERING;
if (!path) throw new Error('Evaluated runtime configuration is required; no fixture fallback.');
const { web }: { web: Rendering[] } = JSON.parse(readFileSync(path, 'utf8'));

function install(env: Record<string, string>) {
  for (const key of Object.keys(process.env)) {
    if (/^(NODE_ENV|ARTIFACT_VERSION|PLATFORM_API_ORIGIN|MONEY_NOODLE_|OTEL_)/u.test(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

const status = {
  asOf: '2026-08-29T12:34:56.000Z',
  requestId: 'synthetic-request',
  schemaVersion: '1',
  service: { name: 'platform-api', version: 'release-1.2.3+api' },
  state: 'available',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(web)('evaluated web $run', (rendering) => {
  it('feeds actual page/probes and keeps source SHA, image and topology server-only', async () => {
    install(rendering.env);
    const config = readRuntimeConfig(process.env);
    expect(config.sourceCommit).toBe(rendering.expected.sourceCommit);
    expect(config.service).toEqual({ name: 'web', version: rendering.expected.version });
    expect(config.platformApiOrigin).toBe(rendering.expected.origin);
    expect(rendering.image.endsWith(`@${rendering.expected.digest}`)).toBe(true);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(status));
    vi.stubGlobal('fetch', fetch);
    const probes = { '/health/live': getLiveness, '/health/ready': getReadiness };
    for (const probe of [rendering.livePath, rendering.readyPath]) {
      const response = probes[probe as keyof typeof probes]();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        service: 'web',
        version: rendering.expected.version,
        status: probe === rendering.livePath ? 'live' : 'ready',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(await PlatformPage());
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(`${rendering.expected.origin}/v1/platform/status`);
    expect(request.cache).toBe('no-store');
    expect(html).toContain('Available');
    expect(html).toContain(status.asOf);
    for (const value of [
      config.sourceCommit,
      config.platformApiOrigin,
      rendering.image,
      'MONEY_NOODLE_',
      'OTEL_',
    ]) {
      expect(html).not.toContain(value);
    }
  });

  it.each(['unavailable', 'timeout', 'malformed', 'incompatible'])(
    'renders unknown for %s without retry or stale success',
    async (failure) => {
      install(rendering.env);
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (failure === 'unavailable') fetch.mockRejectedValue(new Error('private-upstream-marker'));
      if (failure === 'timeout')
        fetch.mockImplementation(
          (input) =>
            new Promise((_resolve, reject) => {
              (input as Request).signal.addEventListener(
                'abort',
                () => reject(new Error('private-timeout-marker')),
                { once: true },
              );
            }),
        );
      if (failure === 'malformed') fetch.mockResolvedValue(Response.json({ state: 'available' }));
      if (failure === 'incompatible')
        fetch.mockResolvedValue(Response.json({ ...status, schemaVersion: '2' }));
      vi.stubGlobal('fetch', fetch);
      const html = renderToStaticMarkup(await PlatformPage());
      expect(html).toContain('Status unknown');
      expect(html).not.toContain(status.asOf);
      expect(html).not.toContain('private-');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((fetch.mock.calls[0]?.[0] as Request).url).toBe(
        `${rendering.expected.origin}/v1/platform/status`,
      );
    },
  );

  it('validates each invocation and proves liveness alone cannot establish readiness', async () => {
    install(rendering.env);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(status));
    vi.stubGlobal('fetch', fetch);
    expect(getReadiness().status).toBe(200);
    vi.stubEnv('PLATFORM_API_ORIGIN', undefined);
    expect(getLiveness().status).toBe(200);
    const response = getReadiness();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(rendering.expected.sourceCommit);
    expect(renderToStaticMarkup(await PlatformPage())).toContain('Status unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
});
