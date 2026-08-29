import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SENTINELS, SENTINEL_REGISTRY_VERSION, holmBestArmThreshold, projectCompletion, sentinelDescriptor,
  sentinelThresholds, type SentinelThresholdProgress,
} from './sentinel-registry';

describe('sentinel registry', () => {
  it('publishes a version and unique ids', () => {
    expect(SENTINEL_REGISTRY_VERSION).toBe('sentinel-registry-v1');
    expect(new Set(SENTINELS.map((sentinel) => sentinel.id)).size).toBe(SENTINELS.length);
  });

  it('requires a stated question and a durable store for every instrument', () => {
    for (const sentinel of SENTINELS) {
      expect(sentinel.question.trim().length, sentinel.id).toBeGreaterThan(20);
      expect(sentinel.store.trim().length, sentinel.id).toBeGreaterThan(0);
    }
  });

  // A stopped experiment that does not say why it stopped is indistinguishable from one that lapsed.
  it('requires a closed reason whenever an instrument is not collecting', () => {
    for (const sentinel of SENTINELS) {
      if (sentinel.lifecycle === 'collecting') continue;
      expect(sentinel.closedReason?.trim().length ?? 0, sentinel.id).toBeGreaterThan(20);
    }
  });

  it('gives arm-bearing instruments a frozen family and observation instruments none', () => {
    for (const sentinel of SENTINELS) {
      if (sentinel.kind === 'candidate-arms') expect(sentinel.arms.length, sentinel.id).toBeGreaterThan(0);
      else expect(sentinel.arms, sentinel.id).toEqual([]);
    }
  });

  it('enumerates every sentinel store the codebase maintains', () => {
    const dir = join(process.cwd(), 'src/lib');
    const stores = readdirSync(dir).filter((file) => /-sentinel-store\.ts$/.test(file));
    const registered = SENTINELS.map((sentinel) => sentinel.store);
    for (const file of stores) {
      const stem = file.replace('-sentinel-store.ts', '');
      // Every maintained sentinel store must appear in the registry, or the view silently omits it.
      expect(registered.some((store) => store.startsWith(stem)), `${file} is not registered`).toBe(true);
    }
    expect(readFileSync(join(dir, 'sentinel-registry.ts'), 'utf8')).not.toMatch(/placeOrder|submitOrder|arm\(/);
  });

  // The Performance view feeds these same reports `funding.edgeOrders`. Passing the whole ledger here made
  // one instrument report different windows and coverage in two dialogs, with nothing saying which was right.
  it('projects sentinels from the same strategy-narrowed cohort the performance view uses', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/sentinels/route.ts'), 'utf8');
    expect(route).toMatch(/strategyOrders\(/);
    expect(route).toMatch(/EDGE_BINARY_BUY/);
    // The raw ledger must not reach a report builder unnarrowed.
    expect(route).not.toMatch(/getExitPolicySentinelReport\(\s*await getExecutionOrders/);
  });

  it('raises the Holm bar as the frozen family grows', () => {
    const two = holmBestArmThreshold(2);
    const five = holmBestArmThreshold(5);
    expect(two).toBeCloseTo(1.96, 1);
    expect(five).toBeCloseTo(2.33, 1);
    expect(five!).toBeGreaterThan(two!);
    expect(holmBestArmThreshold(0)).toBeNull();
  });

  it('reports thresholds from the constants that enforce them', () => {
    const exit = sentinelThresholds('exit-policy-sentinel-v2');
    expect(exit).toEqual({ windows: 60, divergentWindows: 20, coverage: 0.9 });
    expect(sentinelThresholds('hourly-threshold-observation-v1')).toBeNull();
  });

  it('projects completion from the observed rate and refuses to guess without one', () => {
    const opened = '2026-08-24T00:00:00.000Z';
    const now = Date.parse('2026-08-28T00:00:00.000Z');
    const thresholds: SentinelThresholdProgress[] = [{ label: 'Complete windows', current: 30, required: 60, met: false, unit: 'count' }];
    // Half the requirement in four days projects four more days.
    expect(projectCompletion(opened, thresholds, now)).toBe('2026-09-01T00:00:00.000Z');
    expect(projectCompletion(null, thresholds, now)).toBeNull();
    expect(projectCompletion(opened, [{ ...thresholds[0], current: 0 }], now)).toBeNull();
    expect(projectCompletion(opened, [{ ...thresholds[0], current: 60, met: true }], now)).toBeNull();
  });

  it('resolves a descriptor by id and returns undefined for an unknown one', () => {
    expect(sentinelDescriptor('exit-policy-sentinel-v2')?.lifecycle).toBe('retired');
    expect(sentinelDescriptor('nope')).toBeUndefined();
  });
});
