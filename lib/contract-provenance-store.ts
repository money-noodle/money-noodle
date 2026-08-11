import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContractProvenanceRecord, Prediction } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'contract-provenance.json');
let registryQueue: Promise<void> = Promise.resolve();

interface ContractProvenanceRegistry {
  version: 1;
  records: ContractProvenanceRecord[];
}

async function readRegistry(): Promise<ContractProvenanceRegistry> {
  try {
    const value = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as Partial<ContractProvenanceRegistry>;
    if (!Array.isArray(value.records)) throw new Error('Contract provenance registry is malformed.');
    return { version: 1, records: value.records };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
    throw error;
  }
}

async function writeRegistry(registry: ContractProvenanceRegistry): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${REGISTRY_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(registry, null, 2));
  await rename(temporary, REGISTRY_FILE);
}

export function contractRecordsFromPredictions(predictions: Prediction[]): ContractProvenanceRecord[] {
  const records = predictions.flatMap((prediction) => [prediction.market.contract, prediction.kalshi?.contract])
    .filter((record): record is ContractProvenanceRecord => Boolean(record));
  return [...new Map(records.map((record) => [record.registryId, record])).values()];
}

/** Append-only by registry id: changed rules produce a new fingerprint rather than mutating history. */
export function recordContractProvenance(predictions: Prediction[]): Promise<void> {
  const records = contractRecordsFromPredictions(predictions);
  if (!records.length) return Promise.resolve();
  const operation = registryQueue.then(async () => {
    const registry = await readRegistry();
    const known = new Set(registry.records.map((record) => record.registryId));
    const additions = records.filter((record) => !known.has(record.registryId));
    if (!additions.length) return;
    registry.records.push(...additions);
    await writeRegistry(registry);
  });
  registryQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getContractProvenanceRegistry(): Promise<ContractProvenanceRegistry> {
  await registryQueue;
  return readRegistry();
}
