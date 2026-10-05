// The series as a shape, and as a sentence.
//
// The geometry is checked because a mistake in it is invisible; the accessible name is
// checked because for many readers it is the chart.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { scaleSeries, Sparkline } from './sparkline';

const series = (prices: readonly number[]) =>
  prices.map((price, index) => ({ price, time: `2026-10-0${index + 1}T00:00:00.000Z` }));

describe('scaleSeries', () => {
  it('spans the box and keeps the endpoints', () => {
    const scaled = scaleSeries(series([10, 20, 30]));
    expect(scaled?.first).toBe(10);
    expect(scaled?.last).toBe(30);
    // Oldest on the left at the bottom, newest on the right at the top.
    expect(scaled?.polyline).toBe('2.00,46.00 120.00,24.00 238.00,2.00');
  });

  it('puts a flat series on the middle line rather than dividing by nothing', () => {
    expect(scaleSeries(series([5, 5, 5]))?.polyline).toBe('2.00,24.00 120.00,24.00 238.00,24.00');
  });

  it('has no shape to draw from fewer than two prices', () => {
    expect(scaleSeries(series([1]))).toBeUndefined();
    expect(scaleSeries([])).toBeUndefined();
  });
});

describe('Sparkline', () => {
  it('names the direction and the endpoints', () => {
    const markup = renderToStaticMarkup(
      <Sparkline points={series([10, 30])} title="Synthcoin price" titleId="chart-1" />,
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-labelledby="chart-1"');
    expect(markup).toContain(
      '<title id="chart-1">Synthcoin price: up from $10.00 to $30.00 across 2 published points.</title>',
    );
  });

  it('says it is flat when it is', () => {
    const markup = renderToStaticMarkup(
      <Sparkline points={series([10, 10])} title="Flatcoin price" titleId="chart-2" />,
    );
    expect(markup).toContain('flat from');
  });

  it('says there is no series rather than drawing an empty box', () => {
    const markup = renderToStaticMarkup(
      <Sparkline points={[]} title="Nocoin price" titleId="chart-3" />,
    );
    expect(markup).toContain('No series published for this asset.');
    expect(markup).not.toContain('<svg');
  });

  it('says it is down when it is', () => {
    const markup = renderToStaticMarkup(
      <Sparkline points={series([30, 10])} title="Downcoin price" titleId="chart-4" />,
    );
    expect(markup).toContain('down from');
  });
});
