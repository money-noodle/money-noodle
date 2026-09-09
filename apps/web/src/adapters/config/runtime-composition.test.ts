import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlatformPage from '../../app/page';
import { GET as getReadiness } from '../../app/health/ready/route';

vi.mock('server-only', () => ({}));

const production = {
  NODE_ENV: 'production',
  PLATFORM_API_ORIGIN: 'https://api.example.test',
  ARTIFACT_VERSION: 'release-1.2.3',
  MONEY_NOODLE_COMMIT: 'a'.repeat(40),
  MONEY_NOODLE_SERVICE: 'web',
  MONEY_NOODLE_ENVIRONMENT: 'production',
};
function install() {
  for (const [key, value] of Object.entries(production)) vi.stubEnv(key, value);
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('web invocation-time configuration composition', () => {
  it.each(Object.keys(production))(
    'fails closed with no fetch for missing or empty %s',
    async (key) => {
      install();
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal('fetch', fetch);
      for (const value of [undefined, '']) {
        vi.stubEnv(key, value);
        const response = getReadiness();
        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(await response.json()).toMatchObject({ errorCode: 'MN-WEB-NOT-READY', status: 503 });
        const html = renderToStaticMarkup(await PlatformPage());
        expect(html).toContain('Status unknown');
        expect(html).not.toContain('<time');
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['NODE_ENV', 'preview'],
    ['NODE_ENV', 'development'],
    ['MONEY_NOODLE_ENVIRONMENT', 'test'],
    ['MONEY_NOODLE_SERVICE', 'platform-api'],
    ['MONEY_NOODLE_COMMIT', 'private-marker'],
    ['ARTIFACT_VERSION', 'development'],
    ['ARTIFACT_VERSION', '../private-marker'],
    ['PLATFORM_API_ORIGIN', 'https://user:private-marker@api.example.test'],
    ['PLATFORM_API_ORIGIN', 'https://api.example.test/private-marker'],
    ['PLATFORM_API_ORIGIN', 'https://127.0.0.1'],
    ['MONEY_NOODLE_VERSION', 'private-marker'],
    ['MONEY_NOODLE_API_BASE_URL', 'https://private-marker.example.test'],
  ])(
    'rejects invalid %s at both invocation boundaries without fetching or leaking',
    async (key, value) => {
      install();
      vi.stubEnv(key, value);
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal('fetch', fetch);
      const response = getReadiness();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private-marker');
      const html = renderToStaticMarkup(await PlatformPage());
      expect(html).toContain('Status unknown');
      expect(html).not.toContain('<time');
      expect(html).not.toContain('private-marker');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('does not retain an earlier available observation after upstream failure or invalid configuration', async () => {
    install();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          asOf: '2026-08-29T12:34:56.000Z',
          requestId: 'synthetic-request',
          schemaVersion: '1',
          service: { name: 'platform-api', version: 'release-1.2.3' },
          state: 'available',
        }),
      )
      .mockRejectedValue(new Error('private-upstream-marker'));
    vi.stubGlobal('fetch', fetch);
    expect(renderToStaticMarkup(await PlatformPage())).toContain('Available');
    const failed = renderToStaticMarkup(await PlatformPage());
    expect(failed).toContain('Status unknown');
    expect(failed).not.toContain('<time');
    expect(failed).not.toContain('private-upstream-marker');
    vi.stubEnv('MONEY_NOODLE_COMMIT', 'private-config-marker');
    expect(renderToStaticMarkup(await PlatformPage())).toContain('Status unknown');
    const response = getReadiness();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-config-marker');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
