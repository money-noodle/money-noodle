// How current one feed is, in words beside the numbers it governs.
//
// The API states a feed's state, the age of its value and a fixed reason code. All three
// are shown, in text: a reader must be able to tell a current price from a five-minute-old
// one without noticing a colour, and a screen reader must read the same sentence a sighted
// reader sees. The border colour that comes with it is decoration on top of the words.

import type { MarketFeedReason, MarketFeedState } from '@money-noodle/platform-api-client';

import { formatAge } from './format';

/** The reason codes, said in a sentence rather than as a code. */
const REASONS: Readonly<Record<MarketFeedReason, string>> = Object.freeze({
  'upstream-invalid': 'the source answered with something unusable',
  'upstream-rate-limited': 'the source declined for rate reasons',
  'upstream-timeout': 'the source did not answer in time',
  'upstream-unavailable': 'the source could not be reached',
});

export interface FeedFreshnessProps {
  readonly feed: MarketFeedState;
  readonly label: string;
}

function reasonText(reason: MarketFeedReason | undefined): string {
  return reason === undefined ? '' : ` — ${REASONS[reason]}`;
}

/** The sentence for one feed. Exported for the views that need it inside a table cell. */
export function describeFeed(feed: MarketFeedState): string {
  if (feed.state === 'unavailable') {
    return `Unavailable${reasonText(feed.reason)}. No figures from this source are shown.`;
  }
  if (feed.state === 'stale') {
    return `Stale: last obtained ${formatAge(feed.ageSeconds)}${reasonText(feed.reason)}.`;
  }
  return `Fresh: obtained ${formatAge(feed.ageSeconds)}.`;
}

export function FeedFreshness({ feed, label }: FeedFreshnessProps) {
  return (
    <p className={`feed feed--${feed.state}`}>
      <span className="feed__label">{label}</span>{' '}
      <span className="feed__state">{describeFeed(feed)}</span>
      {feed.fetchedAt === undefined ? null : (
        <>
          {' '}
          <time className="feed__time" dateTime={feed.fetchedAt}>
            {feed.fetchedAt}
          </time>
        </>
      )}
    </p>
  );
}
