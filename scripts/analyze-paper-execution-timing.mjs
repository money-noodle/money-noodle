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
const startedAtMs = rows.length ? Math.min(...rows.map((record) => Date.parse(record.decision.recordedAt))) : undefined;
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
let missingLivePair = 0, ambiguousLivePair = 0;
for (const record of rows) {
  const live = (byPair.get(record.decision.mirrorPairId) ?? []).filter((order) => order.executionMode === 'live');
  if (!live.length) { missingLivePair += 1; continue; }
  if (live.length !== 1) { ambiguousLivePair += 1; continue; }
  const target = live[0].venueOrderId ? 'accepted'
    : ['unfilled', 'rejected', 'won', 'lost', 'sold', 'invalid'].includes(live[0].status) ? 'not_accepted' : undefined;
  if (target) knownAcceptance.push({ record, live: live[0], target });
}

const matrix = { acceptedAccepted: 0, acceptedNotAccepted: 0, raceAccepted: 0, raceNotAccepted: 0 };
for (const row of knownAcceptance) {
  const candidate = row.record.acceptance?.status;
  if (candidate === 'accepted' && row.target === 'accepted') matrix.acceptedAccepted += 1;
  if (candidate === 'accepted' && row.target === 'not_accepted') matrix.acceptedNotAccepted += 1;
  if (candidate === 'post_only_race' && row.target === 'accepted') matrix.raceAccepted += 1;
  if (candidate === 'post_only_race' && row.target === 'not_accepted') matrix.raceNotAccepted += 1;
}
const acceptanceAvailable = rows.filter((record) => record.acceptance
  && record.acceptance.status !== 'unavailable');
const graceAvailable = rows.filter((record) => record.grace?.status === 'available');
const graceDifferences = graceAvailable.filter((record) => {
  const production = record.grace.production, replay = record.grace.eventTimeReplay;
  return replay && (Math.abs(production.filledCount - replay.filledCount) > 1e-8
    || Math.abs(production.purchaseCents - replay.purchaseCents) > 1e-9);
});
const timing = (field) => acceptanceAvailable.flatMap((record) => {
  const quote = record.acceptance[field];
  if (!quote) return [];
  const value = Date.parse(quote.observedAt) - Date.parse(quote.requestedAt);
  return Number.isFinite(value) ? [value] : [];
}).sort((left, right) => left - right);
const percentile = (values, fraction) => values.length
  ? values[Math.floor((values.length - 1) * fraction)] : null;
const windows = new Set(rows.map((record) => record.decision.closesAt));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  version: rows[0]?.decision.version ?? 'paper-execution-timing-shadow-v1',
  cohort: {
    records: rows.length, expectedExactPaperMakers: expectedCount, missingDecisions: missingDecisions.length,
    decisionCoverage: expectedCount ? rows.length / expectedCount : null,
    independentWindows: windows.size,
    startedAt: rows.map((record) => record.decision.recordedAt).sort()[0] ?? null,
    latestAt: rows.map((record) => record.decision.recordedAt).sort().at(-1) ?? null,
  },
  identity: { knownAcceptancePairs: knownAcceptance.length, missingLivePair, ambiguousLivePair },
  acceptance: {
    available: acceptanceAvailable.length,
    unavailable: rows.filter((record) => record.acceptance?.status === 'unavailable').length,
    incomplete: rows.filter((record) => !record.acceptance).length,
    coverage: expectedCount ? acceptanceAvailable.length / expectedCount : null,
    matrix,
    acceptedRecall: matrix.acceptedAccepted + matrix.raceAccepted
      ? matrix.acceptedAccepted / (matrix.acceptedAccepted + matrix.raceAccepted) : null,
    raceRecall: matrix.acceptedNotAccepted + matrix.raceNotAccepted
      ? matrix.raceNotAccepted / (matrix.acceptedNotAccepted + matrix.raceNotAccepted) : null,
    createReadLatencyMs: { median: percentile(timing('createQuote'), 0.5), p95: percentile(timing('createQuote'), 0.95) },
    acknowledgementReadLatencyMs: { median: percentile(timing('acknowledgementQuote'), 0.5), p95: percentile(timing('acknowledgementQuote'), 0.95) },
  },
  grace: {
    available: graceAvailable.length,
    unavailable: rows.filter((record) => record.grace?.status === 'unavailable').length,
    incomplete: rows.filter((record) => !record.grace).length,
    coverage: expectedCount ? graceAvailable.length / expectedCount : null,
    materiallyDifferent: graceDifferences.length,
    recoveredFill: graceDifferences.filter((record) => record.grace.production.filledCount <= 1e-8
      && record.grace.eventTimeReplay.filledCount > 1e-8).length,
    removedFill: graceDifferences.filter((record) => record.grace.production.filledCount > 1e-8
      && record.grace.eventTimeReplay.filledCount <= 1e-8).length,
  },
  milestones: {
    tenWindowWiringReady: windows.size >= 10,
    hundredWindowCoverageReady: windows.size >= 100 && expectedCount > 0
      && rows.length / expectedCount >= 0.95 && acceptanceAvailable.length / expectedCount >= 0.95
      && graceAvailable.length / expectedCount >= 0.95,
    phaseExitCountReady: windows.size >= 300,
  },
  authority: 'diagnostic only; no paper fill, bankroll, live order, or promotion authority',
}, null, 2));
