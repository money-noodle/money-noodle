import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { replayForecastJournal, type ForecastJournalEvent } from './forecast-tracker';
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
