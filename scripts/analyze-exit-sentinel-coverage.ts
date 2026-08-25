/**
 * Measure: active-generation exit-sentinel path coverage, split into genuine pre-close evaluator gaps,
 * non-opportunity cycles at/after contract close, and paper trigger-time depth gaps.
 * Deciding correction: this script does not change the published report; it shows the mechanical counterfactual
 * where cycles at or after the exact UTC close are excluded because an exit can no longer execute then.
 * Main biases: it reads only locally durable events, cannot explain a public quote that was never returned, and
 * the counterfactual may diagnose a reporting defect but can never promote an exit candidate.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ENTRY_EXECUTION_POLICY_VERSION } from '../lib/entry-execution-policy';
import {
  EXIT_POLICY_MINIMUM_COVERAGE, exitSentinelPathComplete, type ExitPolicySentinel,
} from '../lib/exit-policy-sentinel';
import {
  replayExitPolicySentinelEvents, type ExitPolicySentinelEvent, type ExitPolicySentinelStore,
} from '../lib/exit-policy-sentinel-store';
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION } from '../lib/paper-maker-simulation';
import { BUY_POLICY_VERSION } from '../lib/prediction-policy';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';
import type { ExecutionMode } from '../lib/types';

const dataDir = path.resolve(process.cwd(), 'data');
const snapshot = JSON.parse(await readFile(path.join(dataDir, 'exit-policy-sentinels-v2.json'), 'utf8')) as ExitPolicySentinelStore;
const journalLines = (await readFile(path.join(dataDir, 'exit-policy-sentinels-v2.journal.jsonl'), 'utf8'))
  .split('\n').filter(Boolean);
const events = journalLines.map((line) => JSON.parse(line) as ExitPolicySentinelEvent);
const sentinels = replayExitPolicySentinelEvents(snapshot.sentinels, events);
const ledger = await readExecutionLedger();
const orderIds = new Set(ledger.orders.map((order: { id: string }) => order.id));
const executionPolicyVersions: Record<ExecutionMode, string> = {
  live: ENTRY_EXECUTION_POLICY_VERSION,
  paper: PAPER_MANAGED_MAKER_EXECUTION_VERSION,
};

function triggerMissingPaperBook(sentinel: ExitPolicySentinel): string[] {
  if (sentinel.executionMode !== 'paper') return [];
  return Object.values(sentinel.candidateStates)
    .filter((state) => state.trigger && !state.trigger.exitIocSimulation?.evidenceComplete)
    .map((state) => state.candidateId);
}

function precloseCycles(sentinel: ExitPolicySentinel) {
  const closeMs = Date.parse(sentinel.closesAt);
  return sentinel.evaluationCycles.filter((cycle) => Date.parse(cycle.at) < closeMs);
}

function adjustedComplete(sentinel: ExitPolicySentinel): boolean {
  if (!sentinel.resolvedAt || sentinel.invalidReason) return false;
  const cycles = precloseCycles(sentinel);
  if (!cycles.length) return false;
  const observed = cycles.filter((cycle) => cycle.classification === 'observed').length;
  return observed / cycles.length + 1e-12 >= EXIT_POLICY_MINIMUM_COVERAGE
    && triggerMissingPaperBook(sentinel).length === 0;
}

function summarize(mode: ExecutionMode) {
  const positions = sentinels.filter((sentinel) => sentinel.executionMode === mode
    && sentinel.buyPolicyVersion === BUY_POLICY_VERSION
    && sentinel.executionPolicyVersion === executionPolicyVersions[mode]);
  const resolved = positions.filter((sentinel) => sentinel.resolvedAt && sentinel.holdPnlCents !== undefined
    && !sentinel.invalidReason && orderIds.has(sentinel.orderId));
  const complete = resolved.filter(exitSentinelPathComplete);
  const incomplete = resolved.filter((sentinel) => !exitSentinelPathComplete(sentinel));
  const allCycles = resolved.flatMap((sentinel) => sentinel.evaluationCycles.map((cycle) => ({ sentinel, cycle })));
  const postClose = allCycles.filter(({ sentinel, cycle }) => Date.parse(cycle.at) >= Date.parse(sentinel.closesAt));
  const preClose = allCycles.filter(({ sentinel, cycle }) => Date.parse(cycle.at) < Date.parse(sentinel.closesAt));
  const adjusted = resolved.filter(adjustedComplete);
  return {
    positions: positions.length,
    resolvedPositions: resolved.length,
    publishedCompletePositions: complete.length,
    publishedCoverage: resolved.length ? complete.length / resolved.length : 0,
    cycles: {
      total: allCycles.length,
      preClose: preClose.length,
      preCloseObserved: preClose.filter(({ cycle }) => cycle.classification === 'observed').length,
      preCloseUnavailable: preClose.filter(({ cycle }) => cycle.classification === 'unavailable').length,
      postClose: postClose.length,
      postCloseObserved: postClose.filter(({ cycle }) => cycle.classification === 'observed').length,
      postCloseUnavailable: postClose.filter(({ cycle }) => cycle.classification === 'unavailable').length,
    },
    mechanicalCounterfactualExcludingPostClose: {
      completePositions: adjusted.length,
      coverage: resolved.length ? adjusted.length / resolved.length : 0,
      authority: 'diagnostic only; published coverage and reviewUnlocked remain unchanged',
    },
    incompletePositions: incomplete.map((sentinel) => {
      const preClose = precloseCycles(sentinel);
      const preCloseObserved = preClose.filter((cycle) => cycle.classification === 'observed').length;
      const postClose = sentinel.evaluationCycles.filter((cycle) => Date.parse(cycle.at) >= Date.parse(sentinel.closesAt));
      return {
        id: sentinel.id,
        symbol: sentinel.symbol,
        side: sentinel.side,
        closesAt: sentinel.closesAt,
        positionOpenedAt: sentinel.positionOpenedAt,
        recordedAt: sentinel.recordedAt,
        resolvedAt: sentinel.resolvedAt,
        productionStatus: sentinel.production.status,
        preCloseCycles: preClose.length,
        preCloseObserved,
        preCloseCoverage: preClose.length ? preCloseObserved / preClose.length : 0,
        postCloseCycles: postClose.length,
        postCloseUnavailable: postClose.filter((cycle) => cycle.classification === 'unavailable').length,
        missingPaperTriggerBookEvidence: triggerMissingPaperBook(sentinel),
        adjustedComplete: adjustedComplete(sentinel),
      };
    }),
  };
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: {
    sentinelVersion: snapshot.sentinelVersion,
    startedAt: snapshot.startedAt,
    journalEvents: events.length,
    durableSentinels: sentinels.length,
    missingOrderLinks: sentinels.filter((sentinel) => !orderIds.has(sentinel.orderId)).length,
    invalidActiveSentinels: sentinels.filter((sentinel) => sentinel.buyPolicyVersion === BUY_POLICY_VERSION
      && sentinel.invalidReason).map((sentinel) => ({ id: sentinel.id, reason: sentinel.invalidReason })),
  },
  executionPolicyVersions,
  tracks: { live: summarize('live'), paper: summarize('paper') },
}, null, 2));
