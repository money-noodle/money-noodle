import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { abandonedByVenue, replayForecastJournal, resolutionDue, resolutionRetryDelayMs, type ForecastJournalEvent } from './forecast-tracker';
import type { TrackedForecast } from './types';

function forecast(id: string, status: TrackedForecast['status'] = 'pending'): TrackedForecast {
  return {
    id, symbol: 'BTC', marketUrl: 'https://example.com/btc', issuedAt: '2026-08-11T00:00:00Z',
    closesAt: '2026-08-11T00:15:00Z', direction: 'UP', probabilityUp: 0.6,
    directionalLikelihood: 0.6, confidence: 0.7, modelVersion: 'test', policyVersion: 'test',
    polymarketProbabilityUp: 0.5, factors: [], status,
  };
}

describe('forecast append journal replay', () => {
  it('applies durable upserts, resolution patches, and retention tombstones in order', () => {
    const events: ForecastJournalEvent[] = [
      { op: 'patch', id: 'old', changes: { status: 'resolved', outcome: 'UP', correct: true } },
      { op: 'upsert', forecast: forecast('new') },
      { op: 'delete', id: 'remove' },
    ];
    const replayed = replayForecastJournal([forecast('old'), forecast('remove')], events);
    expect(replayed.map((item) => item.id)).toEqual(['old', 'new']);
    expect(replayed[0]).toMatchObject({ status: 'resolved', outcome: 'UP', correct: true });
  });

  it('is idempotent when a journal survives snapshot compaction', () => {
    const updated = forecast('same', 'resolved');
    const event: ForecastJournalEvent = { op: 'upsert', forecast: updated };
    expect(replayForecastJournal([updated], [event, event])).toEqual([updated]);
  });
});

describe('resolution backoff', () => {
  const closed = (over: Partial<TrackedForecast> = {}): TrackedForecast => ({
    ...forecast('BTC:closed'), closesAt: '2026-08-11T00:15:00Z', ...over,
  });
  const now = Date.parse('2026-08-11T01:00:00Z');

  it('retries a never-checked closed forecast immediately', () => {
    expect(resolutionDue(closed(), now)).toBe(true);
  });

  it('never resolves a window that has not closed yet', () => {
    expect(resolutionDue(closed({ closesAt: '2026-08-11T02:00:00Z' }), now)).toBe(false);
  });

  it('leaves already-settled forecasts alone', () => {
    expect(resolutionDue(closed({ status: 'resolved' }), now)).toBe(false);
    expect(resolutionDue(closed({ status: 'invalid' }), now)).toBe(false);
  });

  it('doubles the delay per failed attempt so a dead contract stops costing a request a minute', () => {
    expect(resolutionRetryDelayMs(0)).toBe(60_000);
    expect(resolutionRetryDelayMs(1)).toBe(60_000);
    expect(resolutionRetryDelayMs(2)).toBe(120_000);
    expect(resolutionRetryDelayMs(4)).toBe(480_000);
    // Capped, so a permanently unresolvable forecast still gets checked twice an hour.
    expect(resolutionRetryDelayMs(50)).toBe(30 * 60_000);
  });

  it('holds a repeatedly-failing forecast back until its widened delay elapses', () => {
    const checkedAt = new Date(now - 90_000).toISOString();
    // One failure: the 60s delay has passed, so it is due again.
    expect(resolutionDue(closed({ lastResolutionCheckAt: checkedAt, resolutionAttempts: 1 }), now)).toBe(true);
    // Three failures: the delay is 4 minutes, so 90 seconds is not enough.
    expect(resolutionDue(closed({ lastResolutionCheckAt: checkedAt, resolutionAttempts: 3 }), now)).toBe(false);
  });

  it('journals the attempt counter so backoff survives a restart', () => {
    const stuck = closed({ resolutionAttempts: 3, lastResolutionCheckAt: '2026-08-11T00:30:00Z' });
    const events: ForecastJournalEvent[] = [{ op: 'patch', id: stuck.id, changes: { resolutionAttempts: 4 } }];
    expect(replayForecastJournal([stuck], events)[0].resolutionAttempts).toBe(4);
  });
});

describe('venue abandonment', () => {
  const closesAt = '2026-08-14T07:15:00Z';
  const close = Date.parse(closesAt);

  it('does not abandon a forecast inside the observed settlement tail', () => {
    // The slowest real settlement observed was 146 minutes, so hours of silence must not be terminal.
    expect(abandonedByVenue({ ...forecast('a'), closesAt }, close + 150 * 60_000)).toBe(false);
    expect(abandonedByVenue({ ...forecast('a'), closesAt }, close + 5 * 3_600_000)).toBe(false);
  });

  it('abandons only after the venue has been silent for six hours', () => {
    expect(abandonedByVenue({ ...forecast('a'), closesAt }, close + 6 * 3_600_000)).toBe(true);
  });
});
