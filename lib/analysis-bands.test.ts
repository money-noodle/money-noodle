import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_ANALYSIS_BANDS, evaluateBand, normaliseBands, type AnalysisBand } from './analysis-bands';
import { estimatePaperFill, venueFeeCents } from './venue-fill';
import type { LongShotCandidate } from './long-shot-candidate';

const options = {
  ticketCents: 20,
  minimumSecondsRemaining: 600,
  fill: (stakeLimitCents: number, askPrice: number) => estimatePaperFill(stakeLimitCents, askPrice, 'kalshi'),
  exitFeeCents: (priceCents: number, quantity: number) => venueFeeCents('kalshi', priceCents, quantity, 'taker'),
};

const band = (patch: Partial<AnalysisBand> = {}): AnalysisBand => ({
  id: 'b1', label: 'launch', entryLowCents: 5, entryHighCents: 10, exitCents: 90, ...patch,
});

let counter = 0;
const candidate = (patch: Partial<LongShotCandidate> = {}): LongShotCandidate => ({
  contractId: `c-${counter += 1}`, symbol: 'BTC', closesAt: '2026-08-15T00:15:00Z', side: 'UP',
  settledSide: 'DOWN',
  marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 20, troughBidAfterCents: 0 }],
  ...patch,
});

describe('band validation', () => {
  it('rejects rather than repairs a band it cannot use', () => {
    const cases: Array<[Partial<AnalysisBand>, string]> = [
      [{ label: '', entryLowCents: 5, entryHighCents: 10, exitCents: 90 }, 'label'],
      [{ label: 'a', entryLowCents: 10, entryHighCents: 5, exitCents: 90 }, 'entry low below its entry high'],
      [{ label: 'a', entryLowCents: 5, entryHighCents: 5, exitCents: 90 }, 'entry low below its entry high'],
      [{ label: 'a', entryLowCents: 5, entryHighCents: 120, exitCents: 90 }, 'cannot enter above 99'],
      [{ label: 'a', entryLowCents: 5, entryHighCents: 10, exitCents: 10 }, 'exit above its entry high'],
      [{ label: 'a', entryLowCents: 5, entryHighCents: 10, exitCents: 120 }, 'cannot exit above 99'],
      [{ label: 'a', entryLowCents: Number.NaN, entryHighCents: 10, exitCents: 90 }, 'whole-cent'],
    ];
    for (const [input, fragment] of cases) {
      const result = normaliseBands([input]);
      expect('error' in result ? result.error : '').toContain(fragment);
    }
  });

  it('allows overlapping bands, which are distinct hypotheses rather than a partition', () => {
    const result = normaliseBands([
      { label: 'wide', entryLowCents: 0, entryHighCents: 20, exitCents: 90 },
      { label: 'narrow', entryLowCents: 5, entryHighCents: 10, exitCents: 90 },
    ]);
    expect('bands' in result && result.bands).toHaveLength(2);
  });

  it('rejects an exact duplicate, which double-counts one hypothesis', () => {
    const result = normaliseBands([
      { label: 'one', entryLowCents: 5, entryHighCents: 10, exitCents: 90 },
      { label: 'two', entryLowCents: 5, entryHighCents: 10, exitCents: 90 },
    ]);
    expect('error' in result && result.error).toContain('duplicates');
  });

  it('caps the band count, because every band is another comparison to correct for', () => {
    const many = Array.from({ length: MAX_ANALYSIS_BANDS + 1 }, (_, index) => ({
      label: `b${index}`, entryLowCents: index, entryHighCents: index + 1, exitCents: 95,
    }));
    expect('error' in normaliseBands(many)).toBe(true);
  });
});

