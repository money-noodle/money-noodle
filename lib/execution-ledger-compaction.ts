import 'server-only';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  archivedOrderEvidence,
  compactExecutionOrder,
  EXECUTION_LEDGER_V9,
  EXECUTION_ORDER_EVIDENCE_BATCH_VERSION,
  executionOrderEvidenceSealEligible,
  hasArchivedOrderEvidence,
  hydrateExecutionOrder,
  materializeExecutionOrderFallbacks,
  type ArchivedOrderEvidence,
  type ExecutionOrderEvidenceBatch,
} from './execution-order-evidence';
import {
  EXECUTION_EVIDENCE_DIRECTORY,
  executionLedgerPath,
  hydrateExecutionOrders,
  readExecutionLedgerFile,
  verifyExecutionEvidenceReferences,
  type StoredExecutionLedger,
} from './execution-ledger-storage';
import { buildTradeTrackSummary, orderStrategyId } from './execution-report';
import { makerCohortEvidence } from './entry-execution-policy';
import { epochResults, lifetimeRealizedPnlCents } from './budget-epoch';
import { countFilledLiveVenueOrders } from './order-rate-limit';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import type { ExecutionMode, PaperOrder, StrategyId } from './types';

const LEGACY_DIRECTORY = 'execution-ledger-legacy';

interface PlannedBatch {
  file: string;
  sha256: string;
  content: string;
  batch: ExecutionOrderEvidenceBatch;
}

export interface ExecutionLedgerCompactionResult {
  versionBefore: number;
  versionAfter: 9;
  orders: number;
  compactedOrders: number;
  evidenceBatches: number;
  ledgerBytesBefore: number;
  ledgerBytesAfter: number;
  evidenceBytes: number;
  legacyFile?: string;
  wrote: boolean;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function evidenceGroup(order: PaperOrder): string {
  const issued = Date.parse(order.createdAt);
  const day = Number.isFinite(issued) ? new Date(issued).toISOString().slice(0, 10) : 'invalid-date';
  return `${day}:${order.executionMode}:${orderStrategyId(order)}`;
}

function withoutReference(order: PaperOrder): PaperOrder {
  const copy = structuredClone(order);
  delete copy.archivedEvidence;
  return copy;
}

function logicalExpectedOrder(order: PaperOrder): PaperOrder {
  return withoutReference(materializeExecutionOrderFallbacks(order));
}

function assertEquivalent(expected: readonly PaperOrder[], actual: readonly PaperOrder[]): void {
  if (expected.length !== actual.length) throw new Error(`Execution compaction changed order count ${expected.length} -> ${actual.length}.`);
  // Historical pre-episode paper rows contain a small, known set of duplicate logical IDs. Array position
  // is therefore part of the legacy record identity; compaction preserves it exactly rather than silently
  // deduplicating evidence.
  for (let index = 0; index < expected.length; index += 1) {
    const before = logicalExpectedOrder(expected[index]);
    const after = logicalExpectedOrder(actual[index]);
    if (!isDeepStrictEqual(before, after)) {
      throw new Error(`Execution compaction failed full-field equivalence at row ${index} (${expected[index].id}).`);
    }
  }
}

function assertCompactControlEquivalence(before: PaperOrder[], compact: PaperOrder[], nowMs: number): void {
  const modes: ExecutionMode[] = ['paper', 'live'];
  const strategies: StrategyId[] = [EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP];
  for (const mode of modes) for (const strategy of strategies) {
    if (!isDeepStrictEqual(buildTradeTrackSummary(before, mode, strategy), buildTradeTrackSummary(compact, mode, strategy))) {
      throw new Error(`Execution compaction changed the ${mode}/${strategy} bounded track summary.`);
    }
    if (!isDeepStrictEqual(epochResults(before, mode), epochResults(compact, mode))) {
      throw new Error(`Execution compaction changed ${mode} funding epochs.`);
    }
    if (lifetimeRealizedPnlCents(before, mode) !== lifetimeRealizedPnlCents(compact, mode)) {
      throw new Error(`Execution compaction changed ${mode} lifetime whole-cent P&L.`);
    }
  }
  for (const price of [0.05, 0.15, 0.35, 0.65]) for (const spread of [0.005, 0.015, 0.03]) {
    const prior = makerCohortEvidence(before, price, spread);
    const next = makerCohortEvidence(compact, price, spread);
    if (!isDeepStrictEqual(prior, next)) throw new Error(`Execution compaction changed maker cohort ${prior.label}.`);
  }
  for (const since of [0, nowMs - 3_600_000, nowMs - 24 * 60 * 60_000]) {
    if (countFilledLiveVenueOrders(before, since) !== countFilledLiveVenueOrders(compact, since)) {
      throw new Error(`Execution compaction changed the live filled-order count since ${since}.`);
    }
  }
}

async function writeImmutable(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (sha256(existing) !== sha256(content) || existing.toString('utf8') !== content) {
      throw new Error(`Immutable execution artifact already exists with different content: ${file}`);
    }
    return;
  }
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
  const durable = await readFile(file);
  if (sha256(durable) !== sha256(content) || durable.toString('utf8') !== content) {
    throw new Error(`Immutable execution artifact failed read-back verification: ${file}`);
  }
}

