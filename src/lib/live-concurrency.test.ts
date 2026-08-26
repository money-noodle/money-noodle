import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { portfolioAdmitsAdditional } from './paper-execution';
import { DEFAULT_PORTFOLIO_CONSTRAINTS, cryptoExposureGroup } from './portfolio-policy';
import type { PaperOrder, Prediction } from './types';

/**
 * `runLive` drains its ranked selection rather than placing one order per cycle, so correlation limits
 * became load-bearing on live for the first time. Exposure created earlier in the same cycle is invisible
 * to `portfolioDecisions`, which is computed before anything is placed — these pin the check that closes
 * that gap.
 */
const CLOSES = '2026-08-18T23:45:00Z';
const held = (symbol: string, closesAt = CLOSES, status: PaperOrder['status'] = 'open'): PaperOrder => ({
  id: `live:${symbol}:UP:${closesAt}`, executionMode: 'live', symbol, closesAt, status,
} as unknown as PaperOrder);

const candidate = (symbol: string, closesAt = CLOSES) =>
  ({ symbol, market: { closesAt } } as unknown as Pick<Prediction, 'symbol' | 'market'>);

const ledgerOf = (orders: PaperOrder[]) => ({ orders });

describe('live drain-loop exposure check', () => {
  it('admits the first entry of a window', () => {
    expect(portfolioAdmitsAdditional(ledgerOf([]), candidate('BTC'))).toBe(true);
  });

  it('refuses a second entry on an asset already held in that window, either side', () => {
    expect(portfolioAdmitsAdditional(ledgerOf([held('BTC')]), candidate('BTC'))).toBe(false);
  });

  it('admits a correlated asset up to the group limit, then refuses', () => {
    expect(cryptoExposureGroup('BTC')).toBe(cryptoExposureGroup('ETH'));
    expect(DEFAULT_PORTFOLIO_CONSTRAINTS.maximumSameGroupPerWindow).toBe(3);
    // majors holds only BTC and ETH, so the group cap of 3 cannot bind before the assets run out.
    expect(portfolioAdmitsAdditional(ledgerOf([held('BTC')]), candidate('ETH'))).toBe(true);
    // layer1-beta has three members, so the third fills the group and a fourth would be refused.
    const two = ledgerOf([held('SOL'), held('BNB')]);
    expect(portfolioAdmitsAdditional(two, candidate('HYPE'))).toBe(true);
    const three = ledgerOf([held('SOL'), held('BNB'), held('HYPE')]);
    expect(portfolioAdmitsAdditional(three, candidate('SOL'))).toBe(false);
  });

  it('admits an uncorrelated asset in the same window', () => {
    expect(cryptoExposureGroup('BTC')).not.toBe(cryptoExposureGroup('DOGE'));
    expect(portfolioAdmitsAdditional(ledgerOf([held('BTC')]), candidate('DOGE'))).toBe(true);
  });

  it('stops at the same-window limit even when groups differ', () => {
    expect(DEFAULT_PORTFOLIO_CONSTRAINTS.maximumSameWindow).toBe(6);
    const five = ledgerOf([held('BTC'), held('ETH'), held('DOGE'), held('XRP'), held('SOL')]);
    expect(portfolioAdmitsAdditional(five, candidate('BNB'))).toBe(true);
    const six = ledgerOf([held('BTC'), held('ETH'), held('DOGE'), held('XRP'), held('SOL'), held('BNB')]);
    expect(portfolioAdmitsAdditional(six, candidate('HYPE'))).toBe(false);
  });

  it('does not let a different settlement window count against this one', () => {
    const other = ledgerOf([held('BTC', '2026-08-19T00:00:00Z'), held('ETH', '2026-08-19T00:00:00Z')]);
    expect(portfolioAdmitsAdditional(other, candidate('ETH'))).toBe(true);
  });

  it('counts pending and uncertain entries as exposure, not just open ones', () => {
    // Fill the window to its limit using each status, so the refusal proves the status was counted.
    for (const status of ['pending_reservation', 'uncertain'] as const) {
      const full = ledgerOf(['BTC', 'ETH', 'DOGE', 'XRP', 'SOL', 'BNB'].map((s) => held(s, CLOSES, status)));
      expect(portfolioAdmitsAdditional(full, candidate('HYPE'))).toBe(false);
    }
  });

  it('ignores settled and unfilled entries, which hold no slot', () => {
    for (const status of ['won', 'lost', 'sold', 'unfilled'] as const) {
      const full = ledgerOf(['BTC', 'ETH', 'DOGE', 'XRP', 'SOL', 'BNB'].map((s) => held(s, CLOSES, status)));
      expect(portfolioAdmitsAdditional(full, candidate('HYPE'))).toBe(true);
    }
  });

  it('ignores paper exposure when deciding a live placement', () => {
    const paper = { ...held('BTC'), executionMode: 'paper' } as PaperOrder;
    expect(portfolioAdmitsAdditional(ledgerOf([paper]), candidate('ETH'))).toBe(true);
  });
});
