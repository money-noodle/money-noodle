import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_POLICY_SENTINEL_VERSION, appendExitSentinelObservation, buildExitPolicySentinelReport,
  exitPolicySentinelFromOrder, exitSentinelObservation,
  type ExitPolicySentinel, type ExitPolicySentinelReport, type ExitSentinelObservation,
} from './exit-policy-sentinel';
import { ENTRY_EXECUTION_POLICY_VERSION } from './entry-execution-policy';
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION } from './paper-maker-simulation';
import { BUY_POLICY_VERSION } from './prediction-policy';
import type { PaperOrder, PositionLifecycleObservation, PositionSide } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'exit-policy-sentinels.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'exit-policy-sentinels.journal.jsonl');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;
let operationQueue: Promise<void> = Promise.resolve();
let storeCache: Promise<ExitPolicySentinelStore> | undefined;
let storeCacheFingerprint = '';

export interface ExitPolicySentinelStore {
  version: 1;
  sentinelVersion: typeof EXIT_POLICY_SENTINEL_VERSION;
  startedAt: string;
  updatedAt: string;
  sentinels: ExitPolicySentinel[];
}

export type ExitPolicySentinelEvent =
  | { op: 'position'; value: ExitPolicySentinel }
  | { op: 'observation'; id: string; value: ExitSentinelObservation }
  | { op: 'state'; value: ExitPolicySentinel }
  | { op: 'resolution'; value: ExitPolicySentinel };

function emptyStore(startedAt: string): ExitPolicySentinelStore {
  return {
    version: 1, sentinelVersion: EXIT_POLICY_SENTINEL_VERSION,
    startedAt, updatedAt: startedAt, sentinels: [],
  };
}

