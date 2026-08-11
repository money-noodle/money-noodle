import { describe, expect, it } from 'vitest';
import { MAX_CONFIGURABLE_OPEN_POSITIONS, parseMaximumOpenPositions, selectPortfolio, type PortfolioCandidate } from './portfolio-policy';

const close = '2026-01-01T00:15:00Z';
const candidate = (symbol: string, expectedProfitCents: number, closesAt = close): PortfolioCandidate => ({ id: `${symbol}:${closesAt}`, symbol, closesAt, expectedProfitCents });

describe('constrained portfolio selection', () => {
  it('parses a configurable global position limit with conservative validation and a hard ceiling', () => {
    expect(parseMaximumOpenPositions(undefined)).toBe(3);
    expect(parseMaximumOpenPositions('5')).toBe(5);
    expect(parseMaximumOpenPositions('0')).toBe(3);
    expect(parseMaximumOpenPositions('2.5')).toBe(3);
    expect(parseMaximumOpenPositions('invalid')).toBe(3);
    expect(parseMaximumOpenPositions('100')).toBe(MAX_CONFIGURABLE_OPEN_POSITIONS);
  });

  it('ranks by expected dollar contribution rather than standalone probability or edge', () => {
    const result = selectPortfolio([candidate('BTC', 3), candidate('SOL', 6)], [], { maximumPositions: 3, maximumSameWindow: 2, maximumSameGroupPerWindow: 1, correlationPenaltyCents: 0, sameGroupPenaltyCents: 0 });
    expect(result.find((item) => item.symbol === 'SOL')).toMatchObject({ selected: true, rank: 1 });
    expect(result.find((item) => item.symbol === 'BTC')).toMatchObject({ selected: true, rank: 2 });
  });

  it('enforces the same-window limit across highly correlated crypto assets', () => {
    const result = selectPortfolio([candidate('BTC', 8), candidate('SOL', 7), candidate('DOGE', 6)], []);
    expect(result.filter((item) => item.selected)).toHaveLength(2);
    expect(result.find((item) => item.symbol === 'DOGE')?.reason).toContain('same-window exposure limit');
  });

  it('prevents concentration in one exposure group within a settlement window', () => {
    const result = selectPortfolio([candidate('SOL', 8), candidate('BNB', 7), candidate('BTC', 5)], []);
    expect(result.find((item) => item.symbol === 'SOL')?.selected).toBe(true);
    expect(result.find((item) => item.symbol === 'BNB')?.reason).toContain('layer1-beta group limit');
    expect(result.find((item) => item.symbol === 'BTC')?.selected).toBe(true);
  });

  it('accounts for existing exposure and can reject a marginal positive standalone trade', () => {
    const result = selectPortfolio([candidate('DOGE', 1.5)], [{ symbol: 'BTC', closesAt: close }]);
    expect(result[0]).toMatchObject({ selected: true, adjustedExpectedContributionCents: 0.5 });
    const penalized = selectPortfolio([candidate('DOGE', 0.5)], [{ symbol: 'BTC', closesAt: close }]);
    expect(penalized[0].selected).toBe(false);
    expect(penalized[0].reason).toContain('correlation-adjusted');
  });

  it('blocks a second side of the same asset/window outside the reduce-only switch path', () => {
    const opposite = { ...candidate('BTC', 8), id: `BTC:DOWN:${close}` };
    const result = selectPortfolio([opposite], [{ symbol: 'BTC', closesAt: close }], {
      maximumPositions: 3, maximumSameWindow: 3, maximumSameGroupPerWindow: 3,
      correlationPenaltyCents: 0, sameGroupPenaltyCents: 0,
    });
    expect(result[0].selected).toBe(false);
    expect(result[0].reason).toContain('opposite-side exposure requires a validated reduce-only switch');
  });

  it('allows positions in different settlement windows without same-window penalties', () => {
    const result = selectPortfolio([candidate('ETH', 3, '2026-01-01T00:30:00Z')], [{ symbol: 'BTC', closesAt: close }]);
    expect(result[0]).toMatchObject({ selected: true, correlatedPositions: 0, adjustedExpectedContributionCents: 3 });
  });
});
