// The headline feed: one public RSS document, hand-parsed.
//
// Hand-parsed on purpose. Three fields are needed from each item, and a general XML
// parser brings a document model, entity resolution and external-entity handling that
// nothing here wants — an RSS document from a third party is exactly the input that
// makes those features a liability. So this reads the fields with bounded expressions
// and never resolves an entity it was not given a literal for: there is no recursion,
// no DTD, no ENTITY and no external reference, so an expansion attack has nothing to
// expand. The surrounding HTTP client caps the document size before any of this runs.
//
// Everything published is plain text. Markup is removed rather than escaped, the text
// is length-bounded, and a link is published only when it is an http or https URL, so
// a caller rendering a headline as an anchor cannot be handed a script URL (SECURITY.md).
//
// Deliberately not ported: v1's lexical sentiment score. Counting substrings like
// "bull" inside unrelated words produced a label it then presented beside market data,
// which is model output dressed as a feed (#211, decision 1). The headlines are
// published; what they mean is not this capability's claim to make.

import type { Headline } from '../../domain/market-feeds.js';
import { MAX_HEADLINES } from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';

const FEED_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/';

/** The longest headline published. Past this it is cut at a word and marked. */
export const MAX_HEADLINE_LENGTH = 300;

/** Items examined at most, so a very long document cannot make this loop for long. */
const MAX_ITEMS_SCANNED = 200;

const ITEM = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const TAG = /<[^>]*>/g;
const WHITESPACE = /\s+/g;

/**
 * The only entities this decodes, as literals.
 *
 * A fixed table applied in one pass: a replacement is never scanned again, so
 * `&amp;lt;` decodes to the text `&lt;` and stops there.
 */
const ENTITIES = Object.freeze<Record<string, string>>({
  '&#34;': '"',
  '&#38;': '&',
  '&#39;': "'",
  '&amp;': '&',
  '&apos;': "'",
  '&gt;': '>',
  '&lt;': '<',
  '&nbsp;': ' ',
  '&quot;': '"',
});

const ENTITY = /&(?:#3[489]|amp|apos|gt|lt|nbsp|quot);/g;

/** The first element of a given name inside one item, as raw text. */
function firstElement(item: string, name: string): string | undefined {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  return pattern.exec(item)?.[1];
}

/** Markup and entities out, one line of bounded plain text in. */
export function plainText(value: string | undefined): string {
  if (value === undefined) return '';
  const unwrapped = value.replace(CDATA, '$1');
  const decoded = unwrapped.replace(ENTITY, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
  // Entities are decoded before markup is removed, so an angle bracket that arrived
  // encoded is treated as the markup it would become rather than published as text.
  const stripped = decoded.replace(TAG, ' ');
  const collapsed = stripped.replace(WHITESPACE, ' ').trim();
  return collapsed.length <= MAX_HEADLINE_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_HEADLINE_LENGTH - 1).trimEnd()}…`;
}

/** A link a caller may follow: http or https, and nothing else. */
export function safeLink(value: string | undefined): string | undefined {
  const text = plainText(value);
  if (text.length === 0) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** A publication time, normalized. v1 published the publisher's raw string. */
export function publishedAt(value: string | undefined): Date | undefined {
  const text = plainText(value);
  if (text.length === 0) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The headlines of one RSS document, in document order.
 *
 * Document order is kept rather than sorted: the publisher's order is normally newest
 * first and re-sorting on a time this service had to parse would be a second opinion
 * about the publisher's own list. An item with no usable title is dropped, because an
 * empty headline is nothing to publish.
 */
export function readHeadlines(document: string): readonly Headline[] {
  const headlines: Headline[] = [];
  let scanned = 0;

  ITEM.lastIndex = 0;
  for (
    let match = ITEM.exec(document);
    match !== null && scanned < MAX_ITEMS_SCANNED && headlines.length < MAX_HEADLINES;
    match = ITEM.exec(document)
  ) {
    scanned += 1;
    const item = match[1] ?? '';
    const title = plainText(firstElement(item, 'title'));
    if (title.length === 0) continue;
    const link = safeLink(firstElement(item, 'link'));
    const time = publishedAt(firstElement(item, 'pubDate'));
    headlines.push(
      Object.freeze({
        ...(link === undefined ? {} : { link }),
        ...(time === undefined ? {} : { publishedAt: time }),
        title,
      }),
    );
  }

  // A document with no items at all is not a news feed: either the publisher changed
  // its shape or something else answered, and both are unusable payloads.
  if (headlines.length === 0) throw new FeedFailure('upstream-invalid');
  return Object.freeze(headlines);
}

export interface NewsFeed {
  readonly loadHeadlines: () => Promise<readonly Headline[]>;
}

export function createNewsFeed(client: FeedHttpClient): NewsFeed {
  return Object.freeze({
    loadHeadlines: async () => readHeadlines(await client.getText(FEED_URL)),
  });
}
