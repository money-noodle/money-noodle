import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PAPER_FILL_CALIBRATION_VERSION, PAPER_FILL_QUEUE_CLEAR_MAX,
  isPaperFillCalibration, type PaperFillCalibration,
} from './paper-fill-calibration';

const DATA_DIR = path.resolve(process.cwd(), 'data');
/** Resolved per call so a test can point the store at a temp dir before the first read/write. */
function storeFile(): string {
  return path.join(process.env.MONEY_NOODLE_PAPER_FILL_CALIBRATION_PATH?.trim() || DATA_DIR, 'paper-fill-calibration.json');
}
let storeQueue: Promise<void> = Promise.resolve();

interface PaperFillCalibrationHistoryEntry {
  at: string;
  queueClearFraction: number;
  reason: string;
}

interface PaperFillCalibrationStore {
  version: 1;
  active: PaperFillCalibration;
  history: PaperFillCalibrationHistoryEntry[];
  updatedAt: string;
}

function emptyStore(): PaperFillCalibrationStore {
  return {
    version: 1,
    active: {
      version: PAPER_FILL_CALIBRATION_VERSION,
      queueClearFraction: 0,
      appliedToPaperExecution: '',
      heldOutWindows: 0,
      adoptedAt: '',
      reason: 'Neutral conservative model: displayed queue is fully consumed by aggressive prints.',
    },
    history: [],
    updatedAt: new Date().toISOString(),
  };
}

async function readStore(): Promise<PaperFillCalibrationStore> {
  try {
    const target = storeFile();
    const raw = JSON.parse(await readFile(target, 'utf8')) as Partial<PaperFillCalibrationStore>;
    const active = isPaperFillCalibration(raw.active) ? raw.active : emptyStore().active;
    return {
      version: 1,
      active,
      history: Array.isArray(raw.history) ? raw.history : [],
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function writeStore(store: PaperFillCalibrationStore): Promise<void> {
  const target = storeFile();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, target);
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Active calibration read at paper-maker entry. Never consults a live fill. */
export function getActivePaperFillCalibration(): Promise<PaperFillCalibration> {
  return serialized(async () => {
    const store = await readStore();
    return { ...store.active, version: PAPER_FILL_CALIBRATION_VERSION };
  });
}

/**
 * Manual, recorded adoption of a non-neutral queue-clear fraction. This is the only write path and is
 * never auto-invoked: a candidate calibration clears its held-out band, a human calls this, history is
 * appended immutably, and the paper execution cohort advances separately (v6 -> v7).
 */
export function adoptPaperFillCalibration(input: {
  queueClearFraction: number;
  appliedToPaperExecution: string;
  heldOutWindows: number;
  reason: string;
}): Promise<PaperFillCalibrationStore> {
  return serialized(async () => {
    if (!Number.isFinite(input.queueClearFraction)
      || input.queueClearFraction < 0 || input.queueClearFraction >= PAPER_FILL_QUEUE_CLEAR_MAX) {
        throw new Error(`queueClearFraction must be in [0, ${PAPER_FILL_QUEUE_CLEAR_MAX}).`);
    }
    const store = await readStore();
    const adopted: PaperFillCalibration = {
      version: PAPER_FILL_CALIBRATION_VERSION,
      queueClearFraction: input.queueClearFraction,
      appliedToPaperExecution: input.appliedToPaperExecution,
      heldOutWindows: Math.max(0, Math.floor(input.heldOutWindows)),
      adoptedAt: new Date().toISOString(),
      reason: input.reason,
    };
    store.history = [...store.history, {
      at: adopted.adoptedAt,
      queueClearFraction: adopted.queueClearFraction,
      reason: adopted.reason,
    }].slice(-200);
    store.active = adopted;
    store.updatedAt = adopted.adoptedAt;
    await writeStore(store);
    return store;
  });
}

/** Read-only status for the operator surface. */
export async function getPaperFillCalibrationStatus(): Promise<PaperFillCalibrationStore> {
  return serialized(async () => await readStore());
}