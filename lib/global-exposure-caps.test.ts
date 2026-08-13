import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cryptoExposureGroup, DEFAULT_PORTFOLIO_CONSTRAINTS, selectPortfolio } from './portfolio-policy';
import type { PortfolioCandidate, PortfolioExposure } from './portfolio-policy';

/**
 * Budgets split per provider; exposure caps must not. Risk is exposure to the underlying asset and
 * window, so a cap keyed per provider would grant each provider a full allowance of the same correlated
 * bet — three positions would silently become three per venue. These cases fail if that ever changes.
 */
describe('exposure caps stay global across providers', () => {
  const window = '2026-08-13T01:00:00Z';
  const candidate = (id: string, symbol: string, closesAt = window): PortfolioCandidate => ({
    id, symbol, closesAt, expectedProfitCents: 10,
  });

  it('counts existing exposure regardless of which provider holds it', () => {
    // BTC and ETH are both `majors`, so one existing majors position uses that group's whole allowance.
    const existing: PortfolioExposure[] = [{ symbol: 'BTC', closesAt: window }];
    const selection = selectPortfolio([candidate('eth-kalshi', 'ETH')], existing, DEFAULT_PORTFOLIO_CONSTRAINTS);
    expect(selection[0].selected).toBe(false);
    expect(selection[0].reason).toMatch(/group|correlat/i);
  });

  it('does not expose a provider dimension that a cap could be keyed by', () => {
    // PortfolioExposure and PortfolioCandidate describe asset and window only. If a providerId is ever
    // added here, revisit every cap: the caps must remain global even when the data allows splitting.
    const exposure: PortfolioExposure = { symbol: 'BTC', closesAt: window };
    expect(Object.keys(exposure).sort()).toEqual(['closesAt', 'symbol']);
    expect(Object.keys(candidate('x', 'BTC')).sort()).toEqual(['closesAt', 'expectedProfitCents', 'id', 'symbol']);
  });

  it('enforces the same-window cap across candidates that could come from different providers', () => {
    const constraints = { ...DEFAULT_PORTFOLIO_CONSTRAINTS, maximumSameGroupPerWindow: 3, maximumSameWindow: 2 };
    const selection = selectPortfolio(
      [candidate('a', 'BTC'), candidate('b', 'ETH'), candidate('c', 'SOL')],
      [], constraints,
    );
    expect(selection.filter((item) => item.selected)).toHaveLength(2);
  });

  it('enforces the global position cap across windows, not per venue', () => {
    const existing: PortfolioExposure[] = [
      { symbol: 'BTC', closesAt: '2026-08-13T00:15:00Z' },
      { symbol: 'SOL', closesAt: '2026-08-13T00:30:00Z' },
      { symbol: 'XRP', closesAt: '2026-08-13T00:45:00Z' },
    ];
    const selection = selectPortfolio([candidate('d', 'DOGE')], existing, DEFAULT_PORTFOLIO_CONSTRAINTS);
    expect(selection[0].selected).toBe(false);
  });

  it('groups by asset rather than venue, so the same asset on two providers shares one allowance', () => {
    expect(cryptoExposureGroup('BTC')).toBe(cryptoExposureGroup('ETH'));
    expect(cryptoExposureGroup('SOL')).toBe(cryptoExposureGroup('BNB'));
    expect(cryptoExposureGroup('BTC')).not.toBe(cryptoExposureGroup('DOGE'));
  });
});
