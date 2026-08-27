#!/usr/bin/env node
/**
 * Prospective paper execution timing-shadow review.
 *
 * Measures create/acknowledgement acceptance classification and event-time final-grace replay against
 * exact prospective live pairs. Deciding corrections: queue economics are not scored here; one UTC close
 * is one independent window; missing/duplicate live identity is unavailable; no result promotes or writes.
 * Main caveat: public quotes cannot expose the venue's private acknowledgement state, and public prints
 * cannot expose cancellations or exact FIFO rank.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), process.env.MONEY_NOODLE_PAPER_EXECUTION_TIMING_PATH?.trim() || 'data');
const SNAPSHOT = path.join(DATA, 'paper-execution-timing-shadows.json');
const JOURNAL = path.join(DATA, 'paper-execution-timing-shadows.journal.jsonl');
const timestampMicros = (value) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value ?? '');
  if (!match) return undefined;
  const secondMs = Date.parse(`${match[1]}Z`);
  const result = secondMs * 1_000 + Number((match[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(result) ? result : undefined;
};

const records = new Map();
try {
  const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  for (const record of snapshot.records ?? []) records.set(record.decision.id, record);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const raw = await readFile(JOURNAL, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.op === 'decision') {
      if (!records.has(event.value.id)) records.set(event.value.id, { decision: event.value });
      continue;
    }
    const record = records.get(event.id);
    if (!record) continue;
    if (event.op === 'acceptance' && !record.acceptance) record.acceptance = event.value;
    if (event.op === 'grace' && !record.grace) record.grace = event.value;
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const ledger = await readExecutionLedger();
const byPair = new Map();
for (const order of ledger.orders ?? []) {
  const pairId = order.executionMirrorPair?.id;
  if (pairId) byPair.set(pairId, [...(byPair.get(pairId) ?? []), order]);
}
const rows = [...records.values()];
const ledgerById = new Map((ledger.orders ?? []).map((order) => [order.id, order]));
// The first decision is appended only after its owning paper intent is durable, so its order creation
// necessarily predates `recordedAt`. Anchor expected coverage on that first recorded order, not on the
// later journal write, or the denominator omits the very row that activated the cohort.
const startedAtMs = rows.length ? Math.min(...rows.map((record) =>
  Date.parse(ledgerById.get(record.decision.orderId)?.createdAt ?? record.decision.recordedAt))) : undefined;
const route = (order) => order.paperEntryRoute ?? order.entryExecutionDecision?.executedStyle
  ?? order.liquidityRole ?? 'unknown';
const expectedPaperMakers = startedAtMs === undefined ? [] : (ledger.orders ?? []).filter((order) =>
  order.executionMode === 'paper' && !order.id.includes(':exit:')
  && (order.strategyId ?? 'edge-binary-buy') === 'edge-binary-buy' && route(order) === 'maker'
  && order.executionMirrorPair?.id && Date.parse(order.createdAt) + 1e-9 >= startedAtMs);
const recordedOrderIds = new Set(rows.map((record) => record.decision.orderId));
const missingDecisions = expectedPaperMakers.filter((order) => !recordedOrderIds.has(order.id));
const expectedCount = expectedPaperMakers.length;
const knownAcceptance = [];
let missingLivePair = 0, pendingLivePair = 0, ambiguousLivePair = 0;
for (const record of rows) {
  const live = (byPair.get(record.decision.mirrorPairId) ?? []).filter((order) => order.executionMode === 'live');
  if (!live.length) { missingLivePair += 1; continue; }
  if (live.length !== 1) { ambiguousLivePair += 1; continue; }
  const target = live[0].venueOrderId ? 'accepted'
    : ['unfilled', 'rejected', 'won', 'lost', 'sold', 'invalid'].includes(live[0].status) ? 'not_accepted' : undefined;
  if (target) knownAcceptance.push({ record, live: live[0], target });
  else pendingLivePair += 1;
}

const matrix = { acceptedAccepted: 0, acceptedNotAccepted: 0, raceAccepted: 0, raceNotAccepted: 0 };
const liveNonAcceptanceReasons = {};
const nonAcceptanceReason = (order) => {
  const reason = order.reason?.toLowerCase() ?? '';
  const observationReason = (order.entryExecutionObservations ?? [])
    .map((observation) => observation.reason?.toLowerCase() ?? '').join(' ');
  if (order.noFillReason) return order.noFillReason;
  if (reason.includes('market_not_found') || reason.includes('market not found')
    || observationReason.includes('market_not_found') || observationReason.includes('market not found')) {
    return reason.includes('reconciliation found no accepted')
      ? 'market_not_found_then_reconciled_absent' : 'market_not_found';
  }
  if (reason.includes('post-only') && (reason.includes('cross') || reason.includes('acknowledgement race'))) {
    return 'post_only_race';
  }
  if (reason.includes('reconciliation found no accepted')) return 'reconciled_absent';
  return order.status;
};
for (const row of knownAcceptance) {
  const candidate = row.record.acceptance?.status;
  if (candidate === 'accepted' && row.target === 'accepted') matrix.acceptedAccepted += 1;
  if (candidate === 'accepted' && row.target === 'not_accepted') matrix.acceptedNotAccepted += 1;
  if (candidate === 'post_only_race' && row.target === 'accepted') matrix.raceAccepted += 1;
  if (candidate === 'post_only_race' && row.target === 'not_accepted') matrix.raceNotAccepted += 1;
  if (row.target === 'not_accepted') {
    const reason = nonAcceptanceReason(row.live);
    liveNonAcceptanceReasons[reason] = (liveNonAcceptanceReasons[reason] ?? 0) + 1;
  }
}
const exactMakerPairs = knownAcceptance.filter(({ record, live }) => route(live) === 'maker'
  && Number.isFinite(live.requestedQuantity ?? live.quantity)
  && Math.abs(record.decision.requestedCount - (live.requestedQuantity ?? live.quantity)) <= 1e-8);
const exactMakerPairWindows = new Set(exactMakerPairs.map(({ record }) => record.decision.closesAt));
const observedLiveCreateRaces = knownAcceptance.filter(({ live }) => nonAcceptanceReason(live) === 'post_only_race');
const acceptanceAvailable = rows.filter((record) => record.acceptance
  && record.acceptance.status !== 'unavailable');
const graceAvailable = rows.filter((record) => record.grace?.status === 'available');
const graceDifferences = graceAvailable.filter((record) => {
  const production = record.grace.production, replay = record.grace.eventTimeReplay;
  return replay && (Math.abs(production.filledCount - replay.filledCount) > 1e-8
    || Math.abs(production.purchaseCents - replay.purchaseCents) > 1e-9);
});
const sortedFinite = (values) => values.filter(Number.isFinite).sort((left, right) => left - right);
const quoteLatency = (field) => sortedFinite(acceptanceAvailable.map((record) => {
  const quote = record.acceptance[field];
  return quote ? Date.parse(quote.observedAt) - Date.parse(quote.requestedAt) : Number.NaN;
}));
const createScheduleDelay = sortedFinite(acceptanceAvailable.map((record) =>
  Date.parse(record.acceptance.createQuote?.requestedAt) - Date.parse(record.decision.recordedAt)
    - record.decision.createDelayMs));
const acknowledgementScheduleDelay = sortedFinite(acceptanceAvailable.map((record) =>
  Date.parse(record.acceptance.acknowledgementQuote?.requestedAt)
    - Date.parse(record.acceptance.createQuote?.observedAt) - record.decision.acknowledgementDelayMs));
const graceScheduleDelay = sortedFinite(graceAvailable.map((record) =>
  Date.parse(record.grace.graceReadRequestedAt) - Date.parse(record.grace.restingUntil)
    - record.decision.finalEvidenceGraceMs));
const percentile = (values, fraction) => values.length
  ? values[Math.floor((values.length - 1) * fraction)] : null;
const timingSummary = (values) => ({
  median: percentile(values, 0.5), p95: percentile(values, 0.95), maximum: percentile(values, 1),
});
const windows = new Set(rows.map((record) => record.decision.closesAt));
const postHorizonProductionEvidence = rows.flatMap((record) => {
  const restingUntil = timestampMicros(record.grace?.restingUntil);
  const order = ledgerById.get(record.decision.orderId);
  if (restingUntil === undefined || !order) return [];
  const observations = (order.entryExecutionObservations ?? []).filter((observation) => {
    const lastConsumingTradeAt = timestampMicros(observation.lastConsumingTradeAt);
    return (observation.consumingTradeCount ?? 0) > 0
      && lastConsumingTradeAt !== undefined && lastConsumingTradeAt > restingUntil;
  });
  if (!observations.length) return [];
  return [{
    orderId: order.id, closesAt: record.decision.closesAt, restingUntil: record.grace.restingUntil,
    status: order.status, filledCount: order.filledCount ?? 0, pnlCents: order.pnlCents,
    observations: observations.map((observation) => ({
      firstConsumingTradeAt: observation.firstConsumingTradeAt,
      lastConsumingTradeAt: observation.lastConsumingTradeAt,
      consumingTradeCount: observation.consumingTradeCount,
      consumingTradeQuantity: observation.consumingTradeQuantity,
      fillAdded: observation.fillAdded ?? 0,
    })),
  }];
});
const postHorizonFillRows = postHorizonProductionEvidence.filter((row) => row.filledCount > 1e-8);
const excludedOrderIds = new Set(postHorizonProductionEvidence.map((row) => row.orderId));
const eligibleRows = rows.filter((record) => !excludedOrderIds.has(record.decision.orderId));
const eligibleKnownAcceptance = knownAcceptance.filter(({ record }) => !excludedOrderIds.has(record.decision.orderId));
const eligibleExactMakerPairs = exactMakerPairs.filter(({ record }) => !excludedOrderIds.has(record.decision.orderId));
const eligibleExactMakerPairWindows = new Set(eligibleExactMakerPairs.map(({ record }) => record.decision.closesAt));
const eligibleAcceptanceAvailable = acceptanceAvailable.filter((record) => !excludedOrderIds.has(record.decision.orderId));
const eligibleGraceAvailable = graceAvailable.filter((record) => !excludedOrderIds.has(record.decision.orderId));
const eligibleGraceDifferences = graceDifferences.filter((record) => !excludedOrderIds.has(record.decision.orderId));
const eligibleObservedLiveCreateRaces = eligibleKnownAcceptance
  .filter(({ live }) => nonAcceptanceReason(live) === 'post_only_race');
const eligibleWindows = new Set(eligibleRows.map((record) => record.decision.closesAt));
const executionGenerations = Object.values(rows.reduce((groups, record) => {
  const generation = record.decision.paperExecutionVersion ?? 'unattributed';
  const group = groups[generation] ??= {
    paperExecutionVersion: generation, records: 0, eligibleRecords: 0, windows: new Set(), eligibleWindows: new Set(),
  };
  group.records += 1;
  group.windows.add(record.decision.closesAt);
  if (!excludedOrderIds.has(record.decision.orderId)) {
    group.eligibleRecords += 1;
    group.eligibleWindows.add(record.decision.closesAt);
  }
  return groups;
}, {})).map((group) => ({
  paperExecutionVersion: group.paperExecutionVersion,
  records: group.records, eligibleRecords: group.eligibleRecords,
  windows: group.windows.size, eligibleWindows: group.eligibleWindows.size,
}));
const controlCoverageReady = expectedCount > 0 && eligibleRows.length / expectedCount >= 0.95
  && eligibleAcceptanceAvailable.length / expectedCount >= 0.95
  && eligibleGraceAvailable.length / expectedCount >= 0.95;

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  version: rows[0]?.decision.version ?? 'paper-execution-timing-shadow-v1',
  cohort: {
    records: rows.length, eligibleRecords: eligibleRows.length,
    excludedPostHorizonRecords: excludedOrderIds.size,
    expectedExactPaperMakers: expectedCount, missingDecisions: missingDecisions.length,
    decisionCoverage: expectedCount ? rows.length / expectedCount : null,
    eligibleCoverage: expectedCount ? eligibleRows.length / expectedCount : null,
    independentWindows: windows.size, eligibleIndependentWindows: eligibleWindows.size,
    startedAt: rows.map((record) => record.decision.recordedAt).sort()[0] ?? null,
    latestAt: rows.map((record) => record.decision.recordedAt).sort().at(-1) ?? null,
  },
  identity: {
    knownAcceptancePairs: knownAcceptance.length,
    exactMakerPairs: exactMakerPairs.length,
    exactMakerPairWindows: exactMakerPairWindows.size,
    eligibleKnownAcceptancePairs: eligibleKnownAcceptance.length,
    eligibleExactMakerPairs: eligibleExactMakerPairs.length,
    eligibleExactMakerPairWindows: eligibleExactMakerPairWindows.size,
    routeOrQuantityExclusions: knownAcceptance.length - exactMakerPairs.length,
    missingLivePair, pendingLivePair, ambiguousLivePair,
  },
  executionGenerations,
  acceptance: {
    available: acceptanceAvailable.length,
    unavailable: rows.filter((record) => record.acceptance?.status === 'unavailable').length,
    incomplete: rows.filter((record) => !record.acceptance).length,
    coverage: expectedCount ? acceptanceAvailable.length / expectedCount : null,
    eligibleAvailable: eligibleAcceptanceAvailable.length,
    eligibleCoverage: expectedCount ? eligibleAcceptanceAvailable.length / expectedCount : null,
    matrix,
    liveNonAcceptanceReasons,
    observedLiveCreateRaces: observedLiveCreateRaces.length,
    eligibleObservedLiveCreateRaces: eligibleObservedLiveCreateRaces.length,
    acceptedRecall: matrix.acceptedAccepted + matrix.raceAccepted
      ? matrix.acceptedAccepted / (matrix.acceptedAccepted + matrix.raceAccepted) : null,
    raceRecall: matrix.acceptedNotAccepted + matrix.raceNotAccepted
      ? matrix.raceNotAccepted / (matrix.acceptedNotAccepted + matrix.raceNotAccepted) : null,
    createReadLatencyMs: timingSummary(quoteLatency('createQuote')),
    acknowledgementReadLatencyMs: timingSummary(quoteLatency('acknowledgementQuote')),
    createScheduleDelayMs: timingSummary(createScheduleDelay),
    acknowledgementScheduleDelayMs: timingSummary(acknowledgementScheduleDelay),
  },
  grace: {
    available: graceAvailable.length,
    unavailable: rows.filter((record) => record.grace?.status === 'unavailable').length,
    incomplete: rows.filter((record) => !record.grace).length,
    coverage: expectedCount ? graceAvailable.length / expectedCount : null,
    eligibleCoverage: expectedCount ? eligibleGraceAvailable.length / expectedCount : null,
    materiallyDifferent: graceDifferences.length,
    recoveredFill: graceDifferences.filter((record) => record.grace.production.filledCount <= 1e-8
      && record.grace.eventTimeReplay.filledCount > 1e-8).length,
    removedFill: graceDifferences.filter((record) => record.grace.production.filledCount > 1e-8
      && record.grace.eventTimeReplay.filledCount <= 1e-8).length,
    scheduleDelayMs: timingSummary(graceScheduleDelay),
    eligibleAvailable: eligibleGraceAvailable.length,
    eligibleMateriallyDifferent: eligibleGraceDifferences.length,
    eligibleRecoveredFill: eligibleGraceDifferences.filter((record) => record.grace.production.filledCount <= 1e-8
      && record.grace.eventTimeReplay.filledCount > 1e-8).length,
    eligibleRemovedFill: eligibleGraceDifferences.filter((record) => record.grace.production.filledCount > 1e-8
      && record.grace.eventTimeReplay.filledCount <= 1e-8).length,
  },
  executionInvariant: {
    postHorizonProductionEvidenceRows: postHorizonProductionEvidence.length,
    postHorizonProductionFillRows: postHorizonFillRows.length,
    affectedWholeCentPnlCents: postHorizonFillRows.reduce((sum, row) => sum + (row.pnlCents ?? 0), 0),
    excludedFromTimingEvidence: postHorizonProductionEvidence.length,
    exclusionRule: 'exclude any row whose ordinary control consumed a batch with last venue event time after restingUntil',
    rows: postHorizonProductionEvidence,
  },
  carryForward: {
    rule: 'retain v6 only when every consuming ordinary-control batch ends on or before restingUntil; report execution generations separately',
    eligibleRecords: eligibleRows.length,
    eligibleExactMakerPairs: eligibleExactMakerPairs.length,
    eligibleExactMakerPairWindows: eligibleExactMakerPairWindows.size,
    candidateVersionUnchanged: true,
  },
  milestones: {
    tenWindowWiringReady: eligibleWindows.size >= 10,
    hundredExactMakerWindowCountReady: eligibleExactMakerPairWindows.size >= 100,
    hundredWindowCoverageReady: eligibleExactMakerPairWindows.size >= 100 && controlCoverageReady,
    hundredWindowInvariantClear: eligibleExactMakerPairWindows.size >= 100 && controlCoverageReady,
    phaseExitCountReady: eligibleExactMakerPairWindows.size >= 300,
    phaseExitRaceReady: eligibleObservedLiveCreateRaces.length >= 30,
    phaseExitCoverageReady: controlCoverageReady,
    phaseExitAutomatedCriteriaReady: eligibleExactMakerPairWindows.size >= 300
      && eligibleObservedLiveCreateRaces.length >= 30 && controlCoverageReady,
    nonInterferenceReviewStillRequired: true,
  },
  authority: 'diagnostic only; no paper fill, bankroll, live order, or promotion authority',
}, null, 2));
