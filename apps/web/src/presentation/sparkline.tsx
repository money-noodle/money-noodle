// A price series as inline SVG, with the same series available as text.
//
// No chart library, and no client JavaScript: a polyline the server can render is enough
// for a seven-day shape, and anything more would be shipped to every reader for a
// decoration. The accessible name states the direction and the endpoints, because a line
// nobody can see has to say what it shows — and the first and last price are the two
// figures a reader would take from it anyway.
//
// Nothing here is rounded before it is drawn: the scaling is geometry, and the two prices
// quoted in the label are formatted from the API's own numbers.

import type { MarketChartPoint } from '@money-noodle/platform-api-client';

import { formatSpotPrice } from './format';

const WIDTH = 240;
const HEIGHT = 48;
const PADDING = 2;

export interface SparklineProps {
  /** The series, oldest first. */
  readonly points: readonly MarketChartPoint[];
  /** What the series is of, for the accessible name. */
  readonly title: string;
  readonly titleId: string;
}

interface Scaled {
  readonly polyline: string;
  readonly first: number;
  readonly last: number;
}

/** The polyline, and the endpoints the label quotes. Undefined when there is no series. */
export function scaleSeries(points: readonly MarketChartPoint[]): Scaled | undefined {
  const prices = points
    .map((point) => point.price)
    .filter((price) => typeof price === 'number' && Number.isFinite(price));
  if (prices.length < 2) return undefined;

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low;
  const usableHeight = HEIGHT - PADDING * 2;
  const step = (WIDTH - PADDING * 2) / (prices.length - 1);

  const polyline = prices
    .map((price, index) => {
      const x = PADDING + index * step;
      // A flat series sits on the middle line rather than dividing by a zero span.
      const y =
        span === 0 ? HEIGHT / 2 : PADDING + usableHeight - ((price - low) / span) * usableHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return { first: prices[0]!, last: prices.at(-1)!, polyline };
}

export function Sparkline({ points, title, titleId }: SparklineProps) {
  const scaled = scaleSeries(points);
  if (scaled === undefined) {
    return <p className="sparkline sparkline--empty">No series published for this asset.</p>;
  }

  const direction =
    scaled.last > scaled.first ? 'up' : scaled.last < scaled.first ? 'down' : 'flat';
  const label = `${title}: ${direction} from ${formatSpotPrice(scaled.first)} to ${formatSpotPrice(
    scaled.last,
  )} across ${points.length} published points.`;

  return (
    <svg
      aria-labelledby={titleId}
      className="sparkline"
      role="img"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    >
      <title id={titleId}>{label}</title>
      <polyline fill="none" points={scaled.polyline} strokeWidth="2" />
    </svg>
  );
}
