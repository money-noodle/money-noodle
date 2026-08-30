import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformPageContent } from '../presentation/platform-page-content';
import RootLayout, { metadata } from './layout';
import PlatformPage from './page';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PlatformPage', () => {
  it('renders an accessible API-provided observation with source time', async () => {
    const page = await PlatformPageContent({
      loadStatus: async () => ({
        asOf: '2026-08-29T20:00:00.000Z',
        serviceVersion: 'git-abc1234',
        state: 'available',
      }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain('<main>');
    expect(markup).toContain('<h1>Money Noodle</h1>');
    expect(markup).toContain('aria-labelledby="status-title"');
    expect(markup).toContain('<h2 id="status-title">Available</h2>');
    expect(markup).toContain(
      '<time dateTime="2026-08-29T20:00:00.000Z">2026-08-29T20:00:00.000Z</time>',
    );
    expect(markup).toContain('<dt>API version</dt><dd>git-abc1234</dd>');
  });

  it('renders unknown without a stale source time when production configuration is invalid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLATFORM_API_ORIGIN', 'not-an-origin');

    const markup = renderToStaticMarkup(await PlatformPage());

    expect(markup).toContain('<h2 id="status-title">Status unknown</h2>');
    expect(markup).not.toContain('<time');
    expect(markup).not.toContain('<dt>API version</dt>');
  });

  it('wraps content in the accessible English document shell', async () => {
    const page = await PlatformPageContent({ loadStatus: async () => undefined });
    const markup = renderToStaticMarkup(<RootLayout>{page}</RootLayout>);

    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain('<body><main>');
    expect(metadata.title).toBe('Money Noodle');
  });
});
