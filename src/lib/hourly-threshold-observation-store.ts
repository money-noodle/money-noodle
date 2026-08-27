import 'server-only';

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HourlyThresholdCandidate, HourlyThresholdMarket, HourlyThresholdMarketsResponse,
} from './types';

export const HOURLY_THRESHOLD_OBSERVATION_VERSION = 'hourly-threshold-observation-v1' as const;
export const HOURLY_THRESHOLD_OBSERVATION_BUCKET_MS = 60_000;
export interface HourlyThresholdCandidateObservation extends HourlyThresholdCandidate {
  providerId: 'kalshi';
  marketId: 'crypto-1h';
  symbol: string;
  openAt: string;
  closesAt: string;
}

export interface HourlyThresholdObservation {
  version: typeof HOURLY_THRESHOLD_OBSERVATION_VERSION;
  id: string;
  observedAt: string;
  bucketAt: string;
  /** Scheduled UTC research window only; never substituted for an exact venue contract close. */
  observationWindowClosesAt: string;
  providerId: 'kalshi';
  marketId: 'crypto-1h';
  marketDataVersion: string;
  modelVersion: string;
  symbol: string;
  name: string;
  marketDataAvailable: boolean;
  openAt?: string;
  closesAt?: string;
  currentPrice?: number;
  volatilityPerSecond?: number;
  volatilitySamples?: number;
  unavailableReason?: string;
  candidates: HourlyThresholdCandidateObservation[];
}

export interface HourlyThresholdOutcome {
  version: typeof HOURLY_THRESHOLD_OBSERVATION_VERSION;
  providerId: 'kalshi';
  marketId: 'crypto-1h';
  ticker: string;
  rulesFingerprint: string;
  closesAt: string;
  result: 'YES' | 'NO' | 'INVALID';
  resolvedAt: string;
  resolutionSource: string;
}

type HourlyThresholdObservationEvent =
  | { op: 'observation'; value: HourlyThresholdObservation }
  | { op: 'outcome'; value: HourlyThresholdOutcome };

interface RuntimeStore {
  queue: Promise<void>;
  loaded: boolean;
  observations: Map<string, HourlyThresholdObservation>;
  outcomes: Map<string, HourlyThresholdOutcome>;
}
const runtimeKey = Symbol.for('money-noodle.hourly-threshold-observation-store');
const root = globalThis as typeof globalThis & { [runtimeKey]?: RuntimeStore };
const runtime = root[runtimeKey] ??= {
  queue: Promise.resolve(), loaded: false, observations: new Map(), outcomes: new Map(),
};

function storeDirectory(): string {
  const configured = process.env.MONEY_NOODLE_HOURLY_OBSERVATION_PATH?.trim();
  return configured ? path.resolve(/* turbopackIgnore: true */ configured) : path.join(process.cwd(), 'data');
}
function journalFile(): string { return path.join(storeDirectory(), 'hourly-threshold-observations.journal.jsonl'); }
const finiteOptional = (value: number | undefined): boolean => value === undefined || Number.isFinite(value);
const unitOptional = (value: number | undefined): boolean => value === undefined
  || (Number.isFinite(value) && value >= 0 && value <= 1);

