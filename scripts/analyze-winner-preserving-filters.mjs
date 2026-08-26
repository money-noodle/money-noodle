/**
 * Tests whether the two pre-registered maker restrictions can avoid losing fills without excluding
 * production winners.
 *
 *   npm run analyze:winner-preserving-filters
 *
 * Deciding correction: every issued maker attempt is scored, with no-fill/refused attempts worth zero,
 * and returns are averaged inside settlement windows before uncertainty is estimated. Reporting only
 * filled ROI would condition on the outcome the restriction is intended to change. Live and paper stay
 * separate because they act on the same signals and are not independent confirmation.
 *
 * Biases: the all-v21 view is retrospective even though the 2c/2pp thresholds were declared elsewhere;
 * only the sentinel-boundary view is prospective. The prospective cohort is locked below 60 resolved
 * windows and 20 differing windows. This script is read-only and cannot place or influence an order.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readResolvedForecasts } from './lib/forecast-history.mjs';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const BUY_POLICY = 'buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21';
const EXECUTION_POLICIES = {
  live: 'maker-high30-one-attempt-fresh1c-v4',
  paper: 'paper-managed-maker-trade-queue-v2',
};
const CANDIDATES = [
  { id: 'maker-spread-max2c-v1', admits: (row) => row.spread <= 0.02 + 1e-9 },
  { id: 'maker-spike-max2pp-v1', admits: (row) => Number.isFinite(row.edgeSpike) && row.edgeSpike + 1e-12 < 0.02 },
];

const ledger = await readExecutionLedger(DATA);
const orders = ledger.orders ?? ledger;
const forecasts = await readResolvedForecasts(DATA);
const outcomesByContract = new Map();
for (const forecast of forecasts) {
  for (const venueOutcome of Object.values(forecast.venueOutcomes ?? {})) {
    if (venueOutcome?.contractId && venueOutcome.outcome) outcomesByContract.set(venueOutcome.contractId, venueOutcome.outcome);
  }
}

const outcomeFor = (order) => order.outcome ?? order.counterfactualHoldOutcome ?? outcomesByContract.get(order.contractId);
const stakeFor = (order) => order.actualStakeCents ?? order.stakeCents;
const pnlFor = (order) => order.actualPnlCents ?? order.pnlCents ?? 0;
const isFilled = (order) => (order.filledCount ?? 0) > 0;
const isMaker = (order) => order.executionMode === 'live'
  ? order.entryExecutionDecision?.executedStyle === 'maker'
  : order.liquidityRole === 'maker';
const edgeSpike = (order) => {
  const edge = order.entryDecision?.netEdge;
  const median = order.entryDecision?.medianNetEdge;
  return Number.isFinite(edge) ? edge - (Number.isFinite(median) ? median : edge) : Number.NaN;
};

function cluster(rows, value) {
  const windows = new Map();
  for (const row of rows) windows.set(row.closesAt, [...(windows.get(row.closesAt) ?? []), value(row)]);
  const means = [...windows.values()].map((values) => values.reduce((sum, item) => sum + item, 0) / values.length);
  if (!means.length) return { windows: 0, mean: null, standardError: null };
  const mean = means.reduce((sum, item) => sum + item, 0) / means.length;
  const standardError = means.length > 1
    ? Math.sqrt(means.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (means.length - 1) / means.length)
    : null;
  return { windows: means.length, mean, standardError };
}

function summarize(rows, candidate) {
  const values = rows.map((row) => {
    const admitted = candidate?.admits(row) ?? true;
    const productionReturn = row.filled ? row.pnl / row.stake : 0;
    return { ...row, admitted, productionReturn, candidateReturn: admitted ? productionReturn : 0 };
  });
  const refused = values.filter((row) => !row.admitted);
  const refusedFills = refused.filter((row) => row.filled);
  const candidateReturn = cluster(values, (row) => row.candidateReturn);
  const incremental = cluster(values, (row) => row.candidateReturn - row.productionReturn);
  const deployed = values.filter((row) => row.admitted && row.filled);
  return {
    attempts: values.length,
    windows: candidateReturn.windows,
    refusedAttempts: refused.length,
    refusedFills: refusedFills.length,
    refusedWinningFills: refusedFills.filter((row) => row.outcome === row.side).length,
    refusedLosingFills: refusedFills.filter((row) => row.outcome !== row.side).length,
    refusedPositivePnlFills: refusedFills.filter((row) => row.pnl > 0).length,
    refusedNegativePnlFills: refusedFills.filter((row) => row.pnl < 0).length,
    filledAttempts: deployed.length,
    deployedCents: deployed.reduce((sum, row) => sum + row.stake, 0),
    pnlCents: deployed.reduce((sum, row) => sum + row.pnl, 0),
    meanReturnAcrossAttempts: candidateReturn.mean,
    incrementalMeanReturn: incremental.mean,
    incrementalStandardError: incremental.standardError,
  };
}

const resolvedV21 = (mode) => orders.filter((order) =>
  order.executionMode === mode
  && order.strategyId === 'edge-binary-buy'
  && !order.id.includes(':exit:')
  && order.entryDecision?.policyVersion === BUY_POLICY
  && isMaker(order)
  && outcomeFor(order),
).map((order) => ({
  orderId: order.id,
  closesAt: order.closesAt,
  side: order.side,
  outcome: outcomeFor(order),
  spread: order.issuanceSpread ?? order.entryDecision.spread,
  edgeSpike: edgeSpike(order),
  filled: isFilled(order),
  stake: stakeFor(order),
  pnl: pnlFor(order),
})).filter((row) => Number.isFinite(row.spread) && Number.isFinite(row.stake) && row.stake > 0);

function replayMakerSentinels(snapshot, events) {
  const byId = new Map((snapshot.sentinels ?? []).map((sentinel) => [sentinel.id, sentinel]));
  for (const event of events) {
    if (!event.value?.id) continue;
    if (event.op === 'decision') {
      if (!byId.has(event.value.id)) byId.set(event.value.id, event.value);
    } else if (event.op === 'resolution') {
      const existing = byId.get(event.value.id);
      if (existing && !existing.resolvedAt) byId.set(existing.id, {
        ...existing, outcome: event.value.outcome, resolvedAt: event.value.resolvedAt,
        invalidReason: event.value.invalidReason,
      });
    }
  }
  return [...byId.values()];
}

const makerSnapshot = JSON.parse(await readFile(path.join(DATA, 'maker-restriction-sentinels.json'), 'utf8'));
const makerJournal = (await readFile(path.join(DATA, 'maker-restriction-sentinels.journal.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
const sentinels = replayMakerSentinels(makerSnapshot, makerJournal);
const ordersById = new Map(orders.map((order) => [order.id, order]));
const prospective = (mode) => sentinels.filter((sentinel) =>
  sentinel.executionMode === mode
  && sentinel.buyPolicyVersion === BUY_POLICY
  && sentinel.executionPolicyVersion === EXECUTION_POLICIES[mode]
  && sentinel.resolvedAt && !sentinel.invalidReason,
).flatMap((sentinel) => {
  const order = ordersById.get(sentinel.orderId);
  if (!order) return [];
  return [{
    orderId: order.id,
    closesAt: sentinel.closesAt,
    side: sentinel.side,
    outcome: sentinel.outcome,
    spread: sentinel.spread,
    edgeSpike: sentinel.edgeSpike,
    filled: isFilled(order),
    stake: stakeFor(order),
    pnl: pnlFor(order),
  }];
});

const output = {
  generatedAt: new Date().toISOString(),
  inputs: { orders: orders.length, resolvedForecasts: forecasts.length },
  policy: BUY_POLICY,
  retrospectiveV21: Object.fromEntries(['live', 'paper'].map((mode) => {
    const rows = resolvedV21(mode);
    return [mode, {
      production: summarize(rows),
      candidates: Object.fromEntries(CANDIDATES.map((candidate) => [candidate.id, summarize(rows, candidate)])),
    }];
  })),
  prospective: {
    startedAt: makerSnapshot.startedAt,
    reviewRequirements: { resolvedWindows: 60, differingWindows: 20 },
    tracks: Object.fromEntries(['live', 'paper'].map((mode) => {
      const scoped = sentinels.filter((sentinel) => sentinel.executionMode === mode
        && sentinel.buyPolicyVersion === BUY_POLICY
        && sentinel.executionPolicyVersion === EXECUTION_POLICIES[mode]);
      const rows = prospective(mode);
      return [mode, {
        records: scoped.length,
        resolvedRecords: rows.length,
        unresolvedOrUnscorableRecords: scoped.length - rows.length,
        production: summarize(rows),
        candidates: Object.fromEntries(CANDIDATES.map((candidate) => [candidate.id, summarize(rows, candidate)])),
      }];
    })),
  },
};

console.log(JSON.stringify(output, null, 2));