describe('band measurement', () => {
  it('counts a touch when the peak bid reaches the exit', () => {
    const result = evaluateBand([
      candidate({ marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 90, troughBidAfterCents: 0 }] }),
      candidate({ marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 89, troughBidAfterCents: 0 }] }),
    ], band(), options);
    expect(result.candidates).toBe(2);
    expect(result.touched).toBe(1);
    expect(result.touchRate).toBeCloseTo(0.5, 9);
  });

  it('grades a miss at its settlement rather than as a total loss', () => {
    // A miss on a side that settled in the money pays the full contract, not zero: there is no fallback
    // exit, so the position simply settles.
    const won = evaluateBand([candidate({ side: 'UP', settledSide: 'UP' })], band(), options);
    const lost = evaluateBand([candidate({ side: 'UP', settledSide: 'DOWN' })], band(), options);
    expect(won.meanReturn!).toBeGreaterThan(0);
    expect(lost.meanReturn).toBeCloseTo(-1, 9);
  });

  it('clusters returns on the settlement window, not on the candidate', () => {
    const shared = '2026-08-15T00:15:00Z';
    const other = '2026-08-15T00:30:00Z';
    const result = evaluateBand([
      candidate({ closesAt: shared, side: 'UP', settledSide: 'DOWN' }),
      candidate({ closesAt: shared, side: 'UP', settledSide: 'DOWN' }),
      candidate({ closesAt: other, side: 'UP', settledSide: 'UP' }),
    ], band(), options);
    // Two losses in one window average to -1 before meeting the other window, rather than outvoting it.
    expect(result.windows).toBe(2);
    expect(result.meanReturn!).toBeGreaterThan(0);
  });

  /**
   * A touch can be priced from the exit alone; a miss cannot be priced without a settlement. Admitting
   * touches from unsettled windows while holding back misses fills the average with winners — measured on
   * live data that read +767% per $1 on a band whose ratio was 0.86.
   */
  it('holds back a touch from an unsettled window, not only a miss', () => {
    const touchedButUnsettled = candidate({
      settledSide: undefined, marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 95, troughBidAfterCents: 0 }],
    });
    const result = evaluateBand([touchedButUnsettled], band(), options);
    // It still counts as a touch — that needs no outcome — but it cannot enter the return.
    expect(result.touched).toBe(1);
    expect(result.touchRate).toBe(1);
    expect(result.ungraded).toBe(1);
    expect(result.meanReturn).toBeNull();
  });

  it('grades only the settled cohort, so the return is not a winners-only average', () => {
    const rows = [
      candidate({ closesAt: 'w1', settledSide: undefined, marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 95, troughBidAfterCents: 0 }] }),
      candidate({ closesAt: 'w2', side: 'UP', settledSide: 'DOWN', marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 20, troughBidAfterCents: 0 }] }),
    ];
    const result = evaluateBand(rows, band(), options);
    expect(result.candidates).toBe(2);
    expect(result.ungraded).toBe(1);
    // Only the settled miss is graded, so the return is its -1 rather than an average with the touch.
    expect(result.windows).toBe(1);
    expect(result.meanReturn).toBeCloseTo(-1, 9);
  });

  it('counts an unresolved window instead of grading it', () => {
    const result = evaluateBand([candidate({ settledSide: undefined })], band(), options);
    expect(result.candidates).toBe(1);
    expect(result.ungraded).toBe(1);
    expect(result.meanReturn).toBeNull();
  });

  it('reports break-even and the ratio against it', () => {
    const result = evaluateBand([candidate({ marks: [{ offsetSeconds: 60, askCents: 10, peakBidAfterCents: 95, troughBidAfterCents: 0 }] })], band(), options);
    // A 20c ticket at 10c buys 1.8 contracts; selling at 90c returns 160c net of the 2c exit fee.
    expect(result.breakEvenRate!).toBeCloseTo(20 / 160, 2);
    expect(result.ratio!).toBeCloseTo(result.touchRate! / result.breakEvenRate!, 9);
  });

  it('ignores a candidate whose ask never entered the band', () => {
    const result = evaluateBand([candidate({ marks: [{ offsetSeconds: 60, askCents: 40, peakBidAfterCents: 95, troughBidAfterCents: 0 }] })], band(), options);
    expect(result.candidates).toBe(0);
    expect(result.touchRate).toBeNull();
  });
});

/**
 * The boundary AGENTS §5.5 requires: retroactive screening may filter an idea and may never promote one.
 *
 * A surface that lets an operator define bands and immediately see them scored over history is exactly a
 * screening machine, so the guard is structural rather than procedural — no module that can price, size,
 * gate, or trade may import it. If someone wires a good-looking band into the entry rule, this fails.
 */
describe('analysis bands are isolated from anything that can move money', () => {
  const forbidden = [
    'long-shot-policy.ts', 'long-shot-execution.ts', 'long-shot-engine.ts', 'prediction-policy.ts',
    'entry-execution-policy.ts', 'paper-execution.ts', 'live-orders.ts', 'exit-policy.ts',
    'target-exit-policy.ts', 'venue-fill.ts', 'strategy-budget-policy.ts',
  ];

  it('is imported by no module on a pricing, sizing, gating, or execution path', () => {
    for (const file of forbidden) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      expect({ file, importsBands: source.includes('analysis-bands') }).toEqual({ file, importsBands: false });
    }
  });

  it('imports nothing that could let it act, only the pure candidate summary', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib', 'analysis-bands.ts'), 'utf8');
    const imports = [...source.matchAll(/from '\.\/([\w-]+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['long-shot-candidate']);
  });
});