function validCandidate(value: HourlyThresholdCandidateObservation): boolean {
  return value && value.providerId === 'kalshi' && value.marketId === 'crypto-1h'
    && typeof value.symbol === 'string' && typeof value.ticker === 'string' && value.ticker.length > 0
    && (value.direction === 'ABOVE' || value.direction === 'BELOW')
    && Number.isFinite(value.strike) && value.strike > 0
    && typeof value.rulesFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.rulesFingerprint)
    && Number.isFinite(Date.parse(value.openAt)) && Number.isFinite(Date.parse(value.closesAt))
    && Date.parse(value.closesAt) - Date.parse(value.openAt) === 3_600_000
    && [value.yesBid, value.yesAsk, value.noBid, value.noAsk, value.modelProbabilityYes].every(unitOptional)
    && (value.modelMinusAsk === undefined
      || (Number.isFinite(value.modelMinusAsk) && value.modelMinusAsk >= -1 && value.modelMinusAsk <= 1));
}
function validObservation(value: HourlyThresholdObservation): boolean {
  return value && value.version === HOURLY_THRESHOLD_OBSERVATION_VERSION
    && typeof value.id === 'string' && value.id.length > 0
    && value.providerId === 'kalshi' && value.marketId === 'crypto-1h'
    && Number.isFinite(Date.parse(value.observedAt)) && Number.isFinite(Date.parse(value.bucketAt))
    && Number.isFinite(Date.parse(value.observationWindowClosesAt))
    && Date.parse(value.observationWindowClosesAt) > Date.parse(value.observedAt)
    && typeof value.marketDataVersion === 'string' && typeof value.modelVersion === 'string'
    && typeof value.symbol === 'string' && typeof value.name === 'string'
    && typeof value.marketDataAvailable === 'boolean' && Array.isArray(value.candidates)
    && value.candidates.every(validCandidate)
    && [value.currentPrice, value.volatilityPerSecond, value.volatilitySamples].every(finiteOptional)
    && (value.currentPrice === undefined || value.currentPrice > 0)
    && (value.volatilityPerSecond === undefined || value.volatilityPerSecond > 0)
    && (value.volatilitySamples === undefined || (Number.isSafeInteger(value.volatilitySamples)
      && value.volatilitySamples > 0));
}
function validOutcome(value: HourlyThresholdOutcome): boolean {
  return value && value.version === HOURLY_THRESHOLD_OBSERVATION_VERSION
    && value.providerId === 'kalshi' && value.marketId === 'crypto-1h'
    && typeof value.ticker === 'string' && value.ticker.length > 0
    && /^[a-f0-9]{64}$/.test(value.rulesFingerprint)
    && Number.isFinite(Date.parse(value.closesAt)) && Number.isFinite(Date.parse(value.resolvedAt))
    && (value.result === 'YES' || value.result === 'NO' || value.result === 'INVALID')
    && typeof value.resolutionSource === 'string' && value.resolutionSource.length > 0;
}
function validEvent(value: unknown): value is HourlyThresholdObservationEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<HourlyThresholdObservationEvent>;
  return event.op === 'observation' ? validObservation(event.value as HourlyThresholdObservation)
    : event.op === 'outcome' ? validOutcome(event.value as HourlyThresholdOutcome) : false;
}

async function load(): Promise<void> {
  if (runtime.loaded) return;
  let raw = '';
  try { raw = await readFile(journalFile(), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as unknown;
    if (!validEvent(event)) throw new Error('Hourly threshold observation journal is malformed.');
    if (event.op === 'observation') runtime.observations.set(event.value.id, event.value);
    else {
      const existing = runtime.outcomes.get(event.value.ticker);
      if (existing && (existing.result !== event.value.result
        || existing.rulesFingerprint !== event.value.rulesFingerprint)) {
        throw new Error(`Contradictory hourly outcome for ${event.value.ticker}.`);
      }
      runtime.outcomes.set(event.value.ticker, event.value);
    }
  }
  runtime.loaded = true;
}
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtime.queue.then(operation);
  runtime.queue = result.then(() => undefined, () => undefined);
  return result;
}
async function append(event: HourlyThresholdObservationEvent): Promise<void> {
  await mkdir(storeDirectory(), { recursive: true });
  await appendFile(journalFile(), `${JSON.stringify(event)}\n`);
}

