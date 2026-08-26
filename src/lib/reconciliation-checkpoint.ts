import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const KALSHI_RECONCILIATION_CHECKPOINT_VERSION = 'kalshi-reconciliation-checkpoint-v1' as const;
export type ReconciliationCheckpointTrigger = 'startup' | 'manual' | 'automatic' | 'periodic';

export interface KalshiReconciliationCheckpoint {
  version: typeof KALSHI_RECONCILIATION_CHECKPOINT_VERSION;
  completedThroughTs: number;
  completedAt: string;
  trigger: ReconciliationCheckpointTrigger;
}

const CHECKPOINT_FILE = 'kalshi-reconciliation-checkpoint.json';

function checkpointPath(dataDirectory: string): string {
  return path.join(dataDirectory, CHECKPOINT_FILE);
}

export function validateKalshiReconciliationCheckpoint(value: unknown): KalshiReconciliationCheckpoint {
  if (!value || typeof value !== 'object') throw new Error('Kalshi reconciliation checkpoint is malformed.');
  const record = value as Partial<KalshiReconciliationCheckpoint>;
  if (record.version !== KALSHI_RECONCILIATION_CHECKPOINT_VERSION
    || !Number.isSafeInteger(record.completedThroughTs) || record.completedThroughTs! <= 0
    || typeof record.completedAt !== 'string' || !Number.isFinite(Date.parse(record.completedAt))
    || !['startup', 'manual', 'automatic', 'periodic'].includes(record.trigger ?? '')) {
    throw new Error('Kalshi reconciliation checkpoint is malformed.');
  }
  return record as KalshiReconciliationCheckpoint;
}

export async function readKalshiReconciliationCheckpoint(
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<KalshiReconciliationCheckpoint | undefined> {
  try {
    return validateKalshiReconciliationCheckpoint(JSON.parse(await readFile(checkpointPath(dataDirectory), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeKalshiReconciliationCheckpoint(
  checkpoint: KalshiReconciliationCheckpoint,
  dataDirectory = path.resolve(process.cwd(), 'data'),
): Promise<void> {
  const valid = validateKalshiReconciliationCheckpoint(checkpoint);
  await mkdir(dataDirectory, { recursive: true });
  const target = checkpointPath(dataDirectory);
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
