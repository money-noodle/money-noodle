import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PAPER_FILL_CALIBRATION_VERSION, PAPER_FILL_QUEUE_CLEAR_MAX, PAPER_FIRST_ADOPTED_CALIBRATION_GENERATION,
  PAPER_LEGACY_NEUTRAL_EXECUTION_VERSION, PAPER_NEUTRAL_EXECUTION_VERSION,
  isPaperFillCalibration, paperExecutionGeneration, paperExecutionVersion, type PaperFillCalibration,
} from './paper-fill-calibration';

const DATA_DIR = path.resolve(process.cwd(), 'data');
/** Resolved per call so a test can point the store at a temp dir before the first read/write. */
function storeFile(): string {
  return path.join(process.env.MONEY_NOODLE_PAPER_FILL_CALIBRATION_PATH?.trim() || DATA_DIR, 'paper-fill-calibration.json');
}
let storeQueue: Promise<void> = Promise.resolve();

export interface PaperFillCalibrationStore {
  version: 1;
  active: PaperFillCalibration;
  /** Complete append-only adoption records. Neutral v6/v7 controls are implicit and never adoptions. */
  history: PaperFillCalibration[];
  updatedAt: string;
}

function neutralCalibration(): PaperFillCalibration {
  return {
    version: PAPER_FILL_CALIBRATION_VERSION,
    queueClearFraction: 0,
    appliedToPaperExecution: PAPER_NEUTRAL_EXECUTION_VERSION,
    heldOutWindows: 0,
    adoptedAt: '',
    reason: 'Neutral conservative model: displayed queue is fully consumed by aggressive prints.',
  };
}

function emptyStore(): PaperFillCalibrationStore {
  return { version: 1, active: neutralCalibration(), history: [], updatedAt: new Date().toISOString() };
}

function sameCalibration(left: PaperFillCalibration, right: PaperFillCalibration): boolean {
  return left.version === right.version
    && left.queueClearFraction === right.queueClearFraction
    && left.appliedToPaperExecution === right.appliedToPaperExecution
    && left.heldOutWindows === right.heldOutWindows
    && left.adoptedAt === right.adoptedAt
    && left.reason === right.reason;
}

function isCalibrationStore(input: unknown): input is PaperFillCalibrationStore {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Partial<PaperFillCalibrationStore>;
  if (candidate.version !== 1 || !isPaperFillCalibration(candidate.active)
    || !Array.isArray(candidate.history) || !candidate.history.every(isPaperFillCalibration)
    || typeof candidate.updatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.updatedAt))) return false;

  if (candidate.history.length === 0) {
    return (candidate.active.appliedToPaperExecution === PAPER_NEUTRAL_EXECUTION_VERSION
      || candidate.active.appliedToPaperExecution === PAPER_LEGACY_NEUTRAL_EXECUTION_VERSION)
      && candidate.active.queueClearFraction === 0;
  }
  for (let index = 0; index < candidate.history.length; index += 1) {
    if (paperExecutionGeneration(candidate.history[index].appliedToPaperExecution)
      !== index + PAPER_FIRST_ADOPTED_CALIBRATION_GENERATION) return false;
  }
  return sameCalibration(candidate.active, candidate.history.at(-1)!);
}

async function readStore(): Promise<PaperFillCalibrationStore> {
  try {
    const raw = JSON.parse(await readFile(storeFile(), 'utf8')) as unknown;
    if (!isCalibrationStore(raw)) throw new Error('Paper fill calibration store is malformed or has discontinuous cohort history.');
    // A legacy neutral v6 file has no adopted parameters. Project it to the approved v7 control in
    // memory; do not rewrite durable history merely to activate the event-time invariant repair.
    return raw.history.length === 0
      && raw.active.appliedToPaperExecution === PAPER_LEGACY_NEUTRAL_EXECUTION_VERSION
      ? { ...raw, active: neutralCalibration() }
      : raw;
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

/** Active calibration read once before paper intent creation. Never consults a live fill. */
export function getActivePaperFillCalibration(): Promise<PaperFillCalibration> {
  return serialized(async () => ({ ...(await readStore()).active }));
}

/**
 * Manual, recorded adoption. The store—not the caller—generates the next paper execution cohort, so a
 * changed fill assumption (including a rollback to zero) cannot share an identity with older evidence.
 */
export function adoptPaperFillCalibration(input: {
  queueClearFraction: number;
  heldOutWindows: number;
  reason: string;
}): Promise<PaperFillCalibrationStore> {
  return serialized(async () => {
    if (!Number.isFinite(input.queueClearFraction)
      || input.queueClearFraction < 0 || input.queueClearFraction >= PAPER_FILL_QUEUE_CLEAR_MAX) {
      throw new Error(`queueClearFraction must be in [0, ${PAPER_FILL_QUEUE_CLEAR_MAX}).`);
    }
    if (!Number.isSafeInteger(input.heldOutWindows) || input.heldOutWindows <= 0) {
      throw new Error('heldOutWindows must be a positive safe integer.');
    }
    const reason = input.reason.trim();
    if (!reason) throw new Error('A non-empty adoption reason is required.');

    const store = await readStore();
    const generation = PAPER_FIRST_ADOPTED_CALIBRATION_GENERATION + store.history.length;
    const adoptedAt = new Date().toISOString();
    const adopted: PaperFillCalibration = {
      version: PAPER_FILL_CALIBRATION_VERSION,
      queueClearFraction: input.queueClearFraction,
      appliedToPaperExecution: paperExecutionVersion(generation),
      heldOutWindows: input.heldOutWindows,
      adoptedAt,
      reason,
    };
    store.history = [...store.history, adopted];
    store.active = adopted;
    store.updatedAt = adoptedAt;
    await writeStore(store);
    return store;
  });
}

/** Read-only status for the operator surface. */
export function getPaperFillCalibrationStatus(): Promise<PaperFillCalibrationStore> {
  return serialized(async () => await readStore());
}
