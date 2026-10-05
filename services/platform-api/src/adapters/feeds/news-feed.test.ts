// The headline reader, against synthetic RSS.
//
// The documents here are written for this test. Three of the cases are the reason this
// parser is hand-rolled rather than a library: a nested entity, a declared entity, and
// markup inside a title. None of them may reach a caller as anything but plain text,
// and none of them may make the reader expand anything.

import { describe, expect, it } from 'vitest';

import { MAX_HEADLINES } from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  createNewsFeed,
  MAX_HEADLINE_LENGTH,
  plainText,
  publishedAt,
  readHeadlines,
  safeLink,
} from './news-feed.js';

const item = (
  title: string,
  link = 'https://news.example.com/story',
  pubDate = 'Sun, 05 Oct 2026 17:00:00 GMT',
): string =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate></item>`;

const document = (...items: readonly string[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;

describe('plainText', () => {
  it('unwraps a section marked as character data', () => {
    expect(plainText('<![CDATA[A plain headline]]>')).toBe('A plain headline');
  });

  it('decodes the fixed entity table once and never again', () => {
    expect(plainText('Ether &amp; Bitcoin')).toBe('Ether & Bitcoin');
    expect(plainText('&quot;quoted&quot; and &#39;quoted&#39;')).toBe('"quoted" and \'quoted\'');
    // One pass: the decoded `&` does not combine with what follows it into a second
    // entity, so a nested entity cannot be expanded by repetition.
    expect(plainText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('removes markup, including markup that arrived encoded', () => {
    expect(plainText('<b>Bold</b> headline')).toBe('Bold headline');
    expect(plainText('&lt;img src=x onerror=alert(1)&gt;Headline')).toBe('Headline');
    expect(plainText('<script>alert(1)</script>Headline')).toBe('alert(1) Headline');
  });

  it('expands nothing a document declares for itself', () => {
    // No DTD handling at all: an entity this table does not contain is left as text,
    // so there is nothing for a billion-laughs document to expand.
    const bomb = '&lol9; &lol9; &lol9;';
    expect(plainText(bomb)).toBe(bomb);
  });

  it('bounds the length and collapses whitespace', () => {
    expect(plainText('  spaced \n out  ')).toBe('spaced out');
    const long = plainText('x'.repeat(MAX_HEADLINE_LENGTH + 100));
    expect(long).toHaveLength(MAX_HEADLINE_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(plainText(undefined)).toBe('');
  });
});

describe('safeLink', () => {
  it('publishes only a link a caller may follow', () => {
    expect(safeLink('https://news.example.com/story')).toBe('https://news.example.com/story');
    expect(safeLink('http://news.example.com/story')).toBe('http://news.example.com/story');
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,hi', 'not a url', '']) {
      expect(safeLink(unsafe)).toBeUndefined();
    }
  });
});

describe('publishedAt', () => {
  it('normalizes the publisher string, or says nothing', () => {
    expect(publishedAt('Sun, 05 Oct 2026 17:00:00 GMT')?.toISOString()).toBe(
      '2026-10-05T17:00:00.000Z',
    );
    expect(publishedAt('whenever')).toBeUndefined();
    expect(publishedAt(undefined)).toBeUndefined();
  });
});

describe('readHeadlines', () => {
  it('keeps the published order and reads the three fields', () => {
    const headlines = readHeadlines(
      document(item('First story'), item('Second story', 'https://news.example.com/second')),
    );
    expect(headlines).toEqual([
      {
        link: 'https://news.example.com/story',
        publishedAt: new Date('2026-10-05T17:00:00.000Z'),
        title: 'First story',
      },
      {
        link: 'https://news.example.com/second',
        publishedAt: new Date('2026-10-05T17:00:00.000Z'),
        title: 'Second story',
      },
    ]);
  });

  it('caps the list', () => {
    const headlines = readHeadlines(
      document(...Array.from({ length: 40 }, (_, index) => item(`Story ${index}`))),
    );
    expect(headlines).toHaveLength(MAX_HEADLINES);
    expect(headlines[0]?.title).toBe('Story 0');
  });

  it('drops an item with nothing to publish and keeps one with a bad link', () => {
    const headlines = readHeadlines(
      document(
        item(''),
        item('<![CDATA[   ]]>'),
        item('Usable story', 'javascript:alert(1)', 'not a date'),
      ),
    );
    expect(headlines).toEqual([{ title: 'Usable story' }]);
  });

  it('takes the first occurrence of each field inside its own item', () => {
    const headlines = readHeadlines(
      document(
        '<item><title>First title</title><title>Second title</title>' +
          '<link>https://news.example.com/a</link></item>',
      ),
    );
    expect(headlines[0]?.title).toBe('First title');
    expect(headlines[0]?.link).toBe('https://news.example.com/a');
  });

  it('refuses a document with no items in it', () => {
    // Either the publisher changed shape or something else answered.
    expect(() => readHeadlines('<html><body>Not a feed</body></html>')).toThrow(FeedFailure);
    expect(() => readHeadlines(document())).toThrow(FeedFailure);
  });

  it('derives no sentiment, score or label', () => {
    const headlines = readHeadlines(document(item('Bitcoin crash wipes out gains amid lawsuit')));
    // v1 scored this lexically and published a label beside market data.
    expect(Object.keys(headlines[0] ?? {}).sort()).toEqual(['link', 'publishedAt', 'title']);
  });
});

describe('createNewsFeed', () => {
  it('reads the one public document', async () => {
    const urls: string[] = [];
    const client: FeedHttpClient = {
      getJson: async () => undefined,
      getText: async (url: string) => {
        urls.push(url);
        return document(item('A story'));
      },
      postJson: async () => undefined,
    };

    const headlines = await createNewsFeed(client).loadHeadlines();
    expect(urls).toEqual(['https://www.coindesk.com/arc/outboundfeeds/rss']);
    expect(headlines[0]?.title).toBe('A story');
  });
});
