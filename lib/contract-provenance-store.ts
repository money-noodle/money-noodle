import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContractProvenanceRecord, Prediction } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'contract-provenance.json');

interface ContractProvenanceRegistry {
  version: 1;
  records: ContractProvenanceRecord[];
}

interface ContractProvenanceRuntime {
  queue: Promise<void>;
  registry?: ContractProvenanceRegistry;
  loading?: Promise<ContractProvenanceRegistry>;
}

const runtimeKey = Symbol.for('money-noodle.contract-provenance-store');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: ContractProvenanceRuntime };
const runtime = globals[runtimeKey] ??= { queue: Promise.resolve() };

async function loadRegistry(): Promise<ContractProvenanceRegistry> {
  try {
    const value = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as Partial<ContractProvenanceRegistry>;
    if (!Array.isArray(value.records)) throw new Error('Contract provenance registry is malformed.');
    return { version: 1, records: value.records };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
    throw error;
  }
}

async function readRegistry(): Promise<ContractProvenanceRegistry> {
  if (runtime.registry) return runtime.registry;
  if (!runtime.loading) {
    runtime.loading = loadRegistry().then((registry) => {
      runtime.registry = registry;
      return registry;
    }).finally(() => { runtime.loading = undefined; });
  }
  return runtime.loading;
}

async function writeRegistry(registry: ContractProvenanceRegistry): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${REGISTRY_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(registry));
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
  const operation = runtime.queue.then(async () => {
    const registry = await readRegistry();
    const known = new Set(registry.records.map((record) => record.registryId));
    const additions = records.filter((record) => !known.has(record.registryId));
    if (!additions.length) return;
    const next = { version: 1 as const, records: [...registry.records, ...additions] };
    try {
      await writeRegistry(next);
      runtime.registry = next;
    } catch (error) {
      // The rename is the commit boundary. Reload durable state after any ambiguous failed write.
      runtime.registry = undefined;
      throw error;
    }
  });
  runtime.queue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getContractProvenanceRegistry(): Promise<ContractProvenanceRegistry> {
  await runtime.queue;
  return readRegistry();
}
