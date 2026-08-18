import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  CANDIDATE_OFFSET_CAP_SECONDS, bandEntry, candidateMarks, candidatesFromPath, decodeCandidate,
  encodeCandidate, type LongShotCandidate,
} from './long-shot-candidate';
import { emptyContractPath, type ContractPathRecord } from './contract-path';

/** `[offsetSeconds, askUpCents, askDownCents]` triples, in the order the collector would have seen them. */
const path = (points: Array<[number, number, number]>): ContractPathRecord => ({
  ...emptyContractPath({ contractId: 'KXBTC15M-TEST', symbol: 'BTC', closesAt: '2026-08-15T00:15:00Z' }),
  points: points.map(([offsetSeconds, askUpCents, askDownCents]) => ({ offsetSeconds, askUpCents, askDownCents })),
});

describe('candidate marks', () => {
  it('records each distinct ask once, at its earliest offset', () => {
    // 40c appears twice; only the first occurrence can be the first entry into any band containing it.
    // 20c at the final offset is dropped: nothing follows it, so it can never be entered and held.
    const marks = candidateMarks(path([[0, 40, 61], [15, 30, 71], [30, 40, 61], [45, 20, 81]]), 'UP');
    expect(marks.map((mark) => [mark.offsetSeconds, mark.askCents])).toEqual([[0, 40], [15, 30]]);
  });

  /**
   * The case a running-minimum ladder gets wrong, and the reason this structure exists.
   *
   * A side at 30c that rises to 42c enters the band (40, 45] on the way up, with no new low to record.
   * Measured against a direct path scan the ladder form disagreed on 55 of 77 bands, worst at high bands.
   */
  it('records an ask reached on a rise, not only new lows', () => {
    const marks = candidateMarks(path([[0, 30, 71], [15, 42, 59], [30, 25, 76]]), 'UP');
    // 25c is the final sample and has nothing after it, so the recorded marks are the first two.
    expect(marks.map((mark) => mark.askCents)).toEqual([30, 42]);
    const entry = bandEntry(
      { contractId: 'c', symbol: 'BTC', closesAt: 'x', side: 'UP', marks },
      { entryLowCents: 40, entryHighCents: 45 }, 600,
    );
    expect(entry?.askCents).toBe(42);
  });

  it('carries the trough owned-side bid reachable strictly after each offset', () => {
    // bid(UP) = 100 - ask(DOWN): 29, then 45, then 60. After offset 0 the trough is 45, after 15 it is 60.
    const marks = candidateMarks(path([[0, 40, 71], [15, 30, 55], [30, 20, 40]]), 'UP');
    expect(marks[0].troughBidAfterCents).toBe(45);
    expect(marks[1].troughBidAfterCents).toBe(60);
  });

  it('records a trough that a later recovery cannot erase', () => {
    // The bid dips to 20 and comes back to 80; a stop at 25 fired, and the peak alone cannot show that.
    const marks = candidateMarks(path([[0, 40, 55], [15, 45, 80], [30, 30, 60], [45, 25, 20]]), 'UP');
    expect(marks[0].troughBidAfterCents).toBe(20);
    expect(marks[0].peakBidAfterCents).toBe(80);
  });

  it('carries the peak owned-side bid reachable strictly after each offset', () => {
    // bid(UP) = 100 - ask(DOWN): 29, then 45, then 60. The peak after offset 0 is 60, after 15 is 60.
    const marks = candidateMarks(path([[0, 40, 71], [15, 30, 55], [30, 20, 40]]), 'UP');
    expect(marks[0].peakBidAfterCents).toBe(60);
    expect(marks[1].peakBidAfterCents).toBe(60);
    // The last sample has nothing after it, so it can never be an entry and is not recorded.
    expect(marks).toHaveLength(2);
  });

  it('derives the DOWN side from the UP ask on the shared book', () => {
    const marks = candidateMarks(path([[0, 71, 30], [15, 55, 44], [30, 40, 61]]), 'DOWN');
    expect(marks.map((mark) => mark.askCents)).toEqual([30, 44]);
    expect(marks[0].peakBidAfterCents).toBe(60);
  });

  it('fails closed on a missing quote rather than recording a free contract', () => {
    const marks = candidateMarks(path([[0, 0, 71], [15, 30, 55], [30, 20, 40]]), 'UP');
    expect(marks.map((mark) => mark.askCents)).toEqual([30]);
  });

  it('stops at the retained offset cap', () => {
    const beyond = CANDIDATE_OFFSET_CAP_SECONDS + 15;
    const marks = candidateMarks(path([[0, 40, 61], [beyond, 12, 85], [beyond + 15, 10, 88]]), 'UP');
    expect(marks.map((mark) => mark.askCents)).toEqual([40]);
  });

  it('produces one candidate per side that showed a quote', () => {
    const candidates = candidatesFromPath(path([[0, 40, 61], [15, 30, 71], [30, 20, 81]]), 'DOWN');
    expect(candidates.map((candidate) => candidate.side)).toEqual(['UP', 'DOWN']);
    expect(candidates.every((candidate) => candidate.settledSide === 'DOWN')).toBe(true);
  });
});

