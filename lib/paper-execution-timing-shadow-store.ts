import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PAPER_EXECUTION_TIMING_SHADOW_VERSION, PAPER_TIMING_MAX_PRINTS_PER_INTENT, replayPaperExecutionTimingEvents,
  type PaperAcceptanceTimingResult, type PaperExecutionGraceResult, type PaperExecutionTimingDecision,
  type PaperExecutionTimingEvent, type PaperExecutionTimingRecord,
} from './paper-execution-timing-shadow';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;
interface PaperExecutionTimingStoreRuntime {
  queue: Promise<void>;
  store?: PaperExecutionTimingShadowStore;
}
const runtimeKey = Symbol.for('money-noodle.paper-execution-timing-shadow-store');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: PaperExecutionTimingStoreRuntime };
const runtime = globals[runtimeKey] ??= { queue: Promise.resolve() };

function storeDirectory(): string {
  const configured = process.env.MONEY_NOODLE_PAPER_EXECUTION_TIMING_PATH?.trim();
  return configured ? path.resolve(/* turbopackIgnore: true */ configured) : DATA_DIR;
}
function snapshotFile(): string { return path.join(storeDirectory(), 'paper-execution-timing-shadows.json'); }
function journalFile(): string { return path.join(storeDirectory(), 'paper-execution-timing-shadows.journal.jsonl'); }

export interface PaperExecutionTimingShadowStore {
  version: 1;
  shadowVersion: typeof PAPER_EXECUTION_TIMING_SHADOW_VERSION;
  startedAt?: string;
  updatedAt?: string;
  records: PaperExecutionTimingRecord[];
}

function emptyStore(): PaperExecutionTimingShadowStore {
  return { version: 1, shadowVersion: PAPER_EXECUTION_TIMING_SHADOW_VERSION, records: [] };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

function validDecision(value: unknown): value is PaperExecutionTimingDecision {
  if (!value || typeof value !== 'object') return false;
  const decision = value as Partial<PaperExecutionTimingDecision>;
  return decision.version === PAPER_EXECUTION_TIMING_SHADOW_VERSION
    && typeof decision.id === 'string' && decision.id.length > 0
    && typeof decision.orderId === 'string' && decision.orderId.length > 0
    && typeof decision.mirrorPairId === 'string' && decision.mirrorPairId.length > 0
    && typeof decision.strategyId === 'string' && typeof decision.marketId === 'string'
    && typeof decision.providerId === 'string' && typeof decision.paperExecutionVersion === 'string'
    && typeof decision.contractId === 'string' && decision.contractId.length > 0
    && typeof decision.symbol === 'string' && (decision.side === 'UP' || decision.side === 'DOWN')
    && typeof decision.recordedAt === 'string' && Number.isFinite(Date.parse(decision.recordedAt))
    && typeof decision.closesAt === 'string' && Number.isFinite(Date.parse(decision.closesAt))
    && typeof decision.calculationAt === 'string' && Number.isFinite(Date.parse(decision.calculationAt))
    && typeof decision.requestedCount === 'number' && Number.isFinite(decision.requestedCount)
    && decision.requestedCount > 0
    && Number.isSafeInteger(Math.round(decision.requestedCount * 100))
    && Math.abs(decision.requestedCount * 100 - Math.round(decision.requestedCount * 100)) <= 1e-8
    && typeof decision.maximumPrice === 'number'
    && Number.isFinite(decision.maximumPrice) && decision.maximumPrice > 0 && decision.maximumPrice < 1
    && typeof decision.requestedStart === 'number' && Number.isFinite(decision.requestedStart)
    && decision.createDelayMs === 400 && decision.acknowledgementDelayMs === 250
    && decision.finalEvidenceGraceMs === 3_000;
}

function validAcceptance(value: unknown): value is PaperAcceptanceTimingResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<PaperAcceptanceTimingResult>;
  if ((result.status !== 'accepted' && result.status !== 'post_only_race' && result.status !== 'unavailable')
    || typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt))) return false;
  if (result.status === 'unavailable') return true;
  return [result.createQuote, result.acknowledgementQuote].every((quote) => Boolean(quote)
    && Number.isFinite(Date.parse(quote!.requestedAt)) && Number.isFinite(Date.parse(quote!.observedAt))
    && [quote!.selectedBid, quote!.selectedAsk, quote!.limitPrice].every(Number.isFinite)
    && quote!.selectedBid > 0 && quote!.selectedAsk > quote!.selectedBid && quote!.selectedAsk < 1);
}

function validReplay(value: PaperExecutionGraceResult['production'] | undefined): boolean {
  return Boolean(value) && [value?.filledCount, value?.purchaseCents, value?.averagePrice,
    value?.consumingPrints].every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0);
}

function validGrace(value: unknown): value is PaperExecutionGraceResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<PaperExecutionGraceResult>;
  if ((result.status !== 'available' && result.status !== 'unavailable')
    || typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt))
    || !validReplay(result.production) || (result.status === 'available' && !validReplay(result.eventTimeReplay))) return false;
  return !result.retainedPrints || (Array.isArray(result.retainedPrints)
    && result.retainedPrints.length <= PAPER_TIMING_MAX_PRINTS_PER_INTENT
    && result.retainedPrints.every((print) => typeof print.id === 'string' && typeof print.ticker === 'string'
      && Number.isFinite(Date.parse(print.at)) && Number.isFinite(print.count) && print.count > 0
      && Number.isFinite(print.yesPrice) && print.yesPrice > 0 && print.yesPrice < 1
      && Number.isFinite(print.noPrice) && print.noPrice > 0 && print.noPrice < 1
      && (print.takerSide === 'yes' || print.takerSide === 'no')));
}

