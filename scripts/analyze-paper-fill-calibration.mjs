#!/usr/bin/env node
/**
 * Held-out review of the paper fill model and the configurable `queueClearFraction`.
 *
 * Deciding measure: on a held-out half of settlement windows, how well does the current paper fill
 * model reproduce contemporaneous live fills, and how many live-only fills are the structural target
 * of a cancellation/fifo queue-clear fraction?
 *
 * Honesty constraint: the ledger does NOT retain a per-print replay stream (it keeps bounded
 * `paper_trade_evidence` summaries). A candidate fraction therefore cannot be faithfully re-simulated
 * here; the live-only row count is an UPPER BOUND on what any queue-shortening could recover, not a
 * prediction. No value is adopted by this script. A real adoption requires the record itself to carry
 * enough per-read evidence to replay, and SPEC §12.5's manual-promotion rule.
 *
 * Biases: pairing conditions on both lanes issuing, excluding paper operation while live was paused;
 * public depth/prints cannot reveal cancellations or exact FIFO rank. The active calibration's exact
 * paper execution generation is selected before the held-out split; generations are never pooled.
 * Read-only over data/paper-orders.json and the calibration store; writes nothing and places no order.
 *
 * Reproduce: npm run analyze:paper-fill-calibration
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const EDGE = 'edge-binary-buy';
const LEGACY_NEUTRAL_PAPER_EXECUTION = 'paper-managed-execution-route-ioc-requalify3-calibrated-v6';
const NEUTRAL_PAPER_EXECUTION = 'paper-managed-execution-route-ioc-requalify3-calibrated-v7';
const FIRST_ADOPTED_GENERATION = 8;
const calibrationDirectory = process.env.MONEY_NOODLE_PAPER_FILL_CALIBRATION_PATH?.trim() || DATA;

const executionGeneration = (version) => {
  const match = /^paper-managed-execution-route-ioc-requalify3-calibrated-v(\d+)$/.exec(version ?? '');
  const generation = Number(match?.[1]);
  return Number.isSafeInteger(generation) && generation >= 6 ? generation : null;
};
const validCalibration = (calibration) => {
  const generation = executionGeneration(calibration?.appliedToPaperExecution);
  if (calibration?.version !== 'paper-fill-calibration-v1'
    || !Number.isFinite(calibration?.queueClearFraction)
    || calibration.queueClearFraction < 0 || calibration.queueClearFraction >= 0.5
    || !Number.isSafeInteger(calibration?.heldOutWindows) || calibration.heldOutWindows < 0
    || typeof calibration?.adoptedAt !== 'string'
    || typeof calibration?.reason !== 'string' || !calibration.reason.trim()
    || generation === null) return false;
  return generation === 6 || generation === 7
    ? calibration.queueClearFraction === 0 && calibration.heldOutWindows === 0 && calibration.adoptedAt === ''
    : calibration.heldOutWindows > 0 && Number.isFinite(Date.parse(calibration.adoptedAt));
};
const sameCalibration = (left, right) => left && right
  && ['version', 'queueClearFraction', 'appliedToPaperExecution', 'heldOutWindows', 'adoptedAt', 'reason']
    .every((field) => left[field] === right[field]);

async function activePaperExecutionVersion() {
  try {
    const store = JSON.parse(await readFile(path.join(calibrationDirectory, 'paper-fill-calibration.json'), 'utf8'));
    const history = store?.history;
    if (store?.version !== 1 || !validCalibration(store.active) || !Array.isArray(history)
      || !history.every((item, index) => validCalibration(item)
        && executionGeneration(item.appliedToPaperExecution) === index + FIRST_ADOPTED_GENERATION)
      || (history.length === 0
        ? store.active.appliedToPaperExecution !== NEUTRAL_PAPER_EXECUTION
          && store.active.appliedToPaperExecution !== LEGACY_NEUTRAL_PAPER_EXECUTION
        : !sameCalibration(store.active, history.at(-1)))) {
      throw new Error('Paper fill calibration store is malformed or has discontinuous cohort history.');
    }
    return history.length === 0 && store.active.appliedToPaperExecution === LEGACY_NEUTRAL_PAPER_EXECUTION
      ? NEUTRAL_PAPER_EXECUTION : store.active.appliedToPaperExecution;
  } catch (error) {
    if (error?.code === 'ENOENT') return NEUTRAL_PAPER_EXECUTION;
    throw error;
  }
}

const selectedPaperExecution = await activePaperExecutionVersion();
const ledger = await readExecutionLedger(DATA);
const orders = ledger.orders ?? [];
const entries = orders.filter((order) => !order.id.includes(':exit:') && (order.strategyId ?? EDGE) === EDGE);
const executionVersion = (order) => order.entryDecision?.executionPolicyVersion ?? order.executionPolicyVersion;
const filled = (order) => (order.filledCount ?? 0) > 1e-8;
const terminal = (order) => !['pending_reservation', 'uncertain', 'open'].includes(order.status);
const route = (order) => order.paperEntryRoute ?? order.entryExecutionDecision?.executedStyle
  ?? order.liquidityRole ?? 'unknown';
const requestedQuantity = (order) => order.requestedQuantity ?? order.quantity;

const grouped = new Map();
for (const order of entries) {
  if (!order.executionMirrorPair?.id) continue;
  const id = order.executionMirrorPair.id;
  grouped.set(id, [...(grouped.get(id) ?? []), order]);
}
const pairs = [];
for (const rows of grouped.values()) {
  const paper = rows.filter((order) => order.executionMode === 'paper'
    && executionVersion(order) === selectedPaperExecution);
  const live = rows.filter((order) => order.executionMode === 'live');
  if (paper.length !== 1 || live.length !== 1) continue;
  if (terminal(paper[0]) && terminal(live[0])) pairs.push({ paper: paper[0], live: live[0] });
}

// Queue calibration begins only after both lanes chose the same maker terms and live proved venue
// acceptance. A post-only create race or route/quantity difference is an earlier lifecycle mismatch,
// not evidence that the paper queue was too long or short.
const comparablePairs = pairs.filter((pair) => Boolean(pair.live.venueOrderId)
  && route(pair.paper) === 'maker' && route(pair.live) === 'maker'
  && Math.abs(requestedQuantity(pair.paper) - requestedQuantity(pair.live)) <= 1e-8);
const windows = [...new Set(comparablePairs.map((pair) => pair.paper.closesAt))].sort();
const half = Math.ceil(windows.length / 2);
const heldOut = new Set(windows.slice(half));
const rows = comparablePairs.filter((pair) => heldOut.has(pair.paper.closesAt));

let both = 0, paperOnly = 0, liveOnly = 0, neither = 0;
let liveOnlyPnlSource = 0;
for (const row of rows) {
  const pf = filled(row.paper), lf = filled(row.live);
  if (pf && lf) both += 1;
  else if (pf) paperOnly += 1;
  else if (lf) { liveOnly += 1; liveOnlyPnlSource += Number(row.live.pnlCents ?? row.live.actualPnlCents ?? 0); }
  else neither += 1;
}
const liveFills = both + liveOnly;
const agreement = rows.length ? (both + neither) / rows.length : null;
const capture = liveFills ? both / liveFills : null;

const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

console.log(`# Paper fill calibration held-out review — ${new Date().toISOString()}`);
console.log(`paper execution cohort: ${selectedPaperExecution}`);
console.log(`ledger rows ${orders.length} | exact terminal pair identities ${pairs.length}`);
console.log(`accepted same-route/same-quantity maker pairs ${comparablePairs.length} in ${windows.length} settlement windows`);
console.log(`excluded before queue comparison: ${pairs.length - comparablePairs.length}`);
console.log(`held-out accepted-maker windows evaluated: ${heldOut.size}`);
console.log(`cells both / paper-only / live-only / neither: ${both} / ${paperOnly} / ${liveOnly} / ${neither}`);
console.log(`agreement ${percent(agreement)} | paper capture of live fills ${percent(capture)} | paper-positive precision ${percent(both / (both + paperOnly))}`);

console.log('\nStructural upper bound a queue-shortening calibration could target:');
console.log(`live-only fills paper's queue model missed: ${liveOnly} (summed live realized P&L ${liveOnlyPnlSource}c)`);
console.log('These are attempted-but-unfilled paper rows whose queue simulation refused the live fill.');
console.log('They bound any queue-clear recovery but are NOT a calibration prediction: the ledger lacks');
console.log('per-print streams, and a honest adoption requires holding those prints for a validation split.');

console.log('\nNo promotion: per SPEC §12.5 a queueClearFraction is adopted only as a recorded manual act');
console.log('into the next generated paper cohort, never from this retrospective, read-only review.');