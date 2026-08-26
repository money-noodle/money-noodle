import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cryptoExposureGroup, DEFAULT_MAX_OPEN_POSITIONS, DEFAULT_PORTFOLIO_CONSTRAINTS, selectPortfolio } from './portfolio-policy';
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
    // The group allowance is shared, not granted per venue. Filled to whatever the cap currently is, so
    // this keeps testing the sharing rather than a particular number.
    const filled = ['SOL', 'BNB', 'HYPE'].slice(0, DEFAULT_PORTFOLIO_CONSTRAINTS.maximumSameGroupPerWindow);
    const existing: PortfolioExposure[] = filled.map((symbol) => ({ symbol, closesAt: window }));
    const selection = selectPortfolio([candidate('sol-other-venue', 'SOL')], existing, DEFAULT_PORTFOLIO_CONSTRAINTS);
    expect(selection[0].selected).toBe(false);
    expect(selection[0].reason).toMatch(/group|correlat|already has exposure/i);
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
    // One position per window, filling the global cap exactly. Derived from the constant so raising the
    // cap cannot silently turn this into a test that passes for the wrong reason.
    const assets = ['BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'XRP', 'DOGE', 'BTC', 'ETH', 'SOL'];
    const existing: PortfolioExposure[] = Array.from({ length: DEFAULT_MAX_OPEN_POSITIONS }, (_, index) => ({
      symbol: assets[index], closesAt: new Date(Date.parse('2026-08-13T00:15:00Z') + index * 900_000).toISOString(),
    }));
    expect(existing).toHaveLength(DEFAULT_MAX_OPEN_POSITIONS);
    const selection = selectPortfolio([candidate('d', 'DOGE', '2026-08-14T00:00:00Z')], existing, DEFAULT_PORTFOLIO_CONSTRAINTS);
    expect(selection[0].selected).toBe(false);
    expect(selection[0].reason).toContain('already has');
  });

  it('groups by asset rather than venue, so the same asset on two providers shares one allowance', () => {
    expect(cryptoExposureGroup('BTC')).toBe(cryptoExposureGroup('ETH'));
    expect(cryptoExposureGroup('SOL')).toBe(cryptoExposureGroup('BNB'));
    expect(cryptoExposureGroup('BTC')).not.toBe(cryptoExposureGroup('DOGE'));
  });
});
