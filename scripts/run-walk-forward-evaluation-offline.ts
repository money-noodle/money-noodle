#!/usr/bin/env node
/**
 * Explicit operational writer for monitoring-only walk-forward evaluator v2.
 *
 * Writes only data/model-evaluations.json through the store's atomic publication path. It never places an
 * order or changes a model/policy. On the funded host: Pause, confirm restart-safe, stop the worker, then run:
 *
 *   MONEY_NOODLE_OFFLINE_EVALUATION=CONFIRM_STOPPED npm run evaluate:walk-forward-offline
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getWalkForwardEvaluationHistory, runWalkForwardEvaluationOffline } from '../lib/model-evaluation-store';
import { offlineEvaluationBlockers } from '../lib/offline-evaluation-gate';
import type { BudgetControl } from '../lib/types';

interface StoredControl {
  control: BudgetControl;
}

const controlPath = path.resolve(process.cwd(), 'data/trading-control.json');
const stored = JSON.parse(await readFile(controlPath, 'utf8')) as StoredControl;
const blockers = offlineEvaluationBlockers(stored.control, process.env.MONEY_NOODLE_OFFLINE_EVALUATION);
if (blockers.length) throw new Error(`Offline walk-forward evaluation refused: ${blockers.join(' ')}`);

const before = await getWalkForwardEvaluationHistory();
const after = await runWalkForwardEvaluationOffline();
const added = after.runs.slice(before.runs.length);
console.log(JSON.stringify({
  policyVersion: after.policyVersion,
  datasetWindows: after.currentWindows,
  previousRuns: before.runs.length,
  currentRuns: after.runs.length,
  addedRuns: added.map((run) => ({
    id: run.id, checkpointWindows: run.checkpointWindows, generatedAt: run.generatedAt,
    datasetFingerprint: run.datasetFingerprint,
  })),
  nextCheckpointWindows: after.nextCheckpointWindows,
}, null, 2));