function planBatches(orders: readonly PaperOrder[], now: Date): {
  batches: PlannedBatch[];
  evidenceByIndex: Map<number, { evidence: ArchivedOrderEvidence; file: string; sha256: string; rowKey: string }>;
} {
  const groups = new Map<string, Record<string, { orderId: string; evidence: ArchivedOrderEvidence }>>();
  const groupAndRowByIndex = new Map<number, { groupKey: string; rowKey: string; evidence: ArchivedOrderEvidence }>();
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    if (order.archivedEvidence || !executionOrderEvidenceSealEligible(order, orders, now.getTime())) continue;
    const evidence = archivedOrderEvidence(order);
    if (!hasArchivedOrderEvidence(evidence)) continue;
    const groupKey = evidenceGroup(order);
    const rowKey = sha256(JSON.stringify(order));
    const group = groups.get(groupKey) ?? {};
    const existing = group[rowKey];
    if (existing && (!isDeepStrictEqual(existing.evidence, evidence) || existing.orderId !== order.id)) {
      throw new Error(`Execution evidence row-key collision for ${order.id}.`);
    }
    group[rowKey] = { orderId: order.id, evidence };
    groups.set(groupKey, group);
    groupAndRowByIndex.set(index, { groupKey, rowKey, evidence });
  }
  const batches: PlannedBatch[] = [];
  const referenceByGroup = new Map<string, { file: string; sha256: string }>();
  for (const [groupKey, orderEvidence] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const batch: ExecutionOrderEvidenceBatch = {
      version: EXECUTION_ORDER_EVIDENCE_BATCH_VERSION,
      createdAt: now.toISOString(),
      orders: Object.fromEntries(Object.entries(orderEvidence).sort(([left], [right]) => left.localeCompare(right))),
    };
    const content = JSON.stringify(batch);
    const hash = sha256(content);
    const file = `batch.${hash}.json`;
    batches.push({ file, sha256: hash, content, batch });
    referenceByGroup.set(groupKey, { file, sha256: hash });
  }
  const evidenceByIndex = new Map<number, { evidence: ArchivedOrderEvidence; file: string; sha256: string; rowKey: string }>();
  for (const [index, planned] of groupAndRowByIndex) {
    const reference = referenceByGroup.get(planned.groupKey);
    if (!reference) throw new Error(`Execution evidence group ${planned.groupKey} has no batch.`);
    evidenceByIndex.set(index, { ...reference, rowKey: planned.rowKey, evidence: planned.evidence });
  }
  return { batches, evidenceByIndex };
}

async function publishLedger(file: string, ledger: StoredExecutionLedger): Promise<void> {
  const content = JSON.stringify(ledger);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  const staged = JSON.parse(await readFile(temporary, 'utf8')) as StoredExecutionLedger;
  if (staged.version !== EXECUTION_LEDGER_V9 || !Array.isArray(staged.orders)) {
    throw new Error('Staged execution ledger is malformed.');
  }
  await rename(temporary, file);
}

