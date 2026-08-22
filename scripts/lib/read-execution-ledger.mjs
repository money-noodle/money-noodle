import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const DATA = path.resolve(process.cwd(), 'data');
const REF_VERSION = 'execution-order-evidence-ref-v1';
const BATCH_VERSION = 'execution-order-evidence-batch-v1';

function evidenceFile(reference, dataDirectory) {
  if (reference?.version !== REF_VERSION || !/^[a-f0-9]{64}$/.test(reference.sha256)
    || !/^[a-f0-9]{64}$/.test(reference.rowKey)
    || reference.file !== `batch.${reference.sha256}.json` || path.basename(reference.file) !== reference.file) {
    throw new Error(`Malformed execution evidence reference ${reference?.file ?? '<missing>'}.`);
  }
  return path.join(dataDirectory, 'execution-order-evidence', reference.file);
}

function parseBatch(raw, reference) {
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== reference.sha256) throw new Error(`Execution evidence checksum mismatch for ${reference.file}.`);
  const batch = JSON.parse(raw.toString('utf8'));
  if (batch?.version !== BATCH_VERSION || !batch.orders || Array.isArray(batch.orders)) {
    throw new Error(`Malformed execution evidence batch ${reference.file}.`);
  }
  return batch;
}

function merge(order, evidence) {
  const result = structuredClone(order);
  for (const [key, value] of Object.entries(evidence)) if (result[key] === undefined) result[key] = value;
  return result;
}

function validateLedger(ledger) {
  if (!Array.isArray(ledger?.orders)) throw new Error('Execution ledger orders are malformed.');
  if (ledger.version !== undefined && ledger.version !== 8 && ledger.version !== 9) {
    throw new Error(`Unsupported execution ledger version ${ledger.version}.`);
  }
}

export async function readExecutionLedger(dataDirectory = DATA) {
  const ledger = JSON.parse(await readFile(path.join(dataDirectory, 'paper-orders.json'), 'utf8'));
  validateLedger(ledger);
  if (ledger.version !== 9) return ledger;
  const batches = new Map();
  const orders = [];
  for (const order of ledger.orders) {
    const reference = order.archivedEvidence;
    if (!reference) { orders.push(order); continue; }
    let batch = batches.get(reference.file);
    if (!batch) {
      batch = parseBatch(await readFile(evidenceFile(reference, dataDirectory)), reference);
      batches.set(reference.file, batch);
    }
    const stored = batch.orders[reference.rowKey];
    if (!stored || stored.orderId !== order.id) throw new Error(`Execution evidence batch ${reference.file} omits row ${reference.rowKey} for ${order.id}.`);
    orders.push(merge(order, stored.evidence));
  }
  return { ...ledger, orders };
}

export function readExecutionLedgerSync(dataDirectory = DATA) {
  const ledger = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'paper-orders.json'), 'utf8'));
  validateLedger(ledger);
  if (ledger.version !== 9) return ledger;
  const batches = new Map();
  const orders = [];
  for (const order of ledger.orders) {
    const reference = order.archivedEvidence;
    if (!reference) { orders.push(order); continue; }
    let batch = batches.get(reference.file);
    if (!batch) {
      batch = parseBatch(fs.readFileSync(evidenceFile(reference, dataDirectory)), reference);
      batches.set(reference.file, batch);
    }
    const stored = batch.orders[reference.rowKey];
    if (!stored || stored.orderId !== order.id) throw new Error(`Execution evidence batch ${reference.file} omits row ${reference.rowKey} for ${order.id}.`);
    orders.push(merge(order, stored.evidence));
  }
  return { ...ledger, orders };
}
