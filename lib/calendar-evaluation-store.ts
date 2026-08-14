import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CalendarCandidateObservation, CalendarCohortReport, CalendarEvaluationReport,
  CalendarForecastObservation, CalendarWindowObservation, PositionSide,
} from './types';

export const CALENDAR_EVALUATION_VERSION = 'calendar-effects-v1';
export const CALENDAR_EVALUATION_TIME_ZONE = 'America/Los_Angeles';
export const CALENDAR_MINIMUM_TIME_REVIEW_DATES = 30;
export const CALENDAR_MINIMUM_CANDIDATE_WINDOWS = 100;
export const CALENDAR_MINIMUM_WEEKDAY_OCCURRENCES = 12;
export function calendarFixedSnapshotDue(secondsRemaining: number): boolean {
  return Number.isFinite(secondsRemaining) && secondsRemaining <= 300 && secondsRemaining >= 270;
}
const DATA_DIR = path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'calendar-evaluation.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'calendar-evaluation.journal.jsonl');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;
let operationQueue: Promise<void> = Promise.resolve();
let storeCache: Promise<CalendarEvaluationStore> | undefined;
let storeCacheFingerprint = '';
const localPartCache = new Map<string, { hour: number; date: string; weekday: string }>();
const localFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CALENDAR_EVALUATION_TIME_ZONE, hour: '2-digit', hourCycle: 'h23',
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
});

interface CalendarEvaluationStore {
  version: 1;
  collectionVersion: string;
  startedAt: string;
  updatedAt: string;
  forecasts: CalendarForecastObservation[];
  windows: CalendarWindowObservation[];
}

export interface CalendarEvaluationCycle {
  productionPolicyVersion: string;
  observedAt: string;
  forecasts: CalendarForecastObservation[];
  windows: CalendarWindowObservation[];
}

export type CalendarEvaluationEvent =
  | { op: 'forecast'; value: CalendarForecastObservation }
  | { op: 'window'; value: CalendarWindowObservation };

function emptyStore(): CalendarEvaluationStore {
  const now = new Date().toISOString();
  return { version: 1, collectionVersion: CALENDAR_EVALUATION_VERSION, startedAt: now, updatedAt: now, forecasts: [], windows: [] };
}

export function replayCalendarEvaluationEvents(
  initial: Pick<CalendarEvaluationStore, 'forecasts' | 'windows'>,
  events: CalendarEvaluationEvent[],
): Pick<CalendarEvaluationStore, 'forecasts' | 'windows'> {
  const forecasts = new Map(initial.forecasts.map((item) => [item.id, item]));
  const windows = new Map(initial.windows.map((item) => [item.id, item]));
  for (const event of events) {
    if (event.op === 'forecast' && event.value?.id) forecasts.set(event.value.id, event.value);
    else if (event.op === 'window' && event.value?.id) windows.set(event.value.id, event.value);
  }
  return { forecasts: [...forecasts.values()], windows: [...windows.values()] };
}

