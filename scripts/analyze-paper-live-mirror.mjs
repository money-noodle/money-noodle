#!/usr/bin/env node
/**
 * Measures whether the current paper execution simulator reproduces contemporaneous live execution.
 *
 * Deciding correction:
 * - one attempt is one exact `(symbol, side, closesAt, episode)` identity, paired one-to-one;
 * - the primary cohort starts within one second in both lanes, so serial live drain latency is not
 *   mistaken for fill-model error;
 * - fill-rate differences are averaged within settlement windows before their standard error is taken.
 *
 * Biases:
 * - pairing conditions on both lanes issuing, excluding paper-only operation while live was paused or
 *   operationally blocked;
 * - public depth and prints cannot reveal cancellations ahead or private FIFO rank;
 * - the cohort is current paper v4 only, but its paired live rows span the compatible v5 generation;
 * - exit comparisons are tiny and conditional on both tracks owning the same position and deciding to exit;
 * - read-only over data/paper-orders.json; writes nothing and places no order.
 *
 * Reproduce: npm run analyze:paper-live-mirror
 */
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const PAPER_VERSION = 'paper-managed-execution-route-ioc-v4';
const PAPER_EXIT_VERSION = 'paper-ioc-exit-depth-v1';
const EDGE = 'edge-binary-buy';

const ledger = await readExecutionLedger(DATA);
const entries = (ledger.orders ?? []).filter((order) => !order.id.includes(':exit:')
  && (order.strategyId ?? EDGE) === EDGE);
const paper = entries.filter((order) => order.executionMode === 'paper'
  && order.entryDecision?.executionPolicyVersion === PAPER_VERSION);
const live = entries.filter((order) => order.executionMode === 'live');
const filled = (order) => (order.filledCount ?? 0) > 1e-8;
const episode = (order) => order.entryEpisode ?? order.attemptNumber ?? 1;
const route = (order) => order.entryExecutionDecision?.executedStyle
  ?? order.paperEntryRoute ?? order.liquidityRole ?? 'unknown';
const key = (order) => `${order.symbol}|${order.side}|${order.closesAt}|${episode(order)}`;
const quantity = (order) => order.requestedQuantity ?? order.quantity;

function pairWithin(maximumDeltaMs) {
  const unused = new Set(live.map((_, index) => index));
  const pairs = [];
  for (const paperOrder of [...paper].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    let best;
    for (const index of unused) {
      const liveOrder = live[index];
      if (key(liveOrder) !== key(paperOrder)) continue;
      const deltaMs = Math.abs(Date.parse(liveOrder.createdAt) - Date.parse(paperOrder.createdAt));
      if (deltaMs > maximumDeltaMs || (best && deltaMs >= best.deltaMs)) continue;
      best = { index, deltaMs, paper: paperOrder, live: liveOrder };
    }
    if (best) {
      unused.delete(best.index);
      pairs.push(best);
    }
  }
  return pairs;
}

function cells(pairs) {
  const result = { bothFilled: 0, paperOnly: 0, liveOnly: 0, neitherFilled: 0 };
  for (const pair of pairs) {
    const paperFilled = filled(pair.paper), liveFilled = filled(pair.live);
    if (paperFilled && liveFilled) result.bothFilled += 1;
    else if (paperFilled) result.paperOnly += 1;
    else if (liveFilled) result.liveOnly += 1;
    else result.neitherFilled += 1;
  }
  return result;
}

function clusteredFillDelta(pairs) {
  const byWindow = new Map();
  for (const pair of pairs) {
    const value = Number(filled(pair.paper)) - Number(filled(pair.live));
    byWindow.set(pair.paper.closesAt, [...(byWindow.get(pair.paper.closesAt) ?? []), value]);
  }
  const values = [...byWindow.values()].map((items) => items.reduce((sum, value) => sum + value, 0) / items.length);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const standardError = mean !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { windows: values.length, mean, standardError };
}

function durationSummary(orders) {
  const values = orders.flatMap((order) => {
    const value = order.entryExecutionObservations?.find((observation) => Number.isFinite(observation.restingDurationMs))?.restingDurationMs;
    return Number.isFinite(value) ? [value] : [];
  }).sort((a, b) => a - b);
  const percentile = (p) => values.length ? values[Math.floor((values.length - 1) * p)] : null;
  return {
    observations: values.length, medianMs: percentile(0.5), p90Ms: percentile(0.9),
    maximumMs: percentile(1), over30Seconds: values.filter((value) => value > 30_000).length,
  };
}

