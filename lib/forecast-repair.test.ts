import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { recoverForecastRows, type ForecastRecoverySource } from './forecast-repair';
import type { TrackedForecast } from './types';

function row(id: string, patch: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id, symbol: 'BTC', marketUrl: 'https://example.test/btc', issuedAt: '2026-08-22T00:00:00Z',
    closesAt: '2026-08-22T00:15:00Z', direction: 'UP', probabilityUp: 0.6,
    directionalLikelihood: 0.6, confidence: 0.6, modelVersion: 'test', policyVersion: 'test',
    polymarketProbabilityUp: 0.5, factors: [], status: 'pending', qualified: true, ...patch,
  };
}
function source(label: string, patch: Partial<ForecastRecoverySource> = {}): ForecastRecoverySource {
  return {
    label, indexFile: `${label}/index.json`, indexHash: label, journalFile: `${label}/journal`,
    journalHash: label, sealed: [], open: [], events: [], diagnostics: [], ...patch,
  };
}

describe('forecast recovery merge', () => {
  it('restores archived qualified evidence and lets terminal rows beat stale pending copies', () => {
    const resolved = row('resolved', { status: 'resolved', outcome: 'UP', correct: true, resolvedAt: '2026-08-22T00:16:00Z' });
    const result = recoverForecastRows(
      source('archive', { open: [row('archive-only'), row('resolved')] }),
      source('current', { sealed: [resolved], open: [row('resolved'), row('current-only')] }),
    );
    expect(result.restoredQualifiedIds).toEqual(['archive-only']);
    expect(result.ignoredStalePending).toBe(1);
    expect(result.rows.find((item) => item.id === 'resolved')).toEqual(resolved);
    expect(result.rows.map((item) => item.id).sort()).toEqual(['archive-only', 'current-only', 'resolved']);
  });

  it('never permits retention to remove qualified rows', () => {
    const archive = source('archive', { open: [row('qualified')] });
    const current = source('current', { open: [
      row('u1', { qualified: false, issuedAt: '2026-08-22T00:00:01Z' }),
      row('u2', { qualified: false, issuedAt: '2026-08-22T00:00:02Z' }),
    ] });
    const result = recoverForecastRows(archive, current, 1);
    expect(result.rows.map((item) => item.id).sort()).toEqual(['qualified', 'u2']);
    expect(result.prunedUnqualified).toBe(1);
  });

  it('recovers the first observation when concurrent writers terminalized different payloads under one bucketed ID', () => {
    const later = row('same', { issuedAt: '2026-08-22T00:00:02Z', status: 'resolved', outcome: 'UP', probabilityUp: 0.7 });
    const earlier = row('same', { issuedAt: '2026-08-22T00:00:01Z', status: 'resolved', outcome: 'UP', probabilityUp: 0.6 });
    const result = recoverForecastRows(source('archive', { sealed: [later] }), source('current', { sealed: [earlier] }));
    expect(result.rows).toEqual([earlier]);
    expect(result.canonicalizedTerminalCollisions).toBe(1);
  });

  it('fails closed on conflicting terminal statements for one identity', () => {
    expect(() => recoverForecastRows(
      source('archive', { sealed: [row('same', { status: 'resolved', outcome: 'UP' })] }),
      source('current', { sealed: [row('same', { status: 'resolved', outcome: 'DOWN' })] }),
    )).toThrow('conflicting terminal statements');
  });

  it('fails closed if a journal attempts to delete qualified evidence', () => {
    expect(() => recoverForecastRows(
      source('archive', { open: [row('qualified')] }),
      source('current', { events: [{ op: 'delete', id: 'qualified' }] }),
    )).toThrow('deletion of qualified forecast');
  });
});
