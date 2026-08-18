import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_BANDS_VERSION, normaliseBands, type AnalysisBand } from './analysis-bands';

/**
 * Operator-defined analysis bands, and every set that has ever been saved.
 *
 * **The history is the point, not a convenience.** A surface that lets an operator define bands and see
 * them scored over recorded data is a retroactive-screening machine, and the number of configurations
 * tried is the multiple-comparison denominator (AGENTS §5.3). Keeping only the current set would let forty
 * attempts be made and one remembered, which is how a cell that looked good becomes a policy change.
 * Superseded sets are therefore never deleted, exactly as a superseded report never is.
 *
 * Nothing here may gate, size, price, or trade, and `lib/analysis-bands.test.ts` asserts that no module
 * which can do those things imports this one. See docs/long-shot-policy-design.md §15a.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const BANDS_FILE = path.join(DATA_DIR, 'analysis-bands.json');
/** Bounded so an operator sweeping bands cannot grow the file without limit; the count is never reset. */
const MAX_HISTORY = 200;

export interface AnalysisBandSet {
  savedAt: string;
  bands: AnalysisBand[];
}

export interface AnalysisBandStore {
  version: 1;
  bandsVersion: string;
  current: AnalysisBand[];
  /** Newest first. Retained so the surface can state how many configurations have been evaluated. */
  history: AnalysisBandSet[];
  /** Total sets ever saved, including any trimmed from `history`. The comparison count, and it only rises. */
  savedCount: number;
}

/**
 * The bands in force when nothing has been saved.
 *
 * The production marks are included so the surface opens showing the live configuration measured on the
 * same footing as anything the operator proposes — a candidate must beat the live rule (AGENTS §5.4), and
 * that is easiest to hold to when the live rule is on screen by default.
 */
export const DEFAULT_ANALYSIS_BANDS: AnalysisBand[] = [
  { id: 'live-10-90', label: 'live rule (≤10¢ → 90¢)', entryLowCents: 0, entryHighCents: 10, exitCents: 90 },
  { id: 'live-10-95', label: '≤10¢ → 95¢', entryLowCents: 0, entryHighCents: 10, exitCents: 95 },
  { id: 'mid-20-60', label: '15–20¢ → 60¢', entryLowCents: 15, entryHighCents: 20, exitCents: 60 },
  { id: 'near-45-60', label: '40–45¢ → 60¢', entryLowCents: 40, entryHighCents: 45, exitCents: 60 },
];

const emptyStore = (): AnalysisBandStore => ({
  version: 1, bandsVersion: ANALYSIS_BANDS_VERSION, current: DEFAULT_ANALYSIS_BANDS, history: [], savedCount: 0,
});

export async function readAnalysisBands(): Promise<AnalysisBandStore> {
  try {
    const parsed = JSON.parse(await readFile(BANDS_FILE, 'utf8')) as Partial<AnalysisBandStore>;
    const normalised = normaliseBands(parsed.current);
    // A stored set that no longer validates is quarantined rather than silently trimmed: results would
    // otherwise be attributed to a band nobody defined.
    if ('error' in normalised) throw new Error(normalised.error);
    return {
      version: 1,
      bandsVersion: ANALYSIS_BANDS_VERSION,
      current: normalised.bands,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      savedCount: Number.isFinite(parsed.savedCount) ? Number(parsed.savedCount) : 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    await rename(BANDS_FILE, `${BANDS_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Analysis band store was malformed and has been quarantined:', error);
    return emptyStore();
  }
}

/**
 * Saves a band set, appending the previous one to history.
 *
 * Serialized behind a queue and written atomically, per AGENTS §3. Returns the stored shape so the caller
 * reports what was actually persisted rather than what it sent.
 */
let queue: Promise<unknown> = Promise.resolve();

export function saveAnalysisBands(input: unknown): Promise<{ store: AnalysisBandStore } | { error: string }> {
  const operation = queue.then(async () => {
    const normalised = normaliseBands(input);
    if ('error' in normalised) return normalised;
    const existing = await readAnalysisBands();
    const savedAt = new Date().toISOString();
    const store: AnalysisBandStore = {
      version: 1,
      bandsVersion: ANALYSIS_BANDS_VERSION,
      current: normalised.bands,
      history: [{ savedAt, bands: normalised.bands }, ...existing.history].slice(0, MAX_HISTORY),
      // Never derived from `history.length`, which is trimmed. Every evaluation counts against the
      // comparison budget whether or not its definition is still on file.
      savedCount: existing.savedCount + 1,
    };
    await mkdir(DATA_DIR, { recursive: true });
    const temporary = `${BANDS_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2));
    await rename(temporary, BANDS_FILE);
    return { store };
  });
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}