function percent(value) {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}
function line(label, value) { console.log(`${label.padEnd(48)} ${value}`); }

const primary = pairWithin(1_000);
const sensitivity = pairWithin(60_000);
const primaryCells = cells(primary);
const accepted = primary.filter((pair) => Boolean(pair.live.venueOrderId) && route(pair.live) === 'maker');
const acceptedCells = cells(accepted);
const clustered = clusteredFillDelta(primary);
const sameRoute = primary.filter((pair) => route(pair.paper) === route(pair.live)).length;
const sameQuantity = primary.filter((pair) => Math.abs(quantity(pair.paper) - quantity(pair.live)) <= 1e-8).length;
const both = primary.filter((pair) => filled(pair.paper) && filled(pair.live));
const meanPriceDeltaCents = both.length
  ? both.reduce((sum, pair) => sum + 100 * (pair.paper.authoritativeFillPrice - pair.live.authoritativeFillPrice), 0) / both.length
  : null;
const sameFilledQuantity = both.filter((pair) => Math.abs(pair.paper.filledCount - pair.live.filledCount) <= 1e-8).length;

console.log(`# Paper/live execution mirror — ${new Date().toISOString()}`);
line('ledger rows', ledger.orders.length);
line('paper execution generation', PAPER_VERSION);
line('paper cohort', `${paper.length} attempts / ${new Set(paper.map((order) => order.closesAt)).size} settlement windows`);
line('paper cohort range', paper.length ? `${paper[0].createdAt} .. ${paper.at(-1).createdAt}` : '—');
line('paper fills', `${paper.filter(filled).length}/${paper.length} (${percent(paper.length ? paper.filter(filled).length / paper.length : null)})`);

console.log('\n## Same-start paired entries (primary: <=1 second)');
line('paired attempts', `${primary.length} / ${new Set(primary.map((pair) => pair.paper.closesAt)).size} settlement windows`);
line('same route decision', `${sameRoute}/${primary.length} (${percent(primary.length ? sameRoute / primary.length : null)})`);
line('same requested quantity', `${sameQuantity}/${primary.length} (${percent(primary.length ? sameQuantity / primary.length : null)})`);
line('both / paper-only / live-only / neither', `${primaryCells.bothFilled} / ${primaryCells.paperOnly} / ${primaryCells.liveOnly} / ${primaryCells.neitherFilled}`);
line('fill/no-fill agreement', percent(primary.length ? (primaryCells.bothFilled + primaryCells.neitherFilled) / primary.length : null));
line('paper fill rate', percent(primary.length ? (primaryCells.bothFilled + primaryCells.paperOnly) / primary.length : null));
line('live fill rate', percent(primary.length ? (primaryCells.bothFilled + primaryCells.liveOnly) / primary.length : null));
line('clustered paper-minus-live fill rate', clustered.mean === null ? '—'
  : `${percent(clustered.mean)} ±${percent((clustered.standardError ?? 0) * 1.96)} over ${clustered.windows} windows (95% normal interval)`);
line('both-filled mean paper-minus-live price', meanPriceDeltaCents === null ? '—' : `${meanPriceDeltaCents.toFixed(3)}¢ over ${both.length} attempts`);
line('both-filled same acquired quantity', `${sameFilledQuantity}/${both.length} (${percent(both.length ? sameFilledQuantity / both.length : null)})`);

console.log('\n## Conditional on a venue-accepted live maker');
line('accepted paired attempts', accepted.length);
line('both / paper-only / live-only / neither', `${acceptedCells.bothFilled} / ${acceptedCells.paperOnly} / ${acceptedCells.liveOnly} / ${acceptedCells.neitherFilled}`);
line('agreement', percent(accepted.length ? (acceptedCells.bothFilled + acceptedCells.neitherFilled) / accepted.length : null));
line('paper capture of live fills', percent((acceptedCells.bothFilled + acceptedCells.liveOnly)
  ? acceptedCells.bothFilled / (acceptedCells.bothFilled + acceptedCells.liveOnly) : null));
line('paper-positive precision', percent((acceptedCells.bothFilled + acceptedCells.paperOnly)
  ? acceptedCells.bothFilled / (acceptedCells.bothFilled + acceptedCells.paperOnly) : null));

