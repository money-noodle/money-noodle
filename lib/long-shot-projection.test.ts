import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { publicLongShotPayload } from './long-shot-projection';

/**
 * The replicated payload is where the live/paper boundary is enforced. A reader cannot drop a field it
 * was never told about, so this is the only place the decision is made — and the only place to test it.
 */
const full = {
  policyVersion: 'long-shot-round-trip-buy10-sell90-win600-v1',
  enabled: true,
  liveEnabled: true,
  settings: { entryMarkCents: 10, exitMarkCents: 90 },
  allocation: { startingCents: 600, funded: true, fundedAt: '2026-08-15T08:20:34.848Z' },
  tracks: [
    { mode: 'paper', equityCents: 525, ticketCents: 17, report: { submitted: 4 } },
    { mode: 'live', equityCents: 571, ticketCents: 19, report: { submitted: 3 } },
  ],
  hold: { samples: 4 },
  contractPaths: { windows: 200, samples: 1796 },
};

describe('public long-shot projection', () => {
  const published = publicLongShotPayload(full);

  it('publishes the paper lane', () => {
    expect(published.paper).toMatchObject({ mode: 'paper', equityCents: 525, ticketCents: 17 });
  });

  it('never publishes the live lane', () => {
    // A hosted deployment has no execution authority and no way to reconcile a venue position, so real
    // equity, tickets, and P&L must not leave the worker.
    expect(published.tracks).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain('"live"');
    expect(JSON.stringify(published)).not.toContain('571');
  });

  it('never publishes live arming state, which belongs to the worker that can act on it', () => {
    expect(published.liveEnabled).toBeUndefined();
    expect(Object.keys(published)).not.toContain('liveEnabled');
  });

  it('carries the evidence a reader needs to judge the paper lane', () => {
    expect(published.policyVersion).toBe(full.policyVersion);
    expect(published.settings).toEqual(full.settings);
    expect(published.hold).toEqual(full.hold);
    expect(published.contractPaths).toEqual(full.contractPaths);
  });

  it('reports a missing paper lane as null rather than inventing one', () => {
    expect(publicLongShotPayload({ ...full, tracks: [] }).paper).toBeNull();
    expect(publicLongShotPayload({}).paper).toBeNull();
  });
});
