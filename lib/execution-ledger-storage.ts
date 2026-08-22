import 'server-only';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXECUTION_ORDER_EVIDENCE_BATCH_VERSION,
  EXECUTION_ORDER_EVIDENCE_REF_VERSION,
  hydrateExecutionOrder,
  type ExecutionOrderEvidenceBatch,
} from './execution-order-evidence';
import type { PaperOrder } from './types';

export const EXECUTION_LEDGER_FILE = 'paper-orders.json';
export const EXECUTION_EVIDENCE_DIRECTORY = 'execution-order-evidence';
const SHA256 = /^[a-f0-9]{64}$/;

export interface StoredExecutionLedger {
  version?: number;
  orders?: PaperOrder[];
  [key: string]: unknown;
}

export function executionLedgerPath(dataDirectory = path.resolve(process.cwd(), 'data')): string {
  return path.join(dataDirectory, EXECUTION_LEDGER_FILE);
}

function evidencePath(file: string, dataDirectory: string): string {
  if (path.basename(file) !== file || !/^batch\.[a-f0-9]{64}\.json$/.test(file)) {
    throw new Error(`Execution evidence reference has an unsafe filename: ${file}`);
  }
  return path.join(dataDirectory, EXECUTION_EVIDENCE_DIRECTORY, file);
}

function validateReference(reference: NonNullable<PaperOrder['archivedEvidence']>): void {
  if (reference.version !== EXECUTION_ORDER_EVIDENCE_REF_VERSION) {
    throw new Error(`Unsupported execution evidence reference version: ${String(reference.version)}`);
  }
  if (!SHA256.test(reference.sha256) || !SHA256.test(reference.rowKey)
    || reference.file !== `batch.${reference.sha256}.json`) {
    throw new Error(`Execution evidence reference filename/hash disagree: ${reference.file}`);
  }
}

function parseBatch(raw: Buffer, reference: NonNullable<PaperOrder['archivedEvidence']>): ExecutionOrderEvidenceBatch {
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== reference.sha256) throw new Error(`Execution evidence checksum mismatch for ${reference.file}.`);
  const batch = JSON.parse(raw.toString('utf8')) as Partial<ExecutionOrderEvidenceBatch>;
  if (batch.version !== EXECUTION_ORDER_EVIDENCE_BATCH_VERSION || !batch.orders || Array.isArray(batch.orders)
    || typeof batch.orders !== 'object') {
    throw new Error(`Execution evidence batch ${reference.file} is malformed or unsupported.`);
  }
  return batch as ExecutionOrderEvidenceBatch;
}

async function readBatch(
  reference: NonNullable<PaperOrder['archivedEvidence']>,
  dataDirectory: string,
): Promise<ExecutionOrderEvidenceBatch> {
  validateReference(reference);
  return parseBatch(await readFile(evidencePath(reference.file, dataDirectory)), reference);
}

/**
 * Startup integrity gate for v9. Batches are read one at a time and discarded; compact funded state never
 * retains archived observation trees merely to prove their durable references.
 */
export async function verifyExecutionEvidenceReferences(
  orders: readonly PaperOrder[],
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<void> {
  const byFile = new Map<string, { reference: NonNullable<PaperOrder['archivedEvidence']>; orders: PaperOrder[] }>();
  for (const order of orders) {
    const reference = order.archivedEvidence;
    if (!reference) continue;
    validateReference(reference);
    const current = byFile.get(reference.file);
    if (current && current.reference.sha256 !== reference.sha256) {
      throw new Error(`Execution evidence file ${reference.file} has conflicting hashes.`);
    }
    if (current) current.orders.push(order);
    else byFile.set(reference.file, { reference, orders: [order] });
  }
  for (const { reference, orders: referencedOrders } of byFile.values()) {
    const batch = await readBatch(reference, dataDirectory);
    for (const order of referencedOrders) {
      const stored = batch.orders[order.archivedEvidence!.rowKey];
      if (!stored || stored.orderId !== order.id) {
        throw new Error(`Execution evidence batch ${reference.file} does not contain referenced row ${order.archivedEvidence!.rowKey} for ${order.id}.`);
      }
    }
  }
}

export async function readExecutionLedgerFile(
  dataDirectory = path.resolve(process.cwd(), 'data'),
  options: { verifyEvidence?: boolean } = {},
): Promise<StoredExecutionLedger> {
  const stored = JSON.parse(await readFile(executionLedgerPath(dataDirectory), 'utf8')) as StoredExecutionLedger;
  if (!Array.isArray(stored.orders)) throw new Error('Execution ledger orders are malformed.');
  if (stored.version !== undefined && stored.version !== 8 && stored.version !== 9) {
    throw new Error(`Unsupported execution ledger version: ${String(stored.version)}`);
  }
  if (stored.version !== 9 && stored.orders.some((order) => order.archivedEvidence)) {
    throw new Error('A pre-v9 execution ledger contains archived evidence references.');
  }
  if (stored.version === 9 && options.verifyEvidence !== false) {
    await verifyExecutionEvidenceReferences(stored.orders, dataDirectory);
  }
  return stored;
}

/** Hydrates only the requested compact rows, reading each immutable batch at most once for this call. */
export async function hydrateExecutionOrders(
  orders: readonly PaperOrder[],
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<PaperOrder[]> {
  const result = orders.map((order) => structuredClone(order));
  const byFile = new Map<string, number[]>();
  for (let index = 0; index < result.length; index += 1) {
    const reference = result[index].archivedEvidence;
    if (!reference) continue;
    validateReference(reference);
    byFile.set(reference.file, [...(byFile.get(reference.file) ?? []), index]);
  }
  for (const indexes of byFile.values()) {
    const reference = result[indexes[0]].archivedEvidence!;
    const batch = await readBatch(reference, dataDirectory);
    for (const index of indexes) {
      const order = result[index];
      const stored = batch.orders[order.archivedEvidence!.rowKey];
      if (!stored || stored.orderId !== order.id) {
        throw new Error(`Execution evidence batch ${reference.file} does not contain referenced row ${order.archivedEvidence!.rowKey} for ${order.id}.`);
      }
      result[index] = hydrateExecutionOrder(order, stored.evidence);
    }
  }
  return result;
}

export async function readHydratedExecutionOrders(
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<PaperOrder[]> {
  const ledger = await readExecutionLedgerFile(dataDirectory);
  return hydrateExecutionOrders(ledger.orders ?? [], dataDirectory);
}
