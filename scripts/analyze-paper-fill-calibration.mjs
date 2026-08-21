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
 * public depth/prints cannot reveal cancellations or exact FIFO rank; the cohort is the current v6
 * mirror. Read-only over data/paper-orders.json; writes nothing and places no order.
 *
 * Reproduce: npm run analyze:paper-fill-calibration
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const EDGE = 'edge-binary-buy';

const ledger = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8'));
const orders = ledger.orders ?? [];
const entries = orders.filter((order) => !order.id.includes(':exit:') && (order.strategyId ?? EDGE) === EDGE);
const filled = (order) => (order.filledCount ?? 0) > 1e-8;
const terminal = (order) => !['pending_reservation', 'uncertain'].includes(order.status);

const grouped = new Map();
for (const order of entries) {
  if (!order.executionMirrorPair?.id) continue;
  const id = order.executionMirrorPair.id;
  grouped.set(id, [...(grouped.get(id) ?? []), order]);
}
const pairs = [];
for (const rows of grouped.values()) {
  const paper = rows.filter((order) => order.executionMode === 'paper');
  const live = rows.filter((order) => order.executionMode === 'live');
  if (paper.length !== 1 || live.length !== 1) continue;
  if (terminal(paper[0]) && terminal(live[0])) pairs.push({ paper: paper[0], live: live[0] });
}

const windows = [...new Set(pairs.map((pair) => pair.paper.closesAt))].sort();
const half = Math.ceil(windows.length / 2);
const heldOut = new Set(windows.slice(half));
const rows = pairs.filter((pair) => heldOut.has(pair.paper.closesAt));

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
console.log(`ledger rows ${orders.length} | paired terminal intents ${pairs.length} in ${windows.length} settlement windows`);
console.log(`held-out windows evaluated: ${heldOut.size}`);
console.log(`cells both / paper-only / live-only / neither: ${both} / ${paperOnly} / ${liveOnly} / ${neither}`);
console.log(`agreement ${percent(agreement)} | paper capture of live fills ${percent(capture)} | paper-positive precision ${percent(both / (both + paperOnly))}`);

console.log('\nStructural upper bound a queue-shortening calibration could target:');
console.log(`live-only fills paper's queue model missed: ${liveOnly} (summed live realized P&L ${liveOnlyPnlSource}c)`);
console.log('These are attempted-but-unfilled paper rows whose queue simulation refused the live fill.');
console.log('They bound any queue-clear recovery but are NOT a calibration prediction: the ledger lacks');
console.log('per-print streams, and a honest adoption requires holding those prints for a validation split.');

console.log('\nNo promotion: per SPEC §12.5 a queueClearFraction is adopted only as a recorded manual act');
console.log('into a new paper cohort (v7), never from this retrospective, read-only review.');