console.log('\n## Pairing sensitivity and manager duration');
const sensitivityCells = cells(sensitivity);
line('<=60-second pairs', `${sensitivity.length}; ${sensitivityCells.bothFilled}/${sensitivityCells.paperOnly}/${sensitivityCells.liveOnly}/${sensitivityCells.neitherFilled}; agreement ${percent(sensitivity.length ? (sensitivityCells.bothFilled + sensitivityCells.neitherFilled) / sensitivity.length : null)}`);
line('paper maker duration', JSON.stringify(durationSummary(paper.filter((order) => route(order) === 'maker'))));
line('paired live maker duration', JSON.stringify(durationSummary(primary.map((pair) => pair.live).filter((order) => route(order) === 'maker'))));

console.log('\n## Requalifying episodes in the paper-v4 period');
const startMs = paper.length ? Math.min(...paper.map((order) => Date.parse(order.createdAt))) : Number.POSITIVE_INFINITY;
for (const mode of ['paper', 'live']) {
  const cohort = entries.filter((order) => order.executionMode === mode && Date.parse(order.createdAt) >= startMs);
  for (const number of [1, 2, 3]) {
    const attempts = cohort.filter((order) => episode(order) === number);
    line(`${mode} episode ${number}`, `${attempts.length} attempts, ${attempts.filter(filled).length} fills`);
  }
}

console.log('\n## Current exit-depth cohort');
const paperExits = paper.filter((order) => order.paperExitFillVersion === PAPER_EXIT_VERSION && order.standaloneExitAttemptedAt);
const liveExits = entries.filter((order) => order.executionMode === 'live' && Date.parse(order.createdAt) >= startMs && order.standaloneExitAttemptedAt);
line('paper exit completion', `${paperExits.filter((order) => order.status === 'sold').length}/${paperExits.length} (${percent(paperExits.length ? paperExits.filter((order) => order.status === 'sold').length / paperExits.length : null)})`);
line('live exit completion', `${liveExits.filter((order) => order.status === 'sold').length}/${liveExits.length} (${percent(liveExits.length ? liveExits.filter((order) => order.status === 'sold').length / liveExits.length : null)})`);
const samePositionExits = paperExits.flatMap((paperOrder) => {
  const candidates = liveExits.filter((liveOrder) => liveOrder.symbol === paperOrder.symbol && liveOrder.side === paperOrder.side
    && liveOrder.closesAt === paperOrder.closesAt);
  const liveOrder = candidates.sort((a, b) => Math.abs(Date.parse(a.standaloneExitAttemptedAt) - Date.parse(paperOrder.standaloneExitAttemptedAt))
    - Math.abs(Date.parse(b.standaloneExitAttemptedAt) - Date.parse(paperOrder.standaloneExitAttemptedAt)))[0];
  if (!liveOrder) return [];
  const deltaMs = Math.abs(Date.parse(liveOrder.standaloneExitAttemptedAt) - Date.parse(paperOrder.standaloneExitAttemptedAt));
  return deltaMs <= 1_000 ? [{ paper: paperOrder, live: liveOrder }] : [];
});
const exitAgreement = samePositionExits.filter((pair) => (pair.paper.status === 'sold') === (pair.live.status === 'sold')).length;
line('same-position same-second exit agreement', `${exitAgreement}/${samePositionExits.length} (${percent(samePositionExits.length ? exitAgreement / samePositionExits.length : null)})`);

console.log('\n## Paper edge-bankroll control');
const openEdgeStake = entries.filter((order) => order.executionMode === 'paper'
  && ['open', 'pending_reservation', 'uncertain'].includes(order.status))
  .reduce((sum, order) => sum + order.stakeCents, 0);
const expectedAvailable = ledger.paperBudget.startingCents + ledger.paperBudget.realizedPnlCents - openEdgeStake;
line('starting / realized / open / available', `${ledger.paperBudget.startingCents} / ${ledger.paperBudget.realizedPnlCents} / ${openEdgeStake} / ${ledger.paperBudget.availableCents} cents`);
line('available residual', `${ledger.paperBudget.availableCents - expectedAvailable}¢`);

console.log('\nPrimary caveat: exact FIFO rank and cancellations ahead are private. This paired cohort also excludes every situation in which live did not issue an order.');
