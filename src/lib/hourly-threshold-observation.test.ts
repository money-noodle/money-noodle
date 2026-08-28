import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);
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

  it('counts only elapsed research closes toward review milestones', async () => {
    const now = Date.now();
    const event = (id: string, closeMs: number) => JSON.stringify({
      op: 'observation',
      value: {
        id, observedAt: new Date(now - 60_000).toISOString(),
        observationWindowClosesAt: new Date(closeMs).toISOString(), symbol: 'BTC',
        marketDataAvailable: false, candidates: [],
      },
    });
    await writeFile(path.join(directory, 'hourly-threshold-observations.journal.jsonl'),
      `${event('past', now - 1_000)}\n${event('future', now + 3_600_000)}\n`);
    const { stdout } = await execFileAsync(process.execPath,
      [path.join(process.cwd(), 'scripts/analyze-hourly-threshold-observations.mjs')], {
        cwd: process.cwd(), env: { ...process.env, MONEY_NOODLE_HOURLY_OBSERVATION_PATH: directory },
      });
    expect(JSON.parse(stdout).cohort).toMatchObject({
      observedCloseWindows: 2, independentCloseWindows: 1,
    });
  });

  it('freezes the wiring review at the first ten elapsed closes and reports missing minute buckets', async () => {
    const now = Date.now();
    const firstClose = now - 12 * 3_600_000;
    const events = Array.from({ length: 11 }, (_, index) => {
      const closeMs = firstClose + index * 3_600_000;
      return JSON.stringify({
        op: 'observation',
        value: {
          id: String(index), observedAt: new Date(closeMs - 60_000).toISOString(),
          bucketAt: new Date(closeMs - 60_000).toISOString(),
          observationWindowClosesAt: new Date(closeMs).toISOString(), symbol: 'BTC',
          marketDataAvailable: false, candidates: [],
        },
      });
    });
    await writeFile(path.join(directory, 'hourly-threshold-observations.journal.jsonl'), `${events.join('\n')}\n`);
    const { stdout } = await execFileAsync(process.execPath,
      [path.join(process.cwd(), 'scripts/analyze-hourly-threshold-observations.mjs')], {
        cwd: process.cwd(), env: { ...process.env, MONEY_NOODLE_HOURLY_OBSERVATION_PATH: directory },
      });
    expect(JSON.parse(stdout).wiring10).toMatchObject({
      windows: 10, expectedMinuteBuckets: 541, observedMinuteBuckets: 10,
      missingMinuteBuckets: 531, expectedObservations: 541, observations: 10,
    });
  });

  it('refuses writer startup on a stateless host', () => {
    process.env.MONEY_NOODLE_STATELESS = 'true';
    expect(startHourlyThresholdObserver()).toBe(false);
  });
});
