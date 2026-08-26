import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activeModel, appendPromotion, promotionEntry, type ModelPromotionEntry } from './model-promotion';
import type { WalkForwardEvaluationRun, WalkForwardParameters } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'model-promotions.json');
let queue: Promise<void> = Promise.resolve();

export async function readPromotionLedger(): Promise<ModelPromotionEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as { entries?: ModelPromotionEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Appends and persists atomically. Serialized so two concurrent promotions cannot interleave a
 * read-modify-write and drop one of them — a lost promotion record is worse than a rejected one.
 */
export function recordModelPromotion(input: {
  action: 'promoted' | 'rolled-back';
  modelVersion: string;
  parameters: WalkForwardParameters;
  reason: string;
  run?: WalkForwardEvaluationRun;
  supersedesId?: string;
}): Promise<ModelPromotionEntry> {
  const run = queue.then(async () => {
    const ledger = await readPromotionLedger();
    const entry = promotionEntry(input);
    const next = appendPromotion(ledger, entry);
    await mkdir(DATA_DIR, { recursive: true });
    const temporary = `${LEDGER_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 'model-promotion-v1', entries: next }, null, 2));
    await rename(temporary, LEDGER_FILE);
    return entry;
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export async function activePromotedModel(): Promise<ModelPromotionEntry | undefined> {
  return activeModel(await readPromotionLedger());
}
