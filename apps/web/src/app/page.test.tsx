import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import RootLayout, { metadata } from './layout';
import FoundationPage from './page';

describe('FoundationPage', () => {
  it('renders a named main landmark without implying platform status', () => {
    const markup = renderToStaticMarkup(<FoundationPage />);

    expect(markup).toContain('<main>');
    expect(markup).toContain('<h1>Money Noodle</h1>');
    expect(markup).not.toMatch(/available|healthy|funded|simulation/i);
  });

  it('wraps content in the accessible English document shell', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <FoundationPage />
      </RootLayout>,
    );

    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain('<body><main>');
    expect(metadata.title).toBe('Money Noodle');
  });
});
