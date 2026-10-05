// Freshness as words, not as a colour.
//
// The decoration is a border and a prefix character; the sentence is the whole statement.
// These assertions are on the sentence, because that is what a reader with a screen reader,
// a monochrome display, or a colour-vision difference receives.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { describeFeed, FeedFreshness } from './feed-freshness';

describe('describeFeed', () => {
  it('states a fresh value with its age', () => {
    expect(
      describeFeed({ ageSeconds: 3, fetchedAt: '2026-10-05T19:30:00.000Z', state: 'fresh' }),
    ).toBe('Fresh: obtained 3 seconds ago.');
  });

  it('states a stale value with its age and why it is stale', () => {
    expect(
      describeFeed({
        ageSeconds: 120,
        fetchedAt: '2026-10-05T19:28:00.000Z',
        reason: 'upstream-timeout',
        state: 'stale',
      }),
    ).toBe('Stale: last obtained 2 minutes ago — the source did not answer in time.');
  });

  it('states an unavailable source, and that nothing from it is shown', () => {
    expect(
      describeFeed({ ageSeconds: 0, reason: 'upstream-rate-limited', state: 'unavailable' }),
    ).toBe(
      'Unavailable — the source declined for rate reasons. No figures from this source are shown.',
    );
  });

  it('says every reason code in words', () => {
    for (const reason of [
      'upstream-invalid',
      'upstream-rate-limited',
      'upstream-timeout',
      'upstream-unavailable',
    ] as const) {
      const sentence = describeFeed({ ageSeconds: 0, reason, state: 'unavailable' });
      expect(sentence).not.toContain(reason);
      expect(sentence.length).toBeGreaterThan(40);
    }
  });
});

describe('FeedFreshness', () => {
  it('carries the label, the sentence and the machine-readable time', () => {
    const markup = renderToStaticMarkup(
      <FeedFreshness
        feed={{ ageSeconds: 30, fetchedAt: '2026-10-05T19:29:30.000Z', state: 'fresh' }}
        label="Spot prices"
      />,
    );
    expect(markup).toContain('Spot prices');
    expect(markup).toContain('Fresh: obtained 30 seconds ago.');
    expect(markup).toContain('dateTime="2026-10-05T19:29:30.000Z"');
    expect(markup).toContain('feed--fresh');
  });

  it('omits the time when the source has no value at all', () => {
    const markup = renderToStaticMarkup(
      <FeedFreshness
        feed={{ ageSeconds: 0, reason: 'upstream-unavailable', state: 'unavailable' }}
        label="Headlines"
      />,
    );
    expect(markup).not.toContain('<time');
    expect(markup).toContain('feed--unavailable');
  });
});