describe('band entry', () => {
  const candidate = (marks: Array<[number, number, number]>): LongShotCandidate => ({
    contractId: 'c', symbol: 'BTC', closesAt: '2026-08-15T00:15:00Z', side: 'UP',
    marks: marks.map(([offsetSeconds, askCents, peakBidAfterCents]) => ({
      offsetSeconds, askCents, peakBidAfterCents, troughBidAfterCents: 0,
    })),
  });

  it('takes the earliest qualifying mark, not the cheapest', () => {
    const entry = bandEntry(candidate([[60, 12, 40], [30, 14, 95]]), { entryLowCents: 10, entryHighCents: 15 }, 600);
    expect(entry?.askCents).toBe(14);
  });

  it('treats the entry range as exclusive low and inclusive high', () => {
    const rows = candidate([[0, 10, 50], [15, 15, 60]]);
    expect(bandEntry(rows, { entryLowCents: 10, entryHighCents: 15 }, 600)?.askCents).toBe(15);
    expect(bandEntry(rows, { entryLowCents: 9, entryHighCents: 10 }, 600)?.askCents).toBe(10);
  });

  it('applies the entry window at query time, so it is never baked into storage', () => {
    const rows = candidate([[450, 12, 95]]);
    // 450s in leaves 450s on the clock: inside a 300s requirement, outside a 600s one.
    expect(bandEntry(rows, { entryLowCents: 10, entryHighCents: 15 }, 300)?.askCents).toBe(12);
    expect(bandEntry(rows, { entryLowCents: 10, entryHighCents: 15 }, 600)).toBeNull();
  });

  it('returns null when no mark lands inside the band', () => {
    expect(bandEntry(candidate([[0, 40, 90]]), { entryLowCents: 10, entryHighCents: 15 }, 600)).toBeNull();
  });
});

describe('candidate wire form', () => {
  it('round-trips through encode and decode', () => {
    const candidate = candidatesFromPath(path([[0, 40, 61], [15, 30, 71], [30, 20, 81]]), 'UP')[0];
    expect(decodeCandidate(encodeCandidate(candidate))).toEqual(candidate);
  });

  it('round-trips an unresolved window without inventing a settlement', () => {
    const candidate = candidatesFromPath(path([[0, 40, 61], [15, 30, 71], [30, 20, 81]]))[0];
    const decoded = decodeCandidate(encodeCandidate(candidate));
    expect(decoded?.settledSide).toBeUndefined();
  });

  it('rejects a damaged row rather than decoding a partial candidate', () => {
    expect(decodeCandidate(null)).toBeNull();
    expect(decodeCandidate(['c', 'BTC', 'not-a-date', 'UP', null, [[0, 10, 50]]])).toBeNull();
    expect(decodeCandidate(['c', 'BTC', '2026-08-15T00:15:00Z', 'SIDEWAYS', null, [[0, 10, 50]]])).toBeNull();
    expect(decodeCandidate(['c', 'BTC', '2026-08-15T00:15:00Z', 'UP', null, []])).toBeNull();
  });
});