async function readSnapshot(): Promise<CalendarEvaluationStore> {
  try {
    const raw = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as Partial<CalendarEvaluationStore>;
    if (!Array.isArray(raw.forecasts) || !Array.isArray(raw.windows)) throw new Error('Calendar snapshot collections are missing.');
    return {
      version: 1,
      collectionVersion: raw.collectionVersion ?? CALENDAR_EVALUATION_VERSION,
      startedAt: raw.startedAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      forecasts: raw.forecasts,
      windows: raw.windows,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    await rename(SNAPSHOT_FILE, `${SNAPSHOT_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Calendar evaluation snapshot was malformed and has been quarantined:', error);
    return emptyStore();
  }
}

async function loadStore(): Promise<CalendarEvaluationStore> {
  const store = await readSnapshot();
  let raw = '';
  try { raw = await readFile(JOURNAL_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: CalendarEvaluationEvent[] = [];
  const valid: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as CalendarEvaluationEvent;
      events.push(event);
      valid.push(line);
    } catch {
      console.error('Calendar evaluation journal had a damaged trailing event; preserving its valid prefix.');
      await writeFile(`${JOURNAL_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
      await atomicWrite(JOURNAL_FILE, valid.length ? `${valid.join('\n')}\n` : '');
      break;
    }
  }
  const replayed = replayCalendarEvaluationEvents(store, events);
  const startTimes = [
    ...replayed.forecasts.map((item) => item.observedAt),
    ...replayed.windows.map((item) => item.firstObservedAt),
  ].filter((value) => Number.isFinite(Date.parse(value))).sort();
  const updateTimes = [
    ...startTimes,
    ...replayed.forecasts.flatMap((item) => item.resolvedAt ? [item.resolvedAt] : []),
    ...replayed.windows.flatMap((item) => item.finalizedAt ? [item.finalizedAt] : []),
  ].sort();
  return { ...store, ...replayed, ...(startTimes.length ? { startedAt: startTimes[0], updatedAt: updateTimes.at(-1)! } : {}) };
}

async function storageFingerprint(): Promise<string> {
  const [snapshot, journal] = await Promise.all([
    stat(SNAPSHOT_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
    stat(JOURNAL_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
  ]);
  return `${snapshot}|${journal}`;
}

async function readStore(): Promise<CalendarEvaluationStore> {
  const fingerprint = await storageFingerprint();
  // The collector and a route handler can load separate Next.js module instances in one process.
  // File identity, rather than module memory alone, keeps a read-only report from freezing at its first view.
  if (!storeCache || fingerprint !== storeCacheFingerprint) {
    storeCache = loadStore();
    storeCacheFingerprint = fingerprint;
  }
  try { return await storeCache; }
  catch (error) { storeCache = undefined; storeCacheFingerprint = ''; throw error; }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function persistEvents(store: CalendarEvaluationStore, events: CalendarEvaluationEvent[]): Promise<void> {
  if (!events.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(JOURNAL_FILE, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const journalSize = await stat(JOURNAL_FILE).then((value) => value.size).catch(() => 0);
  if (journalSize >= JOURNAL_COMPACTION_BYTES) {
    await atomicWrite(SNAPSHOT_FILE, JSON.stringify(store));
    await atomicWrite(JOURNAL_FILE, '');
  }
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function localParts(at: string): { hour: number; date: string; weekday: string } {
  const cached = localPartCache.get(at);
  if (cached) return cached;
  const parts = Object.fromEntries(localFormatter.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const result = { hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
  localPartCache.set(at, result);
  return result;
}

function clusterForecasts(forecasts: CalendarForecastObservation[], value: (item: CalendarForecastObservation) => number | undefined) {
  const windows = new Map<string, number[]>();
  for (const forecast of forecasts) {
    const result = value(forecast);
    if (!Number.isFinite(result)) continue;
    windows.set(forecast.closesAt, [...(windows.get(forecast.closesAt) ?? []), result!]);
  }
  return { windows: windows.size, mean: mean([...windows.values()].map((items) => mean(items)!)) };
}

function candidateStats(windows: CalendarWindowObservation[]) {
  const values = windows.flatMap((window) => Number.isFinite(window.candidate?.askProfitPerContract)
    ? [window.candidate!.askProfitPerContract!] : []);
  const average = mean(values);
  const standardError = average !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { values, average, standardError };
}

function cohort(
  key: string,
  label: string,
  windows: CalendarWindowObservation[],
  forecasts: CalendarForecastObservation[],
): CalendarCohortReport {
  const accuracy = clusterForecasts(forecasts, (forecast) => forecast.correct === undefined ? undefined : forecast.correct ? 1 : 0);
  const brier = clusterForecasts(forecasts, (forecast) => forecast.brierScore);
  const candidate = candidateStats(windows);
  return {
    key, label, observedWindows: windows.length,
    calendarDates: new Set(windows.map((window) => localParts(window.evaluationAt).date)).size,
    fixedForecasts: forecasts.length, resolvedForecastWindows: brier.windows,
    forecastAccuracy: accuracy.mean, brierScore: brier.mean,
    candidateWindows: windows.filter((window) => window.candidateStatus === 'selected').length,
    resolvedCandidateWindows: candidate.values.length,
    noCandidateWindows: windows.filter((window) => window.candidateStatus === 'none').length,
    meanAskProfitPerContract: candidate.average, askStandardError: candidate.standardError,
    meanMakerExpectedProfitPerContract: mean(windows.flatMap((window) => Number.isFinite(window.candidate?.makerExpectedProfitPerContract)
      ? [window.candidate!.makerExpectedProfitPerContract!] : [])),
  };
}

/** Pure, current-policy report. Collection persists old policy cohorts but never blends them. */
export function buildCalendarEvaluationReport(
  store: Pick<CalendarEvaluationStore, 'collectionVersion' | 'startedAt' | 'updatedAt' | 'forecasts' | 'windows'>,
  productionPolicyVersion: string,
): CalendarEvaluationReport {
  const windows = store.windows.filter((item) => item.collectionVersion === store.collectionVersion && item.policyVersion === productionPolicyVersion);
  const forecasts = store.forecasts.filter((item) => item.collectionVersion === store.collectionVersion && item.policyVersion === productionPolicyVersion);
  const bands = Array.from({ length: 6 }, (_, index) => {
    const start = index * 4;
    const selectedWindows = windows.filter((window) => Math.floor(localParts(window.evaluationAt).hour / 4) === index);
    const selectedForecasts = forecasts.filter((forecast) => Math.floor(localParts(new Date(Date.parse(forecast.closesAt) - 300_000).toISOString()).hour / 4) === index);
    return cohort(String(index), `${String(start).padStart(2, '0')}–${String(start + 4).padStart(2, '0')}`, selectedWindows, selectedForecasts);
  });
  const weekdayOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdays = weekdayOrder.map((day) => cohort(
    day, day,
    windows.filter((window) => localParts(window.evaluationAt).weekday === day),
    forecasts.filter((forecast) => localParts(new Date(Date.parse(forecast.closesAt) - 300_000).toISOString()).weekday === day),
  ));
  const resolvedForecasts = forecasts.filter((forecast) => forecast.resolvedAt && forecast.brierScore !== undefined);
  const distinctDates = new Set(windows.map((window) => localParts(window.evaluationAt).date)).size;
  return {
    collectionVersion: store.collectionVersion,
    productionPolicyVersion, timeZone: CALENDAR_EVALUATION_TIME_ZONE,
    startedAt: store.startedAt, updatedAt: store.updatedAt,
    fixedForecasts: forecasts.length, resolvedForecasts: resolvedForecasts.length,
    observedWindows: windows.length,
    resolvedCandidateWindows: windows.filter((window) => window.candidate?.resolvedAt && window.candidate.askProfitPerContract !== undefined).length,
    noCandidateWindows: windows.filter((window) => window.candidateStatus === 'none').length,
    distinctCalendarDates: distinctDates,
    minimumTimeReviewDates: CALENDAR_MINIMUM_TIME_REVIEW_DATES,
    minimumCandidateWindowsPerCohort: CALENDAR_MINIMUM_CANDIDATE_WINDOWS,
    minimumWeekdayOccurrences: CALENDAR_MINIMUM_WEEKDAY_OCCURRENCES,
    timeReviewReady: bands.every((band) => band.calendarDates >= CALENDAR_MINIMUM_TIME_REVIEW_DATES
      && band.resolvedCandidateWindows >= CALENDAR_MINIMUM_CANDIDATE_WINDOWS),
    weekdayReviewReady: weekdays.every((day) => day.calendarDates >= CALENDAR_MINIMUM_WEEKDAY_OCCURRENCES
      && day.resolvedCandidateWindows >= CALENDAR_MINIMUM_CANDIDATE_WINDOWS),
    productionChanged: false,
    timeBands: bands,
    weekdays,
  };
}

async function fetchOutcome(contractId: string): Promise<PositionSide | undefined> {
  const baseUrl = (process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/markets/${encodeURIComponent(contractId)}`, {
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!response.ok) return undefined;
  const result = ((await response.json()) as { market?: { result?: string } }).market?.result?.toLowerCase();
  return result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : undefined;
}

/** Observation-only collector. It has no order, budget, gate, or policy-mutation dependency. */
export function updateCalendarEvaluationStore(cycle: CalendarEvaluationCycle): Promise<CalendarEvaluationReport> {
  const operation = operationQueue.then(async () => {
    const store = await readStore();
    const forecastMap = new Map(store.forecasts.map((item) => [item.id, item]));
    const windowMap = new Map(store.windows.map((item) => [item.id, item]));
    const decisionEvents: CalendarEvaluationEvent[] = [];

    for (const forecast of cycle.forecasts) {
      if (forecastMap.has(forecast.id)) continue;
      store.forecasts.push(forecast);
      forecastMap.set(forecast.id, forecast);
      decisionEvents.push({ op: 'forecast', value: forecast });
    }
    for (const incoming of cycle.windows) {
      const existing = windowMap.get(incoming.id);
      if (!existing) {
        store.windows.push(incoming);
        windowMap.set(incoming.id, incoming);
        decisionEvents.push({ op: 'window', value: incoming });
      } else if (!existing.candidate && incoming.candidate) {
        existing.candidate = incoming.candidate;
        existing.candidateStatus = 'selected';
        decisionEvents.push({ op: 'window', value: existing });
      }
    }
    if (decisionEvents.length) {
      store.updatedAt = new Date().toISOString();
      await persistEvents(store, decisionEvents);
    }

    const now = Date.now();
    const settlementEvents: CalendarEvaluationEvent[] = [];
    for (const window of store.windows) {
      if (window.candidateStatus === 'pending' && Date.parse(window.closesAt) <= now) {
        window.candidateStatus = 'none';
        window.finalizedAt = new Date().toISOString();
        settlementEvents.push({ op: 'window', value: window });
      }
    }
    const dueForecasts = store.forecasts.filter((item) => !item.resolvedAt && Date.parse(item.closesAt) <= now);
    const dueWindows = store.windows.filter((item) => item.candidate && !item.candidate.resolvedAt && Date.parse(item.closesAt) <= now);
    const contractIds = [...new Set([
      ...dueForecasts.map((item) => item.contractId),
      ...dueWindows.map((item) => item.candidate!.contractId),
    ])];
    const outcomes = new Map<string, PositionSide>();
    const results = await Promise.allSettled(contractIds.map(async (contractId) => ({ contractId, outcome: await fetchOutcome(contractId) })));
    for (const result of results) if (result.status === 'fulfilled' && result.value.outcome) outcomes.set(result.value.contractId, result.value.outcome);
    const resolvedAt = new Date().toISOString();
    for (const forecast of dueForecasts) {
      const outcome = outcomes.get(forecast.contractId);
      if (!outcome) continue;
      forecast.outcome = outcome;
      forecast.resolvedAt = resolvedAt;
      const actual = outcome === 'UP' ? 1 : 0;
      forecast.brierScore = (forecast.probabilityUp - actual) ** 2;
      forecast.correct = (forecast.probabilityUp >= 0.5) === (outcome === 'UP');
      settlementEvents.push({ op: 'forecast', value: forecast });
    }
    for (const window of dueWindows) {
      const candidate = window.candidate!;
      const outcome = outcomes.get(candidate.contractId);
      if (!outcome) continue;
      candidate.outcome = outcome;
      candidate.resolvedAt = resolvedAt;
      const won = outcome === candidate.side;
      candidate.askProfitPerContract = (won ? 1 : 0) - candidate.askPrice - candidate.estimatedFeeRate;
      const makerReturn = (won ? 1 : 0) - candidate.bidPrice - candidate.estimatedMakerFeeRate;
      candidate.makerExpectedProfitPerContract = Number.isFinite(candidate.makerFillProbability)
        ? makerReturn * candidate.makerFillProbability! : undefined;
      window.finalizedAt = resolvedAt;
      settlementEvents.push({ op: 'window', value: window });
    }
    if (settlementEvents.length) {
      store.updatedAt = resolvedAt;
      await persistEvents(store, settlementEvents);
    }
    storeCache = Promise.resolve(store);
    storeCacheFingerprint = await storageFingerprint();
    return buildCalendarEvaluationReport(store, cycle.productionPolicyVersion);
  });
  const durableOperation = operation.catch((error) => {
    // Discard mutated memory after a failed append so an undurable observation can be retried.
    storeCache = undefined;
    storeCacheFingerprint = '';
    throw error;
  });
  operationQueue = durableOperation.then(() => undefined, () => undefined);
  return durableOperation;
}

export function getCalendarEvaluationReport(productionPolicyVersion: string): Promise<CalendarEvaluationReport> {
  const operation = operationQueue.then(async () => buildCalendarEvaluationReport(await readStore(), productionPolicyVersion));
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
