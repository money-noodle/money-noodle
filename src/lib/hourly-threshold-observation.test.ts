import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { listArchiveCandidates } from './local-data-archive';
import {
  HOURLY_THRESHOLD_OBSERVATION_VERSION, getHourlyThresholdObservationStore,
  recordHourlyThresholdSnapshot, resetHourlyThresholdObservationStoreForTests,
  unresolvedHourlyThresholdContracts,
} from './hourly-threshold-observation-store';
import {
  collectHourlyThresholdObservations, resetHourlyThresholdObserverForTests, startHourlyThresholdObserver,
} from './hourly-threshold-observer';
import type { HourlyThresholdMarketsResponse } from './types';

const at = '2026-08-27T03:00:00.000Z';
const response = (): HourlyThresholdMarketsResponse => ({
  generatedAt: at, expiresAt: '2026-08-27T03:01:00.000Z', marketId: 'crypto-1h', providerId: 'kalshi',
  marketDataVersion: 'kalshi-hourly-threshold-read-v1', modelVersion: 'strike-threshold-zero-drift-v1',
  capability: { marketData: true, paper: false, live: false },
  markets: [{
    marketId: 'crypto-1h', providerId: 'kalshi', symbol: 'BTC', name: 'Bitcoin', marketDataAvailable: true,
    openAt: '2026-08-27T02:00:00.000Z', closesAt: '2026-08-27T03:00:00.000Z',
    currentPrice: 100, volatilityPerSecond: 0.001, volatilitySamples: 120,
    candidates: [{
      direction: 'ABOVE', displaySide: 'UP', ticker: 'KXBTC-TEST-T120', strike: 120,
      relation: 'greater-than', label: 'Above 120', yesBid: 0.01, yesAsk: 0.02,
      noBid: 0.98, noAsk: 0.99, modelProbabilityYes: 0.01, modelMinusAsk: -0.01,
      rulesFingerprint: 'a'.repeat(64), marketUrl: 'https://kalshi.com/markets/kxbtc',
    }, {
      direction: 'BELOW', displaySide: 'DOWN', ticker: 'KXBTC-TEST-T80', strike: 80,
      relation: 'less-than', label: 'Below 80', yesBid: 0.01, yesAsk: 0.02,
      noBid: 0.98, noAsk: 0.99, modelProbabilityYes: 0.01, modelMinusAsk: -0.01,
      rulesFingerprint: 'b'.repeat(64), marketUrl: 'https://kalshi.com/markets/kxbtc',
    }],
  }],
});

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'hourly-observation-'));
  process.env.MONEY_NOODLE_HOURLY_OBSERVATION_PATH = directory;
  resetHourlyThresholdObservationStoreForTests();
  resetHourlyThresholdObserverForTests();
});
afterEach(async () => {
  delete process.env.MONEY_NOODLE_HOURLY_OBSERVATION_PATH;
  delete process.env.MONEY_NOODLE_STATELESS;
  resetHourlyThresholdObservationStoreForTests();
  resetHourlyThresholdObserverForTests();
  await rm(directory, { recursive: true, force: true });
});

describe('hourly threshold H2 observation store', () => {
  it('appends one immutable asset/minute observation and preserves independent exact candidates', async () => {
    expect(await recordHourlyThresholdSnapshot(response())).toBe(1);
    expect(await recordHourlyThresholdSnapshot(response())).toBe(0);
    const store = await getHourlyThresholdObservationStore();
    expect(store.observations).toHaveLength(1);
    expect(store.observations[0]).toMatchObject({
      version: HOURLY_THRESHOLD_OBSERVATION_VERSION, symbol: 'BTC', marketDataAvailable: true,
      candidates: [
        { direction: 'ABOVE', ticker: 'KXBTC-TEST-T120', rulesFingerprint: 'a'.repeat(64) },
        { direction: 'BELOW', ticker: 'KXBTC-TEST-T80', rulesFingerprint: 'b'.repeat(64) },
      ],
    });
    expect((await readFile(path.join(directory, 'hourly-threshold-observations.journal.jsonl'), 'utf8'))
      .trim().split('\n')).toHaveLength(1);
  });

  it('exposes closed exact contracts for resolution and archives the journal', async () => {
    await recordHourlyThresholdSnapshot(response());
    expect(await unresolvedHourlyThresholdContracts(Date.parse(at))).toEqual([
      { ticker: 'KXBTC-TEST-T120', rulesFingerprint: 'a'.repeat(64), closesAt: at },
      { ticker: 'KXBTC-TEST-T80', rulesFingerprint: 'b'.repeat(64), closesAt: at },
    ]);
    expect(await listArchiveCandidates(directory)).toContain('hourly-threshold-observations.journal.jsonl');
  });

  it('records exact public outcomes after observation without changing the observation', async () => {
    const outcomes: unknown[] = [];
    await collectHourlyThresholdObservations({
      markets: async () => response(), recordSnapshot: recordHourlyThresholdSnapshot,
      unresolved: async () => [{ ticker: 'KXBTC-TEST-T120', rulesFingerprint: 'a'.repeat(64), closesAt: at }],
      outcome: async () => 'YES', now: () => Date.parse(at) + 1_000,
      recordOutcome: async (value) => { outcomes.push(value); return true; },
    });
    expect(outcomes).toEqual([expect.objectContaining({
      ticker: 'KXBTC-TEST-T120', result: 'YES', rulesFingerprint: 'a'.repeat(64),
    })]);
    expect((await getHourlyThresholdObservationStore()).observations).toHaveLength(1);
  });

  it('refuses writer startup on a stateless host', () => {
    process.env.MONEY_NOODLE_STATELESS = 'true';
    expect(startHourlyThresholdObserver()).toBe(false);
  });
});