function observationFromMarket(
  response: HourlyThresholdMarketsResponse, market: HourlyThresholdMarket,
): HourlyThresholdObservation {
  const observedMs = Date.parse(response.generatedAt);
  const bucketAt = new Date(Math.floor(observedMs / HOURLY_THRESHOLD_OBSERVATION_BUCKET_MS)
    * HOURLY_THRESHOLD_OBSERVATION_BUCKET_MS).toISOString();
  const observationWindowClosesAt = new Date((Math.floor(observedMs / 3_600_000) + 1) * 3_600_000).toISOString();
  const candidates = market.openAt && market.closesAt ? market.candidates.map((candidate) => ({
    ...candidate, providerId: 'kalshi' as const, marketId: 'crypto-1h' as const,
    symbol: market.symbol, openAt: market.openAt!, closesAt: market.closesAt!,
  })) : [];
  return {
    version: HOURLY_THRESHOLD_OBSERVATION_VERSION,
    id: `${HOURLY_THRESHOLD_OBSERVATION_VERSION}:kalshi:crypto-1h:${market.symbol}:${bucketAt}`,
    observedAt: response.generatedAt, bucketAt, observationWindowClosesAt,
    providerId: 'kalshi', marketId: 'crypto-1h',
    marketDataVersion: response.marketDataVersion, modelVersion: response.modelVersion,
    symbol: market.symbol, name: market.name, marketDataAvailable: market.marketDataAvailable,
    openAt: market.openAt, closesAt: market.closesAt,
    currentPrice: market.currentPrice, volatilityPerSecond: market.volatilityPerSecond,
    volatilitySamples: market.volatilitySamples, unavailableReason: market.unavailableReason,
    candidates,
  };
}

/** One owning persistent-worker writer; duplicate asset/minute observations are idempotent. */
export function recordHourlyThresholdSnapshot(response: HourlyThresholdMarketsResponse): Promise<number> {
  return serialized(async () => {
    await load();
    if (response.marketId !== 'crypto-1h' || response.providerId !== 'kalshi'
      || response.capability.paper || response.capability.live) {
      throw new Error('Hourly H2 refused a response with execution capability.');
    }
    let written = 0;
    for (const market of response.markets) {
      const observation = observationFromMarket(response, market);
      if (!validObservation(observation)) throw new Error(`Hourly observation for ${market.symbol} is malformed.`);
      if (runtime.observations.has(observation.id)) continue;
      await append({ op: 'observation', value: observation });
      runtime.observations.set(observation.id, observation);
      written += 1;
    }
    return written;
  });
}

export function recordHourlyThresholdOutcome(value: HourlyThresholdOutcome): Promise<boolean> {
  return serialized(async () => {
    await load();
    if (!validOutcome(value)) throw new Error('Hourly threshold outcome is malformed.');
    const existing = runtime.outcomes.get(value.ticker);
    if (existing) {
      if (existing.result !== value.result || existing.rulesFingerprint !== value.rulesFingerprint) {
        throw new Error(`Contradictory hourly outcome for ${value.ticker}.`);
      }
      return false;
    }
    await append({ op: 'outcome', value });
    runtime.outcomes.set(value.ticker, value);
    return true;
  });
}

export function unresolvedHourlyThresholdContracts(nowMs = Date.now(), limit = 10): Promise<Array<{
  ticker: string; rulesFingerprint: string; closesAt: string;
}>> {
  return serialized(async () => {
    await load();
    const contracts = new Map<string, { ticker: string; rulesFingerprint: string; closesAt: string }>();
    for (const observation of runtime.observations.values()) {
      for (const candidate of observation.candidates) {
        if (Date.parse(candidate.closesAt) <= nowMs && !runtime.outcomes.has(candidate.ticker)) {
          const existing = contracts.get(candidate.ticker);
          if (existing && existing.rulesFingerprint !== candidate.rulesFingerprint) {
            throw new Error(`Hourly ticker ${candidate.ticker} changed rules fingerprint.`);
          }
          contracts.set(candidate.ticker, {
            ticker: candidate.ticker, rulesFingerprint: candidate.rulesFingerprint, closesAt: candidate.closesAt,
          });
        }
      }
    }
    return [...contracts.values()].sort((left, right) => Date.parse(left.closesAt) - Date.parse(right.closesAt)
      || left.ticker.localeCompare(right.ticker)).slice(0, Math.max(0, Math.min(10, limit)));
  });
}

export function getHourlyThresholdObservationStore(): Promise<{
  observations: HourlyThresholdObservation[]; outcomes: HourlyThresholdOutcome[];
}> {
  return serialized(async () => {
    await load();
    return {
      observations: structuredClone([...runtime.observations.values()]),
      outcomes: structuredClone([...runtime.outcomes.values()]),
    };
  });
}

export function resetHourlyThresholdObservationStoreForTests(): void {
  runtime.queue = Promise.resolve(); runtime.loaded = false;
  runtime.observations.clear(); runtime.outcomes.clear();
}