function validEvent(value: unknown): value is PaperExecutionTimingEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<PaperExecutionTimingEvent>;
  if (event.op === 'decision') return validDecision(event.value);
  if (event.op === 'acceptance') return typeof event.id === 'string' && validAcceptance(event.value);
  if (event.op === 'grace') return typeof event.id === 'string' && validGrace(event.value);
  return false;
}

async function loadStore(): Promise<PaperExecutionTimingShadowStore> {
  let store = emptyStore();
  try {
    const parsed = JSON.parse(await readFile(snapshotFile(), 'utf8')) as Partial<PaperExecutionTimingShadowStore>;
    if (parsed.version !== 1 || parsed.shadowVersion !== PAPER_EXECUTION_TIMING_SHADOW_VERSION
      || !Array.isArray(parsed.records) || parsed.records.some((record) => !validDecision(record?.decision)
        || (record.acceptance !== undefined && !validAcceptance(record.acceptance))
        || (record.grace !== undefined && !validGrace(record.grace)))) {
      throw new Error('Paper execution timing shadow snapshot is malformed.');
    }
    store = { ...parsed, version: 1, shadowVersion: PAPER_EXECUTION_TIMING_SHADOW_VERSION,
      records: parsed.records } as PaperExecutionTimingShadowStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await rename(snapshotFile(), `${snapshotFile()}.corrupt-${Date.now()}`).catch(() => undefined);
      throw error;
    }
  }

  let raw = '';
  try { raw = await readFile(journalFile(), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: PaperExecutionTimingEvent[] = [];
  const validLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!validEvent(event)) throw new Error('invalid timing-shadow event');
      events.push(event);
      validLines.push(line);
    } catch {
      await writeFile(`${journalFile()}.corrupt-${Date.now()}`, raw).catch(() => undefined);
      await atomicWrite(journalFile(), validLines.length ? `${validLines.join('\n')}\n` : '');
      break;
    }
  }
  store.records = replayPaperExecutionTimingEvents(store.records, events);
  return store;
}

async function readStore(): Promise<PaperExecutionTimingShadowStore> {
  runtime.store ??= await loadStore();
  return runtime.store;
}

async function appendEvents(store: PaperExecutionTimingShadowStore, events: PaperExecutionTimingEvent[]): Promise<void> {
  if (!events.length) return;
  await mkdir(storeDirectory(), { recursive: true });
  await appendFile(journalFile(), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const size = await stat(journalFile()).then((value) => value.size).catch(() => 0);
  if (size >= JOURNAL_COMPACTION_BYTES) {
    await atomicWrite(snapshotFile(), JSON.stringify(store));
    await atomicWrite(journalFile(), '');
  }
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtime.queue.then(operation);
  runtime.queue = result.then(() => undefined, () => undefined);
  return result;
}

export function recordPaperExecutionTimingDecision(decision: PaperExecutionTimingDecision): Promise<void> {
  return serialized(async () => {
    if (!validDecision(decision)) throw new Error('Paper execution timing decision is malformed.');
    const store = await readStore();
    if (store.records.some((record) => record.decision.id === decision.id)) return;
    store.records.push({ decision: structuredClone(decision) });
    store.startedAt ??= decision.recordedAt;
    store.updatedAt = decision.recordedAt;
    await appendEvents(store, [{ op: 'decision', value: decision }]);
  });
}

export function recordPaperAcceptanceTimingResult(id: string, value: PaperAcceptanceTimingResult): Promise<void> {
  return serialized(async () => {
    if (!validAcceptance(value)) throw new Error('Paper acceptance timing result is malformed.');
    const store = await readStore();
    const record = store.records.find((item) => item.decision.id === id);
    if (!record || record.acceptance) return;
    record.acceptance = structuredClone(value);
    store.updatedAt = value.completedAt;
    await appendEvents(store, [{ op: 'acceptance', id, value }]);
  });
}

export function recordPaperExecutionGraceResult(id: string, value: PaperExecutionGraceResult): Promise<void> {
  return serialized(async () => {
    if (!validGrace(value)) throw new Error('Paper execution grace result is malformed.');
    const store = await readStore();
    const record = store.records.find((item) => item.decision.id === id);
    if (!record || record.grace) return;
    record.grace = structuredClone(value);
    store.updatedAt = value.completedAt;
    await appendEvents(store, [{ op: 'grace', id, value }]);
  });
}

export function getPaperExecutionTimingShadows(): Promise<PaperExecutionTimingShadowStore> {
  return serialized(async () => structuredClone(await readStore()));
}

/** Test seam; production owns one process-global serialized writer for the lifetime of the module. */
export function resetPaperExecutionTimingShadowStoreForTests(): void {
  runtime.queue = Promise.resolve();
  runtime.store = undefined;
}
