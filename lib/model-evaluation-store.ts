import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getForecastHistory } from './forecast-tracker';
import type { WalkForwardEvaluationHistory } from './types';
import {
  buildWalkForwardDataset, runWalkForwardEvaluation, WALK_FORWARD_ACTIVATION_WINDOWS,
  WALK_FORWARD_CHECKPOINT_WINDOWS, WALK_FORWARD_POLICY_VERSION,
} from './walk-forward';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const EVALUATION_FILE = path.join(DATA_DIR, 'model-evaluations.json');
let operationQueue: Promise<void> = Promise.resolve();

function emptyHistory(currentWindows = 0): WalkForwardEvaluationHistory {
  return {
    policyVersion: WALK_FORWARD_POLICY_VERSION,
    activationWindows: WALK_FORWARD_ACTIVATION_WINDOWS,
    checkpointEveryWindows: WALK_FORWARD_CHECKPOINT_WINDOWS,
    currentWindows,
    nextCheckpointWindows: WALK_FORWARD_ACTIVATION_WINDOWS,
    runs: [],
  };
}

async function readStored(): Promise<WalkForwardEvaluationHistory> {
  try {
    const parsed = JSON.parse(await readFile(EVALUATION_FILE, 'utf8')) as WalkForwardEvaluationHistory;
    if (!Array.isArray(parsed.runs)) throw new Error('Model evaluation history has no run collection.');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyHistory();
    await rename(EVALUATION_FILE, `${EVALUATION_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Model evaluation history was malformed and has been quarantined:', error);
    return emptyHistory();
  }
}

async function writeStored(history: WalkForwardEvaluationHistory): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${EVALUATION_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(history, null, 2));
  await rename(temporary, EVALUATION_FILE);
}

function nextCheckpoint(history: WalkForwardEvaluationHistory): number {
  return history.runs.length
    ? Math.max(...history.runs.map((run) => run.checkpointWindows)) + WALK_FORWARD_CHECKPOINT_WINDOWS
    : WALK_FORWARD_ACTIVATION_WINDOWS;
}

export function getWalkForwardEvaluationHistory(currentWindows = 0): Promise<WalkForwardEvaluationHistory> {
  const operation = operationQueue.then(async () => {
    const history = await readStored();
    return { ...history, currentWindows, nextCheckpointWindows: nextCheckpoint(history) };
  });
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Dormant below 100 windows; thereafter catches up every missed 25-window checkpoint exactly once. */
export function maybeRunWalkForwardEvaluation(currentWindows: number): Promise<WalkForwardEvaluationHistory> {
  const operation = operationQueue.then(async () => {
    const history = await readStored();
    history.currentWindows = currentWindows;
    let checkpoint = nextCheckpoint(history);
    if (currentWindows < checkpoint) return { ...history, nextCheckpointWindows: checkpoint };
    const dataset = buildWalkForwardDataset(await getForecastHistory());
    while (checkpoint <= dataset.length) {
      const run = runWalkForwardEvaluation(dataset, checkpoint);
      if (!history.runs.some((existing) => existing.id === run.id)) history.runs.push(run);
      checkpoint += WALK_FORWARD_CHECKPOINT_WINDOWS;
    }
    history.policyVersion = WALK_FORWARD_POLICY_VERSION;
    history.currentWindows = dataset.length;
    history.nextCheckpointWindows = checkpoint;
    await writeStored(history);
    return history;
  });
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