export function replayExitPolicySentinelEvents(
  initial: ExitPolicySentinel[], events: ExitPolicySentinelEvent[],
): ExitPolicySentinel[] {
  const byId = new Map(initial.map((sentinel) => [sentinel.id, sentinel]));
  for (const event of events) {
    if (event.op === 'position') {
      if (event.value?.id && !byId.has(event.value.id)) byId.set(event.value.id, event.value);
      continue;
    }
    if (event.op === 'observation') {
      const existing = byId.get(event.id);
      if (existing) byId.set(event.id, appendExitSentinelObservation(existing, event.value));
      continue;
    }
    const existing = event.value?.id ? byId.get(event.value.id) : undefined;
    if (!existing) continue;
    if (event.op === 'state') {
      byId.set(existing.id, {
        ...existing,
        production: event.value.production,
        invalidReason: existing.invalidReason ?? event.value.invalidReason,
      });
    } else if (!existing.resolvedAt) {
      byId.set(existing.id, {
        ...existing,
        production: event.value.production,
        outcome: event.value.outcome,
        holdPnlCents: event.value.holdPnlCents,
        resolvedAt: event.value.resolvedAt,
        invalidReason: existing.invalidReason ?? event.value.invalidReason,
      });
    }
  }
  return [...byId.values()];
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function readSnapshot(startedAt: string): Promise<{ store: ExitPolicySentinelStore; existed: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as Partial<ExitPolicySentinelStore>;
    if (!Array.isArray(parsed.sentinels) || !parsed.startedAt) throw new Error('Exit policy sentinel snapshot is missing required fields.');
    return {
      existed: true,
      store: {
        version: 1, sentinelVersion: EXIT_POLICY_SENTINEL_VERSION,
        startedAt: parsed.startedAt, updatedAt: parsed.updatedAt ?? parsed.startedAt,
        sentinels: parsed.sentinels,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: emptyStore(startedAt), existed: false };
    await rename(SNAPSHOT_FILE, `${SNAPSHOT_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Exit policy sentinel snapshot was malformed and has been quarantined:', error);
    return { store: emptyStore(startedAt), existed: false };
  }
}

async function loadStore(startedAt: string): Promise<{ store: ExitPolicySentinelStore; existed: boolean }> {
  const loaded = await readSnapshot(startedAt);
  let raw = '';
  try { raw = await readFile(JOURNAL_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: ExitPolicySentinelEvent[] = [];
  const valid: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as ExitPolicySentinelEvent;
      events.push(event);
      valid.push(line);
    } catch {
      console.error('Exit policy sentinel journal had a damaged trailing event; preserving its valid prefix.');
      await writeFile(`${JOURNAL_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
      await atomicWrite(JOURNAL_FILE, valid.length ? `${valid.join('\n')}\n` : '');
      break;
    }
  }
  loaded.store.sentinels = replayExitPolicySentinelEvents(loaded.store.sentinels, events);
  return loaded;
}

async function storageFingerprint(): Promise<string> {
  const [snapshot, journal] = await Promise.all([
    stat(SNAPSHOT_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
    stat(JOURNAL_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
  ]);
  return `${snapshot}|${journal}`;
}

async function readStore(startedAt: string): Promise<{ store: ExitPolicySentinelStore; existed: boolean }> {
  const fingerprint = await storageFingerprint();
  if (!storeCache || fingerprint !== storeCacheFingerprint) {
    const loaded = loadStore(startedAt);
    storeCache = loaded.then((value) => value.store);
    storeCacheFingerprint = fingerprint;
    return loaded;
  }
  return { store: await storeCache, existed: true };
}

async function cacheStore(store: ExitPolicySentinelStore): Promise<void> {
  storeCache = Promise.resolve(store);
  storeCacheFingerprint = await storageFingerprint();
}

async function persistEvents(store: ExitPolicySentinelStore, events: ExitPolicySentinelEvent[]): Promise<void> {
  if (!events.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(JOURNAL_FILE, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const size = await stat(JOURNAL_FILE).then((value) => value.size).catch(() => 0);
  if (size >= JOURNAL_COMPACTION_BYTES) {
    await atomicWrite(SNAPSHOT_FILE, JSON.stringify(store));
    await atomicWrite(JOURNAL_FILE, '');
  }
  await cacheStore(store);
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStore(observedAt: string): Promise<ExitPolicySentinelStore> {
  const loaded = await readStore(observedAt);
  if (!loaded.existed) {
    await atomicWrite(SNAPSHOT_FILE, JSON.stringify(loaded.store));
    await cacheStore(loaded.store);
  }
  return loaded.store;
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

/** Decision-time lifecycle observation; the caller ignores this promise from the production path. */
export function recordExitPolicySentinelObservation(
  order: PaperOrder,
  lifecycle: PositionLifecycleObservation,
  source: ExitSentinelObservation['source'] = 'production',
): Promise<void> {
  const observation = exitSentinelObservation(lifecycle, source);
  // Build only the bounded sentinel payload synchronously. Cloning the order would copy its growing
  // lifecycle history on every observation and put avoidable work on the exit path.
  const prospective = observation ? exitPolicySentinelFromOrder(order, observation) : null;
  return serialized(async () => {
    if (!observation || !prospective) return;
    const store = await ensureStore(observation.at);
    const existing = store.sentinels.find((sentinel) => sentinel.id === prospective.id);
    if (!existing) {
      if (Date.parse(prospective.positionOpenedAt) < Date.parse(store.startedAt)) return;
      store.sentinels.push(prospective);
      store.updatedAt = observation.at;
      await persistEvents(store, [{ op: 'position', value: prospective }]);
      return;
    }
    if (existing.resolvedAt || existing.invalidReason || existing.observations.some((item) => item.at === observation.at)) return;
    if (Math.abs(existing.quantity - prospective.quantity) > 1e-8
      || Math.abs(existing.exactCostCents - prospective.exactCostCents) > 1e-9) {
      existing.invalidReason = 'Authoritative quantity or exact entry cost changed after sentinel creation.';
      store.updatedAt = observation.at;
      await persistEvents(store, [{ op: 'state', value: existing }]);
      return;
    }
    const updated = appendExitSentinelObservation(existing, observation);
    if (updated === existing) return;
    store.sentinels[store.sentinels.indexOf(existing)] = updated;
    store.updatedAt = observation.at;
    await persistEvents(store, [{ op: 'observation', id: existing.id, value: observation }]);
  });
}

export function getExitPolicyContinuationOrderIds(observedAt: string): Promise<string[]> {
  return serialized(async () => {
    const store = await ensureStore(observedAt);
    return store.sentinels.filter((sentinel) => !sentinel.resolvedAt && !sentinel.invalidReason
      && (sentinel.production.status === 'strict-exit' || sentinel.production.status === 'other-exit')
      && Date.parse(sentinel.closesAt) > Date.parse(observedAt)).map((sentinel) => sentinel.orderId);
  });
}

export interface ExitPolicySentinelMaintenance {
  observedAt: string;
  orders: PaperOrder[];
  continuationObservations?: Array<{ orderId: string; observation: PositionLifecycleObservation }>;
}

/** Applies detached post-exit observations, production state, and authoritative settlement. */
export function maintainExitPolicySentinels(cycle: ExitPolicySentinelMaintenance): Promise<void> {
  // Snapshot only fields maintenance reads; copying full lifecycle arrays would grow work every cycle.
  const orders = new Map(cycle.orders.map((order) => [order.id, {
    id: order.id, status: order.status, outcome: order.outcome,
    counterfactualHoldOutcome: order.counterfactualHoldOutcome,
    switchedToOrderId: order.switchedToOrderId, replacedOrderId: order.replacedOrderId,
    standaloneExitPolicy: order.standaloneExitPolicy,
    standaloneExitAttemptedAt: order.standaloneExitAttemptedAt,
    settledAt: order.settledAt, saleProceedsCents: order.saleProceedsCents,
    actualPnlCents: order.actualPnlCents, pnlCents: order.pnlCents,
  }]));
  const continuations = (cycle.continuationObservations ?? []).map((item) => ({
    orderId: item.orderId, observation: exitSentinelObservation(item.observation, 'continuation'),
  }));
  return serialized(async () => {
    const store = await ensureStore(cycle.observedAt);
    const events: ExitPolicySentinelEvent[] = [];
    for (const continuation of continuations) {
      if (!continuation.observation) continue;
      const sentinel = store.sentinels.find((item) => item.orderId === continuation.orderId);
      if (!sentinel || sentinel.resolvedAt || sentinel.invalidReason
        || sentinel.observations.some((item) => item.at === continuation.observation!.at)) continue;
      const updated = appendExitSentinelObservation(sentinel, continuation.observation);
      if (updated === sentinel) continue;
      store.sentinels[store.sentinels.indexOf(sentinel)] = updated;
      events.push({ op: 'observation', id: sentinel.id, value: continuation.observation });
    }

    const due = store.sentinels.filter((sentinel) => !sentinel.resolvedAt && !sentinel.invalidReason
      && Date.parse(sentinel.closesAt) <= Date.parse(cycle.observedAt));
    const outcomeByContract = new Map<string, PositionSide>();
    for (const sentinel of due) {
      const order = orders.get(sentinel.orderId);
      const outcome = order?.outcome ?? order?.counterfactualHoldOutcome;
      if (outcome) outcomeByContract.set(sentinel.contractId, outcome);
    }
    const missingContracts = [...new Set(due.map((sentinel) => sentinel.contractId)
      .filter((contractId) => !outcomeByContract.has(contractId)))];
    const fetched = await Promise.allSettled(missingContracts.map(async (contractId) => ({ contractId, outcome: await fetchOutcome(contractId) })));
    for (const result of fetched) if (result.status === 'fulfilled' && result.value.outcome) outcomeByContract.set(result.value.contractId, result.value.outcome);

    for (const sentinel of store.sentinels) {
      if (sentinel.resolvedAt || sentinel.invalidReason) continue;
      const order = orders.get(sentinel.orderId);
      if (order) {
        const production = order.switchedToOrderId || order.replacedOrderId
          ? { ...sentinel.production, status: 'other-exit' as const }
          : order.status === 'sold'
            ? {
              status: order.standaloneExitPolicy === 'strict-value-v1' ? 'strict-exit' as const : 'other-exit' as const,
              policy: order.standaloneExitPolicy,
              attemptedAt: order.standaloneExitAttemptedAt ?? order.settledAt,
              proceedsCents: order.saleProceedsCents,
              actualPnlCents: order.actualPnlCents ?? order.pnlCents,
            }
            : order.status === 'won' || order.status === 'lost'
              ? {
                status: 'held' as const, actualPnlCents: order.actualPnlCents ?? order.pnlCents,
                ...(order.standaloneExitPolicy === 'strict-value-v1' && order.standaloneExitAttemptedAt
                  ? { policy: order.standaloneExitPolicy, attemptedAt: order.standaloneExitAttemptedAt } : {}),
              }
              : order.standaloneExitPolicy === 'strict-value-v1' && order.standaloneExitAttemptedAt
                ? {
                  status: 'strict-exit-no-fill' as const, policy: order.standaloneExitPolicy,
                  attemptedAt: order.standaloneExitAttemptedAt,
                }
                : { status: 'open' as const };
        if (JSON.stringify(production) !== JSON.stringify(sentinel.production)) {
          sentinel.production = production;
          events.push({ op: 'state', value: sentinel });
        }
        if (order.switchedToOrderId || order.replacedOrderId) {
          sentinel.invalidReason = 'Position entered the separate switch mechanism; standalone exit arms are not comparable.';
          events.push({ op: 'state', value: sentinel });
          continue;
        }
      }
      if (Date.parse(sentinel.closesAt) > Date.parse(cycle.observedAt)) continue;
      const outcome = outcomeByContract.get(sentinel.contractId);
      if (!outcome) continue;
      sentinel.outcome = outcome;
      sentinel.holdPnlCents = outcome === sentinel.side
        ? sentinel.quantity * 100 - sentinel.exactCostCents : -sentinel.exactCostCents;
      sentinel.resolvedAt = cycle.observedAt;
      events.push({ op: 'resolution', value: sentinel });
    }
    if (!events.length) return;
    store.updatedAt = cycle.observedAt;
    await persistEvents(store, events);
  });
}

export function getExitPolicySentinels(): Promise<{ startedAt: string; sentinels: ExitPolicySentinel[] }> {
  return serialized(async () => {
    const store = await ensureStore(new Date().toISOString());
    return { startedAt: store.startedAt, sentinels: store.sentinels };
  });
}

export function getExitPolicySentinelReport(orders: PaperOrder[]): Promise<ExitPolicySentinelReport> {
  return serialized(async () => {
    const store = await ensureStore(new Date().toISOString());
    return buildExitPolicySentinelReport({
      startedAt: store.startedAt, buyPolicyVersion: BUY_POLICY_VERSION,
      executionPolicyVersions: { live: ENTRY_EXECUTION_POLICY_VERSION, paper: PAPER_MANAGED_MAKER_EXECUTION_VERSION },
      sentinels: store.sentinels, orders,
    });
  });
}
