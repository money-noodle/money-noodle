import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  WITHHELD_CLASSES, attributeLiveSkips, replayLiveSkipEvents, windowsWithheldBy,
  type LiveSkipEvent,
} from './live-skip';

const event = (at: string, classification: LiveSkipEvent['classification'], reason: string, windows: string[] = [], extra: Partial<LiveSkipEvent> = {}): LiveSkipEvent =>
  ({ at, classification, reason, windows, ...extra });

describe('live skip episodes', () => {
  it('folds consecutive identical cycles into one episode instead of one row per cycle', () => {
    // The live cycle runs about every 15 seconds. A six-hour risk stop is one fact, not 1,440 of them.
    const events = Array.from({ length: 240 }, (_, index) =>
      event(new Date(Date.UTC(2026, 7, 19, 9, 30 + index / 4)).toISOString(), 'stop', 'Automation is paused.', ['2026-08-19T10:00:00Z']));
    const records = replayLiveSkipEvents(events);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ classification: 'stop', cycles: 240 });
    expect(records[0].firstAt).toBe(events[0].at);
    expect(records[0].lastAt).toBe(events.at(-1)!.at);
  });

  it('opens a new episode when the reason changes, and again when it changes back', () => {
    const records = replayLiveSkipEvents([
      event('2026-08-19T09:30:00Z', 'stop', 'Automation is paused.'),
      event('2026-08-19T09:30:15Z', 'stop', 'Automation is paused.'),
      event('2026-08-19T09:30:30Z', 'none', 'No new positive-edge binary buy qualifies right now.'),
      event('2026-08-19T09:30:45Z', 'stop', 'Automation is paused.'),
    ]);
    expect(records.map((record) => [record.classification, record.cycles]))
      .toEqual([['stop', 2], ['none', 1], ['stop', 1]]);
  });

  it('separates two candidates skipped for the same reason in the same cycle', () => {
    const records = replayLiveSkipEvents([
      event('2026-08-19T09:30:00Z', 'persistence', 'not ready', [], { symbol: 'BTC', side: 'UP' }),
      event('2026-08-19T09:30:00Z', 'persistence', 'not ready', [], { symbol: 'ETH', side: 'DOWN' }),
    ]);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.symbol)).toEqual(['BTC', 'ETH']);
  });

  it('accumulates every settlement window an episode spanned', () => {
    const records = replayLiveSkipEvents([
      event('2026-08-19T09:30:00Z', 'stop', 'paused', ['2026-08-19T09:45:00Z']),
      event('2026-08-19T09:46:00Z', 'stop', 'paused', ['2026-08-19T10:00:00Z']),
      event('2026-08-19T10:01:00Z', 'stop', 'paused', ['2026-08-19T10:15:00Z', '2026-08-19T10:00:00Z']),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].windows.sort()).toEqual(['2026-08-19T09:45:00Z', '2026-08-19T10:00:00Z', '2026-08-19T10:15:00Z']);
  });

  it('extends an episode across a reload rather than splitting it', () => {
    const first = replayLiveSkipEvents([event('2026-08-19T09:30:00Z', 'stop', 'paused', ['w1'])]);
    const second = replayLiveSkipEvents([event('2026-08-19T09:30:15Z', 'stop', 'paused', ['w2'])], first);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ cycles: 2, windows: ['w1', 'w2'] });
  });

  it('does not mutate the records it was handed', () => {
    const existing = replayLiveSkipEvents([event('2026-08-19T09:30:00Z', 'stop', 'paused', ['w1'])]);
    const snapshot = JSON.stringify(existing);
    replayLiveSkipEvents([event('2026-08-19T09:30:15Z', 'stop', 'paused', ['w2'])], existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('drops malformed events rather than recording a skip it cannot explain', () => {
    const records = replayLiveSkipEvents([
      { at: '', classification: 'stop', reason: 'x', windows: [] },
      { at: '2026-08-19T09:30:00Z', classification: 'stop', reason: undefined as never, windows: [] },
      event('2026-08-19T09:30:00Z', 'stop', 'real'),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe('real');
  });
});

describe('attribution', () => {
  const records = replayLiveSkipEvents([
    event('2026-08-19T09:30:00Z', 'stop', 'paused', ['w1', 'w2']),
    event('2026-08-19T16:00:00Z', 'none', 'nothing qualifies', ['w3']),
    event('2026-08-19T17:00:00Z', 'stop', 'lifetime loss stop', ['w2', 'w4']),
    event('2026-08-19T18:00:00Z', 'rate_limit', 'hourly ceiling', ['w5']),
  ]);

  it('rolls up per class, counting distinct windows rather than cycles', () => {
    const stop = attributeLiveSkips(records).find((row) => row.classification === 'stop')!;
    // w2 appears in both stop episodes and must be counted once.
    expect(stop).toMatchObject({ episodes: 2, cycles: 2, windows: 3 });
    expect(stop.firstAt).toBe('2026-08-19T09:30:00Z');
    expect(stop.lastAt).toBe('2026-08-19T17:00:00Z');
  });

  it('answers the question the divergence review had to reconstruct by hand', () => {
    expect(windowsWithheldBy(records, 'stop')).toEqual(['w1', 'w2', 'w4']);
    expect(windowsWithheldBy(records, 'budget')).toEqual([]);
  });

  it('treats a reduce-only no-fill as fill drag, not portfolio drag', () => {
    // SPEC 12.3 decomposes paper - live into fill, limit and stop drag. Folding a switch exit no-fill
    // into `portfolio` would attribute an execution failure to a ranking decision.
    const fillDrag = replayLiveSkipEvents([
      event('2026-08-19T09:30:00Z', 'fill', 'BTC reduce-only switch exit did not fill; incumbent retained.', ['w1'], { symbol: 'BTC', side: 'UP' }),
    ]);
    expect(windowsWithheldBy(fillDrag, 'fill')).toEqual(['w1']);
    expect(windowsWithheldBy(fillDrag, 'portfolio')).toEqual([]);
    expect(WITHHELD_CLASSES).toContain('fill');
  });

  it('keeps "nothing qualified" out of the withheld classes', () => {
    // `none` is the desk working as intended; pooling it with stop drag would overstate every channel.
    expect(WITHHELD_CLASSES).not.toContain('none');
    expect(attributeLiveSkips(records).some((row) => row.classification === 'none')).toBe(true);
  });
});
