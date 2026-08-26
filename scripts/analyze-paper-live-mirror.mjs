#!/usr/bin/env node
/**
 * Current exact paper/live execution-mirror review.
 *
 * Measures: decision/route/quantity parity and the four terminal fill cells for the active paper execution
 * generation against the active live execution generation, using only prospective exact mirror-pair IDs.
 *
 * Deciding corrections:
 * - scope starts at the first active-live-generation intent, so earlier paper-only operation cannot inflate
 *   one-sided IDs;
 * - one pair requires exactly one paper and one live row with the same immutable mirror ID; no nearest-time
 *   inference or timestamp tolerance is allowed;
 * - fill-rate differences are averaged inside UTC settlement close before uncertainty is estimated;
 * - exact reporting P&L and whole-cent control P&L remain separate; no-fill spends zero.
 *
 * Biases and limits:
 * - exact pairs condition on both lanes issuing; one-sided intents are counted but cannot score fill fidelity;
 * - accepted-maker fidelity still lacks private FIFO rank and cancellations ahead;
 * - live operational gates and capital deliberately differ from paper, so intent coverage is not expected
 *   to be 100%; this review cannot tune policy, calibrate paper, or promote a generation;
 * - the active identities below must advance explicitly with a future execution-generation change.
 *
 * Read-only: hydrates the durable execution ledger, writes no data, calls no venue, and places no order.
 * Reproduce: npm run analyze:paper-live-mirror
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const EDGE = 'edge-binary-buy';
const PAPER_VERSION = 'paper-managed-execution-route-ioc-requalify3-calibrated-v6';
const LIVE_VERSION = 'maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7';
const NONTERMINAL = new Set(['open', 'pending_reservation', 'uncertain']);

const ledger = await readExecutionLedger(DATA);
const entries = (ledger.orders ?? []).filter((order) => !order.id.includes(':exit:')
  && (order.strategyId ?? EDGE) === EDGE && order.executionMirrorPair?.id);
const paperVersion = (order) => order.entryDecision?.executionPolicyVersion
  ?? order.executionPolicyVersion ?? 'missing';
const liveVersion = (order) => order.entryExecutionDecision?.policyVersion
  ?? order.executionPolicyVersion ?? 'missing';
const route = (order) => order.entryExecutionDecision?.executedStyle
  ?? order.paperEntryRoute ?? order.liquidityRole ?? 'unknown';
const requestedQuantity = (order) => order.requestedQuantity ?? order.quantity;
const filled = (order) => (order.filledCount ?? 0) > 1e-8;
const exactStake = (order) => filled(order) ? order.actualStakeCents ?? order.stakeCents ?? 0 : 0;
const exactPnl = (order) => filled(order) ? order.actualPnlCents ?? order.pnlCents ?? 0 : 0;
const wholePnl = (order) => filled(order) ? order.pnlCents ?? 0 : 0;
const terminal = (order) => !NONTERMINAL.has(order.status);

const allCurrentLive = entries.filter((order) => order.executionMode === 'live' && liveVersion(order) === LIVE_VERSION);
const scopeStartMs = allCurrentLive.length
  ? Math.min(...allCurrentLive.map((order) => Date.parse(order.createdAt))) : Number.POSITIVE_INFINITY;
const currentPaper = entries.filter((order) => order.executionMode === 'paper'
  && paperVersion(order) === PAPER_VERSION && Date.parse(order.createdAt) >= scopeStartMs);
const currentLive = allCurrentLive.filter((order) => Date.parse(order.createdAt) >= scopeStartMs);

const grouped = new Map();
for (const order of [...currentPaper, ...currentLive]) {
  const id = order.executionMirrorPair.id;
  grouped.set(id, [...(grouped.get(id) ?? []), order]);
}

const pairs = [];
let paperOnlyIntents = 0, liveOnlyIntents = 0, ambiguousPairIds = 0;
for (const rows of grouped.values()) {
  const paper = rows.filter((order) => order.executionMode === 'paper');
  const live = rows.filter((order) => order.executionMode === 'live');
  if (paper.length > 1 || live.length > 1) { ambiguousPairIds += 1; continue; }
  if (paper.length === 1 && live.length === 1) pairs.push({ paper: paper[0], live: live[0] });
  else if (paper.length === 1) paperOnlyIntents += 1;
  else if (live.length === 1) liveOnlyIntents += 1;
}
const terminalPairs = pairs.filter((pair) => terminal(pair.paper) && terminal(pair.live));

function cells(items) {
  const result = Object.fromEntries(['both', 'paperOnly', 'liveOnly', 'neither'].map((key) => [key, {
    pairs: 0,
    paperExactStakeCents: 0, paperExactPnlCents: 0, paperWholePnlCents: 0,
    liveExactStakeCents: 0, liveExactPnlCents: 0, liveWholePnlCents: 0,
  }]));
  for (const pair of items) {
    const paperFilled = filled(pair.paper), liveFilled = filled(pair.live);
    const key = paperFilled ? liveFilled ? 'both' : 'paperOnly' : liveFilled ? 'liveOnly' : 'neither';
    const cell = result[key];
    cell.pairs += 1;
    cell.paperExactStakeCents += exactStake(pair.paper);
    cell.paperExactPnlCents += exactPnl(pair.paper);
    cell.paperWholePnlCents += wholePnl(pair.paper);
    cell.liveExactStakeCents += exactStake(pair.live);
    cell.liveExactPnlCents += exactPnl(pair.live);
    cell.liveWholePnlCents += wholePnl(pair.live);
  }
  return result;
}

function clusteredFillDifference(items) {
  const windows = new Map();
  for (const pair of items) {
    const value = Number(filled(pair.paper)) - Number(filled(pair.live));
    windows.set(pair.paper.closesAt, [...(windows.get(pair.paper.closesAt) ?? []), value]);
  }
  const values = [...windows.values()].map((rows) => rows.reduce((sum, value) => sum + value, 0) / rows.length);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const standardError = mean !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { windows: values.length, mean, standardError };
}

function summary(items) {
  const matrix = cells(items);
  const both = matrix.both.pairs, paperOnly = matrix.paperOnly.pairs;
  const liveOnly = matrix.liveOnly.pairs, neither = matrix.neither.pairs;
  return {
    pairs: items.length,
    windows: new Set(items.map((pair) => pair.paper.closesAt)).size,
    cells: matrix,
    paperFillRate: items.length ? (both + paperOnly) / items.length : null,
    liveFillRate: items.length ? (both + liveOnly) / items.length : null,
    fillAgreement: items.length ? (both + neither) / items.length : null,
    paperCaptureOfLiveFills: both + liveOnly ? both / (both + liveOnly) : null,
    paperPositivePrecision: both + paperOnly ? both / (both + paperOnly) : null,
    clusteredPaperMinusLiveFillRate: clusteredFillDifference(items),
  };
}

const sameRoute = terminalPairs.filter((pair) => route(pair.paper) === route(pair.live));
const routeMismatches = terminalPairs.filter((pair) => route(pair.paper) !== route(pair.live));
const expectedTreatmentWithholds = routeMismatches.filter((pair) =>
  pair.paper.boundedTakerExperiment?.execution === 'paper-treatment-simulation'
  && pair.live.boundedTakerExperiment?.execution === 'treatment-withheld');
const sameQuantity = terminalPairs.filter((pair) => Math.abs(requestedQuantity(pair.paper) - requestedQuantity(pair.live)) <= 1e-8);
const acceptedSameRouteMaker = terminalPairs.filter((pair) => Boolean(pair.live.venueOrderId)
  && route(pair.paper) === 'maker' && route(pair.live) === 'maker'
  && Math.abs(requestedQuantity(pair.paper) - requestedQuantity(pair.live)) <= 1e-8);
function bothFilledTerms(items) {
  const both = items.filter((pair) => filled(pair.paper) && filled(pair.live));
  const priceDifferencesCents = both.flatMap((pair) =>
    Number.isFinite(pair.paper.authoritativeFillPrice) && Number.isFinite(pair.live.authoritativeFillPrice)
      ? [(pair.paper.authoritativeFillPrice - pair.live.authoritativeFillPrice) * 100] : []);
  return {
    attempts: both.length,
    sameAcquiredQuantity: both.filter((pair) => Math.abs((pair.paper.filledCount ?? 0)
      - (pair.live.filledCount ?? 0)) <= 1e-8).length,
    meanPaperMinusLiveFillPriceCents: priceDifferencesCents.length
      ? priceDifferencesCents.reduce((sum, value) => sum + value, 0) / priceDifferencesCents.length : null,
  };
}

const currentRows = [...currentPaper, ...currentLive];
const scopeEndMs = currentRows.length ? Math.max(...currentRows.map((order) => Date.parse(order.createdAt))) : null;
const openPaperStake = (ledger.orders ?? []).filter((order) => order.executionMode === 'paper'
  && (order.strategyId ?? EDGE) === EDGE && !order.id.includes(':exit:') && NONTERMINAL.has(order.status))
  .reduce((sum, order) => sum + (order.stakeCents ?? 0), 0);
const expectedPaperAvailable = ledger.paperBudget.startingCents + ledger.paperBudget.realizedPnlCents - openPaperStake;
const hydratedLedgerSha256 = createHash('sha256').update(JSON.stringify(ledger)).digest('hex');

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  identities: { mirrorPairVersion: 'entry-execution-mirror-pair-v1', paperExecutionVersion: PAPER_VERSION, liveExecutionVersion: LIVE_VERSION },
  scope: {
    startsAt: Number.isFinite(scopeStartMs) ? new Date(scopeStartMs).toISOString() : null,
    endsAt: scopeEndMs === null ? null : new Date(scopeEndMs).toISOString(),
    rule: 'Starts at the first active live-v7 intent; exact pair identity only; no timestamp pairing.',
  },
  inputs: {
    ledgerRows: ledger.orders.length,
    hydratedLedgerSha256,
    paperIntents: currentPaper.length,
    liveIntents: currentLive.length,
    distinctPairIds: grouped.size,
  },
  identityCoverage: {
    exactPairs: pairs.length,
    terminalPairs: terminalPairs.length,
    awaitingPairs: pairs.length - terminalPairs.length,
    paperOnlyIntents,
    liveOnlyIntents,
    ambiguousPairIds,
    sameRoute: sameRoute.length,
    routeMismatches: routeMismatches.length,
    expectedLiveTreatmentWithholds: expectedTreatmentWithholds.length,
    unexpectedRouteMismatches: routeMismatches.length - expectedTreatmentWithholds.length,
    sameRequestedQuantity: sameQuantity.length,
  },
  allExactTerminalPairs: summary(terminalPairs),
  acceptedSameRouteMaker: summary(acceptedSameRouteMaker),
  bothFilledTerms: bothFilledTerms(terminalPairs),
  acceptedSameRouteMakerBothFilledTerms: bothFilledTerms(acceptedSameRouteMaker),
  paperBankrollControl: {
    startingCents: ledger.paperBudget.startingCents,
    realizedPnlCents: ledger.paperBudget.realizedPnlCents,
    openEdgeStakeCents: openPaperStake,
    availableCents: ledger.paperBudget.availableCents,
    residualCents: ledger.paperBudget.availableCents - expectedPaperAvailable,
  },
  authority: 'Diagnostic only. No paper calibration, production execution, bankroll, or promotion authority.',
  primaryCaveat: 'Exact FIFO rank and cancellations ahead are private; exact pairing conditions on both lanes issuing.',
}, null, 2));