export async function compactExecutionLedgerAt(
  dataDirectory = path.resolve(process.cwd(), 'data'),
  options: { write?: boolean; now?: Date } = {},
): Promise<ExecutionLedgerCompactionResult> {
  const now = options.now ?? new Date();
  const ledgerFile = executionLedgerPath(dataDirectory);
  const source = await readFile(ledgerFile, 'utf8');
  const stored = await readExecutionLedgerFile(dataDirectory) as StoredExecutionLedger & { orders: PaperOrder[] };
  const fullBefore = stored.version === EXECUTION_LEDGER_V9
    ? await hydrateExecutionOrders(stored.orders, dataDirectory)
    : structuredClone(stored.orders);
  const { batches, evidenceByIndex } = planBatches(stored.orders, now);
  const compactOrders = stored.orders.map((order, index) => {
    const planned = evidenceByIndex.get(index);
    return planned ? compactExecutionOrder(order, planned) : structuredClone(order);
  });
  const candidate: StoredExecutionLedger & { version: 9; orders: PaperOrder[] } = {
    ...stored,
    version: EXECUTION_LEDGER_V9,
    orders: compactOrders,
  };

  const hydratedCandidate = compactOrders.map((order, index) => {
    const planned = evidenceByIndex.get(index);
    if (planned) return hydrateExecutionOrder(order, planned.evidence);
    if (order.archivedEvidence) {
      const prior = fullBefore[index];
      if (!prior || prior.id !== order.id) throw new Error(`Existing compact row ${index} has no matching hydrated source.`);
      return hydrateExecutionOrder(order, archivedOrderEvidence(prior));
    }
    return structuredClone(order);
  });
  assertEquivalent(fullBefore, hydratedCandidate);
  assertCompactControlEquivalence(fullBefore, compactOrders, now.getTime());

  let legacyFile: string | undefined;
  if (options.write) {
    const evidenceDirectory = path.join(dataDirectory, EXECUTION_EVIDENCE_DIRECTORY);
    for (const batch of batches) await writeImmutable(path.join(evidenceDirectory, batch.file), batch.content);

    if (stored.version !== EXECUTION_LEDGER_V9) {
      const sourceHash = sha256(source);
      legacyFile = path.join(LEGACY_DIRECTORY, `paper-orders.v8.${sourceHash}.json`);
      await writeImmutable(path.join(dataDirectory, legacyFile), source);
    }

    await publishLedger(ledgerFile, candidate);
    const published = await readExecutionLedgerFile(dataDirectory) as StoredExecutionLedger & { orders: PaperOrder[] };
    await verifyExecutionEvidenceReferences(published.orders, dataDirectory);
    assertEquivalent(fullBefore, await hydrateExecutionOrders(published.orders, dataDirectory));
  }

  return {
    versionBefore: stored.version ?? 8,
    versionAfter: EXECUTION_LEDGER_V9,
    orders: stored.orders.length,
    compactedOrders: evidenceByIndex.size,
    evidenceBatches: batches.length,
    ledgerBytesBefore: Buffer.byteLength(source),
    ledgerBytesAfter: Buffer.byteLength(JSON.stringify(candidate)),
    evidenceBytes: batches.reduce((sum, batch) => sum + Buffer.byteLength(batch.content), 0),
    ...(legacyFile ? { legacyFile } : {}),
    wrote: options.write === true,
  };
}

/** Safe rollback materializes the current generation; it never restores a stale frozen migration input. */
export async function restoreExecutionLedgerMonolithAt(
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<{ orders: number; bytes: number }> {
  const stored = await readExecutionLedgerFile(dataDirectory) as StoredExecutionLedger & { orders: PaperOrder[] };
  const hydrated = await hydrateExecutionOrders(stored.orders, dataDirectory);
  const orders = hydrated.map(withoutReference);
  const monolith: StoredExecutionLedger & { version: 8; orders: PaperOrder[] } = { ...stored, version: 8, orders };
  const content = JSON.stringify(monolith);
  const file = executionLedgerPath(dataDirectory);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  const staged = JSON.parse(await readFile(temporary, 'utf8')) as StoredExecutionLedger;
  if (staged.version !== 8 || !Array.isArray(staged.orders) || staged.orders.some((order) => order.archivedEvidence)) {
    throw new Error('Staged execution monolith is malformed.');
  }
  assertEquivalent(hydrated, staged.orders);
  await rename(temporary, file);
  return { orders: orders.length, bytes: Buffer.byteLength(content) };
}

export async function verifyExecutionLedgerAt(
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<{ version: number; orders: number; compactOrders: number; ledgerBytes: number; hydratedBytes: number }> {
  const stored = await readExecutionLedgerFile(dataDirectory) as StoredExecutionLedger & { orders: PaperOrder[] };
  const hydrated = await hydrateExecutionOrders(stored.orders, dataDirectory);
  for (const order of hydrated) {
    if (!order.id || !order.executionMode || !order.status || !Number.isFinite(order.stakeCents)) {
      throw new Error(`Execution order ${order.id || '<missing>'} is structurally malformed.`);
    }
  }
  return {
    version: stored.version ?? 8,
    orders: stored.orders.length,
    compactOrders: stored.orders.filter((order) => order.archivedEvidence).length,
    ledgerBytes: Buffer.byteLength(JSON.stringify(stored)),
    hydratedBytes: Buffer.byteLength(JSON.stringify({ ...stored, orders: hydrated.map(withoutReference), version: 8 })),
  };
}
