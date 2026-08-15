import { describe, expect, it } from 'vitest';
import {
  CONTRACT_PATH_BUCKET_MS, decodeContractPath, emptyContractPath, encodeContractPath,
  firstEntryOffsetSeconds, observeContractPath, peakBidAfterOffset, sideAskCents, sideBidCents,
  summarizeContractPath, type ContractPathRecord,
} from './contract-path';

const closesAt = '2026-08-15T00:15:00Z';
const cycleStartMs = Date.parse('2026-08-15T00:00:00Z');
const base = () => emptyContractPath({ contractId: 'KXBTC15M-TEST', symbol: 'BTC', closesAt });

const at = (seconds: number, askUpCents: number, askDownCents: number) => ({
  atMs: cycleStartMs + seconds * 1000, askUpCents, askDownCents,
});

const withPoints = (...points: Array<[number, number, number]>): ContractPathRecord =>
  points.reduce((record, [seconds, up, down]) => observeContractPath(record, at(seconds, up, down)), base());

describe('the Kalshi book identity', () => {
  it('derives both bids from the two asks rather than storing four numbers', () => {
    const point = { offsetSeconds: 0, askUpCents: 13, askDownCents: 91 };
    expect(sideAskCents(point, 'UP')).toBe(13);
    expect(sideAskCents(point, 'DOWN')).toBe(91);
    // bid(UP) = 100 - ask(DOWN), which is what makes the round trip reconstructable at all.
    expect(sideBidCents(point, 'UP')).toBe(9);
    expect(sideBidCents(point, 'DOWN')).toBe(87);
  });
});

describe('observation bucketing', () => {
  it('keys by 15-second bucket so a retry or restart cannot manufacture samples', () => {
    expect(CONTRACT_PATH_BUCKET_MS).toBe(15_000);
    let record = observeContractPath(base(), at(0, 10, 91));
    record = observeContractPath(record, at(7, 11, 90));
    record = observeContractPath(record, at(14, 12, 89));
    expect(record.points).toHaveLength(1);
    // A later observation in the same bucket replaces the earlier one.
    expect(record.points[0]).toMatchObject({ offsetSeconds: 0, askUpCents: 12 });
  });

  it('keeps points ordered however they arrive', () => {
    const record = withPoints([60, 20, 81], [15, 12, 89], [30, 15, 86]);
    expect(record.points.map((point) => point.offsetSeconds)).toEqual([15, 30, 60]);
  });

  it('refuses observations outside the window and quotes that are not quotes', () => {
    // A zero recorded as a price would read as a free contract.
    expect(observeContractPath(base(), at(-30, 10, 91)).points).toHaveLength(0);
    expect(observeContractPath(base(), at(1_000, 10, 91)).points).toHaveLength(0);
    expect(observeContractPath(base(), at(60, 0, 91)).points).toHaveLength(0);
    expect(observeContractPath(base(), at(60, 10, Number.NaN)).points).toHaveLength(0);
  });
});

describe('rollup', () => {
  it('records the cheapest ask and highest bid per side with when each happened', () => {
    const record = withPoints([0, 45, 56], [60, 10, 91], [120, 8, 93], [300, 55, 46]);
    const rollup = summarizeContractPath(record);
    expect(rollup.samples).toBe(4);
    expect(rollup.coverageSeconds).toBe(300);
    expect(rollup.up).toMatchObject({ minAskCents: 8, minAskOffsetSeconds: 120 });
    // bid(UP) peaks where ask(DOWN) is lowest: 100 - 46 = 54.
    expect(rollup.up).toMatchObject({ maxBidCents: 54, maxBidOffsetSeconds: 300 });
    expect(rollup.down).toMatchObject({ minAskCents: 46, maxBidCents: 92 });
  });

  it('reports honestly on an unobserved window rather than inventing a price', () => {
    const rollup = summarizeContractPath(base());
    expect(rollup).toMatchObject({ samples: 0, coverageSeconds: 0 });
    expect(rollup.up.minAskCents).toBeNull();
    expect(rollup.up.maxBidCents).toBeNull();
  });
});

describe('the round-trip question', () => {
  // UP is buyable at 10c a minute in, then runs to a 92c bid: the shape the whole policy is built on.
  const roundTrip = withPoints([0, 45, 56], [60, 10, 91], [180, 40, 61], [300, 70, 31], [420, 93, 8]);

  it('finds the first entry within a window, and refuses one that arrives too late', () => {
    expect(firstEntryOffsetSeconds(roundTrip, 'UP', { markCents: 10, withinSeconds: 180 })).toBe(60);
    expect(firstEntryOffsetSeconds(roundTrip, 'UP', { markCents: 10, withinSeconds: 30 })).toBeNull();
    expect(firstEntryOffsetSeconds(roundTrip, 'UP', { markCents: 5, withinSeconds: 180 })).toBeNull();
  });

  it('measures the peak strictly after entry, which is the only peak that could have been sold', () => {
    // A high bid before the entry is not a profit anyone could have taken.
    const entry = firstEntryOffsetSeconds(roundTrip, 'UP', { markCents: 10, withinSeconds: 180 })!;
    expect(peakBidAfterOffset(roundTrip, 'UP', entry)).toBe(92);
    expect(peakBidAfterOffset(roundTrip, 'UP', 420)).toBeNull();
  });

  it('leaves every candidate exit mark evaluable from one recording', () => {
    // The reason peak-after-entry is a query rather than a stored field: committing to 90c now would
    // make re-choosing it later cost another month of collection.
    const entry = firstEntryOffsetSeconds(roundTrip, 'UP', { markCents: 10, withinSeconds: 180 })!;
    const peak = peakBidAfterOffset(roundTrip, 'UP', entry)!;
    expect([70, 80, 90].map((mark) => peak >= mark)).toEqual([true, true, true]);
    expect(peak >= 95).toBe(false);
  });
});

describe('compact journal encoding', () => {
  it('round-trips a record through the wire form', () => {
    const record = withPoints([0, 45, 56], [60, 10, 91]);
    const decoded = decodeContractPath(JSON.parse(JSON.stringify(encodeContractPath(record))));
    expect(decoded).toEqual(record);
  });

  it('stays compact enough that a day of collection is not a storage problem', () => {
    // Roughly 672 windows a day at 60 samples each. The same data as per-point objects is nearer 2 MB,
    // and a single rewritten array is the shape this repo has already had to migrate away from.
    const full = Array.from({ length: 60 }, (_, index): [number, number, number] => [index * 15, 10 + index, 90 - index]);
    const bytes = JSON.stringify(encodeContractPath(withPoints(...full))).length;
    expect(bytes).toBeLessThan(900);
    expect(bytes * 672).toBeLessThan(700_000);
  });

  it('discards malformed rows instead of decoding them into fake prices', () => {
    expect(decodeContractPath(null)).toBeNull();
    expect(decodeContractPath(['id', 'BTC', 'not-a-date', []])).toBeNull();
    expect(decodeContractPath(['id', 'BTC', closesAt, [[0, 10, 91], 'junk', [1]]])?.points).toHaveLength(1);
  });
});
