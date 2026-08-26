/**
 * Measure: active-generation exit-sentinel path coverage, split into genuine pre-close evaluator gaps,
 * non-opportunity cycles at/after contract close, and paper trigger-time depth gaps.
 * Deciding correction: compare the legacy all-cycle denominator with the approved close-bounded v2 semantics,
 * where only cycles from position opening up to (but not including) exact UTC close are evaluator opportunities.
 * Main biases: it reads only locally durable events, cannot explain a public quote that was never returned, and
 * the denominator comparison diagnoses coverage only and can never promote an exit candidate.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ENTRY_EXECUTION_POLICY_VERSION } from '../lib/entry-execution-policy';
import {
  EXIT_POLICY_MINIMUM_COVERAGE, exitSentinelPathComplete, isExitEvaluationOpportunity,
  type ExitPolicySentinel,
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
const recordedCyclesById = new Map(snapshot.sentinels.map((sentinel) => [sentinel.id, [...sentinel.evaluationCycles]]));
for (const event of events) {
  if (event.op !== 'evaluation-cycle') continue;
  const cycles = recordedCyclesById.get(event.id) ?? [];
  if (!cycles.some((cycle) => cycle.at === event.value.at)) cycles.push(event.value);
  recordedCyclesById.set(event.id, cycles);
}
const withRecordedCycles = (sentinel: ExitPolicySentinel): ExitPolicySentinel => ({
  ...sentinel, evaluationCycles: recordedCyclesById.get(sentinel.id) ?? sentinel.evaluationCycles,
});
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
  return sentinel.evaluationCycles.filter((cycle) => isExitEvaluationOpportunity(sentinel, cycle.at));
}

function legacyPathComplete(sentinel: ExitPolicySentinel): boolean {
  if (!sentinel.resolvedAt || sentinel.invalidReason || !sentinel.evaluationCycles.length) return false;
  const observed = sentinel.evaluationCycles.filter((cycle) => cycle.classification === 'observed').length;
  return observed / sentinel.evaluationCycles.length + 1e-12 >= EXIT_POLICY_MINIMUM_COVERAGE
    && triggerMissingPaperBook(sentinel).length === 0;
}

function summarize(mode: ExecutionMode) {
  const positions = sentinels.filter((sentinel) => sentinel.executionMode === mode
    && sentinel.buyPolicyVersion === BUY_POLICY_VERSION
    && sentinel.executionPolicyVersion === executionPolicyVersions[mode]);
  const resolved = positions.filter((sentinel) => sentinel.resolvedAt && sentinel.holdPnlCents !== undefined
    && !sentinel.invalidReason && orderIds.has(sentinel.orderId));
  const legacyComplete = resolved.filter((sentinel) => legacyPathComplete(withRecordedCycles(sentinel)));
  const closeBoundedComplete = resolved.filter(exitSentinelPathComplete);
  const legacyIncomplete = resolved.filter((sentinel) => !legacyPathComplete(withRecordedCycles(sentinel)));
  const closeBoundedIncomplete = resolved.filter((sentinel) => !exitSentinelPathComplete(sentinel));
  const allCycles = resolved.flatMap((sentinel) => withRecordedCycles(sentinel).evaluationCycles
    .map((cycle) => ({ sentinel, cycle })));
  const postClose = allCycles.filter(({ sentinel, cycle }) => Date.parse(cycle.at) >= Date.parse(sentinel.closesAt));
  const preClose = allCycles.filter(({ sentinel, cycle }) => isExitEvaluationOpportunity(sentinel, cycle.at));
  const preCloseUnavailable = preClose.filter(({ cycle }) => cycle.classification === 'unavailable');
  const secondsBeforeClose = preCloseUnavailable.map(({ sentinel, cycle }) =>
    (Date.parse(sentinel.closesAt) - Date.parse(cycle.at)) / 1_000);
  return {
    positions: positions.length,
    resolvedPositions: resolved.length,
    legacyCompletePositions: legacyComplete.length,
    legacyCoverage: resolved.length ? legacyComplete.length / resolved.length : 0,
    cycles: {
      total: allCycles.length,
      preClose: preClose.length,
      preCloseObserved: preClose.filter(({ cycle }) => cycle.classification === 'observed').length,
      preCloseUnavailable: preCloseUnavailable.length,
      preCloseUnavailableBySecondsBeforeClose: {
        atMost15: secondsBeforeClose.filter((seconds) => seconds <= 15).length,
        over15To30: secondsBeforeClose.filter((seconds) => seconds > 15 && seconds <= 30).length,
        over30To60: secondsBeforeClose.filter((seconds) => seconds > 30 && seconds <= 60).length,
        over60To90: secondsBeforeClose.filter((seconds) => seconds > 60 && seconds <= 90).length,
        over90: secondsBeforeClose.filter((seconds) => seconds > 90).length,
      },
      postClose: postClose.length,
      postCloseObserved: postClose.filter(({ cycle }) => cycle.classification === 'observed').length,
      postCloseUnavailable: postClose.filter(({ cycle }) => cycle.classification === 'unavailable').length,
    },
    approvedCloseBoundedCoverage: {
      completePositions: closeBoundedComplete.length,
      coverage: resolved.length ? closeBoundedComplete.length / resolved.length : 0,
      authority: 'official v2 reporting semantics approved 2026-08-25',
    },
    resolvedOutcomes: {
      wins: resolved.filter((sentinel) => sentinel.outcome === sentinel.side).length,
      losses: resolved.filter((sentinel) => sentinel.outcome && sentinel.outcome !== sentinel.side).length,
    },
    closeBoundedCompleteOutcomes: {
      wins: closeBoundedComplete.filter((sentinel) => sentinel.outcome === sentinel.side).length,
      losses: closeBoundedComplete.filter((sentinel) => sentinel.outcome && sentinel.outcome !== sentinel.side).length,
    },
    closeBoundedIncompleteOutcomes: {
      positions: closeBoundedIncomplete.length,
      wins: closeBoundedIncomplete.filter((sentinel) => sentinel.outcome === sentinel.side).length,
      losses: closeBoundedIncomplete.filter((sentinel) => sentinel.outcome && sentinel.outcome !== sentinel.side).length,
      zeroEligibleCycles: closeBoundedIncomplete.filter((sentinel) => precloseCycles(sentinel).length === 0).length,
      missingPaperTriggerBook: closeBoundedIncomplete.filter((sentinel) => triggerMissingPaperBook(sentinel).length > 0).length,
    },
    legacyIncompletePositions: legacyIncomplete.map((currentSentinel) => {
      const sentinel = withRecordedCycles(currentSentinel);
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
        outcome: sentinel.outcome,
        economicOutcome: sentinel.outcome === sentinel.side ? 'win' : 'loss',
        preCloseCycles: preClose.length,
        preCloseObserved,
        preCloseCoverage: preClose.length ? preCloseObserved / preClose.length : 0,
        postCloseCycles: postClose.length,
        postCloseUnavailable: postClose.filter((cycle) => cycle.classification === 'unavailable').length,
        missingPaperTriggerBookEvidence: triggerMissingPaperBook(sentinel),
        closeBoundedComplete: exitSentinelPathComplete(sentinel),
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
