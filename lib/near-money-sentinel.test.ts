import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  NEAR_MONEY_HOLD, buildNearMoneySentinelReport, type NearMoneySentinelDefinition,
} from './near-money-sentinel';
import { estimatePaperFill, venueFeeCents } from './venue-fill';
import type { LongShotCandidate } from './long-shot-candidate';

const options = {
  ticketCents: 20,
  fill: (stakeLimitCents: number, askPrice: number) => estimatePaperFill(stakeLimitCents, askPrice, 'kalshi'),
  exitFeeCents: (priceCents: number, quantity: number) => venueFeeCents('kalshi', priceCents, quantity, 'taker'),
};

const definition: NearMoneySentinelDefinition = {
  ...NEAR_MONEY_HOLD, committedAt: '2026-08-18T00:00:00.000Z', stopsBelowEntryCents: [null, 10],
};

let counter = 0;
const candidate = (patch: Partial<LongShotCandidate> & { trough?: number; ask?: number } = {}): LongShotCandidate => ({
  contractId: `c-${counter += 1}`, symbol: 'BTC', closesAt: '2026-08-18T01:00:00Z', side: 'UP',
  settledSide: 'UP',
  marks: [{ offsetSeconds: 60, askCents: patch.ask ?? 72, peakBidAfterCents: 90, troughBidAfterCents: patch.trough ?? 71 }],
  ...patch,
});

const armFor = (report: ReturnType<typeof buildNearMoneySentinelReport>, stop: number | null, prospective = true) =>
  (prospective ? report.prospective : report.retrospective).find((a) => a.stopBelowEntryCents === stop)!;

describe('near-money hold sentinel', () => {
  it('separates windows that closed before the rule was written', () => {
    const report = buildNearMoneySentinelReport([
      candidate({ closesAt: '2026-08-17T12:00:00Z' }),
      candidate({ closesAt: '2026-08-18T06:00:00Z' }),
    ], options, definition);
    expect(armFor(report, null).positions).toBe(1);
    expect(armFor(report, null, false).positions).toBe(1);
  });

  it('fires a stop only when the bid actually reached it', () => {
    // Entry at 72c with a 10c stop trips at 62c.
    const report = buildNearMoneySentinelReport([
      candidate({ trough: 61 }), candidate({ trough: 62 }), candidate({ trough: 63 }),
    ], options, definition);
    expect(armFor(report, 10).stopped).toBe(2);
    expect(armFor(report, null).stopped).toBe(0);
  });

  /**
   * The spread is why stops are expressed in cents below the entry ask rather than "back to what I paid":
   * the bid sits under the ask from the moment of entry, so a stop at the entry price fires on essentially
   * every position and measures the spread instead of the thesis.
   */
  it('would fire on every position if the stop sat at the entry price', () => {
    const atEntry: NearMoneySentinelDefinition = { ...definition, stopsBelowEntryCents: [0] };
    const report = buildNearMoneySentinelReport([
      candidate({ trough: 71 }), candidate({ trough: 70 }),
    ], options, atEntry);
    expect(armFor(report, 0).stopRate).toBe(1);
  });

  it('prices a stopped position at the stop and an unstopped one at settlement', () => {
    const stoppedLoser = buildNearMoneySentinelReport([candidate({ trough: 50, settledSide: 'DOWN' })], options, definition);
    // The stop rescued it: sold at 62c rather than settling worthless.
    expect(armFor(stoppedLoser, 10).meanReturn!).toBeGreaterThan(-1);
    expect(armFor(stoppedLoser, null).meanReturn).toBeCloseTo(-1, 9);

    const stoppedWinner = buildNearMoneySentinelReport([candidate({ trough: 50, settledSide: 'UP' })], options, definition);
    // The stop cost it: sold at 62c rather than settling at 100c.
    expect(armFor(stoppedWinner, 10).meanReturn!).toBeLessThan(armFor(stoppedWinner, null).meanReturn!);
  });

  it('holds back an unsettled window from every arm, stopped or not', () => {
    const report = buildNearMoneySentinelReport([
      candidate({ trough: 50, settledSide: undefined }),
    ], options, definition);
    expect(armFor(report, 10).stopped).toBe(1);
    expect(armFor(report, 10).ungraded).toBe(1);
    expect(armFor(report, 10).meanReturn).toBeNull();
  });

  it('clusters on the settlement window rather than the position', () => {
    const report = buildNearMoneySentinelReport([
      candidate({ closesAt: '2026-08-18T01:00:00Z', settledSide: 'DOWN' }),
      candidate({ closesAt: '2026-08-18T01:00:00Z', settledSide: 'DOWN' }),
      candidate({ closesAt: '2026-08-18T02:00:00Z', settledSide: 'UP' }),
    ], options, definition);
    expect(armFor(report, null).windows).toBe(2);
  });

  it('ignores a side that never traded inside the committed band', () => {
    const report = buildNearMoneySentinelReport([candidate({ ask: 40 })], options, definition);
    expect(armFor(report, null).positions).toBe(0);
  });
});
