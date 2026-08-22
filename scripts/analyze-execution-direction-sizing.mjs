/**
 * Tests two mechanism-first responses to maker adverse selection and the proposed 30pp sizing emphasis.
 *
 *   npm run analyze:execution-direction-sizing
 *
 * Measures:
 * - exact realized return by issuance net-edge band;
 * - bounded proportional and reduce-only 30pp sizing over the same realized positions;
 * - pre-submit selected-side quote direction for v21 maker attempts;
 * - restrictive adverse-move cancellation and optimistic favorable-move taker counterfactuals.
 *
 * Deciding corrections: attempts and assets are averaged inside settlement windows; no-fill/refusal earns
 * zero; live and paper remain separate; sizing is scored on every settled position rather than a surviving
 * cohort. The directional taker arm assumes the refreshed ask fills and is therefore an optimistic bound,
 * not executable evidence. All candidates are retrospective and this script is read-only.
 */
import path from 'node:path';
import { readResolvedForecasts } from './lib/forecast-history.mjs';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const BUY_POLICY = 'buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21';
const EDGE_BANDS = [
  { label: '5-10pp', minimum: 0.05, maximum: 0.10 },
  { label: '10-18pp', minimum: 0.10, maximum: 0.18 },
  { label: '18-30pp', minimum: 0.18, maximum: 0.30 },
  { label: '30pp+', minimum: 0.30, maximum: Number.POSITIVE_INFINITY },
];
const DIRECTION_TICK = 0.01;

const ledger = await readExecutionLedger(DATA);
const orders = ledger.orders ?? ledger;
const forecasts = await readResolvedForecasts(DATA);
const outcomesByContract = new Map();
for (const forecast of forecasts) for (const result of Object.values(forecast.venueOutcomes ?? {})) {
  if (result?.contractId && result.outcome) outcomesByContract.set(result.contractId, result.outcome);
}

const outcomeFor = (order) => order.outcome ?? order.counterfactualHoldOutcome ?? outcomesByContract.get(order.contractId);
const stakeFor = (order) => order.actualStakeCents ?? order.stakeCents;
const pnlFor = (order) => order.actualPnlCents ?? order.pnlCents ?? 0;
const filled = (order) => (order.filledCount ?? 0) > 0;
const isMaker = (order) => order.executionMode === 'live'
  ? order.entryExecutionDecision?.executedStyle === 'maker'
  : order.liquidityRole === 'maker';

function clustered(rows, value, weight = () => 1) {
  const windows = new Map();
  for (const row of rows) windows.set(row.closesAt, [...(windows.get(row.closesAt) ?? []), row]);
  const means = [...windows.values()].flatMap((items) => {
    const denominator = items.reduce((sum, item) => sum + weight(item), 0);
    return denominator > 0 ? [items.reduce((sum, item) => sum + value(item) * weight(item), 0) / denominator] : [];
  });
  if (!means.length) return { windows: 0, mean: null, standardError: null };
  const mean = means.reduce((sum, item) => sum + item, 0) / means.length;
  const standardError = means.length > 1
    ? Math.sqrt(means.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (means.length - 1) / means.length)
    : null;
  return { windows: means.length, mean, standardError };
}

const settledEdgeOrders = orders.filter((order) => order.strategyId !== 'long-shot-round-trip'
  && !order.id.includes(':exit:') && Number.isFinite(order.entryDecision?.netEdge)
  && ['won', 'lost', 'sold'].includes(order.status) && stakeFor(order) > 0)
  .map((order) => ({
    order, closesAt: order.closesAt, mode: order.executionMode,
    edge: order.entryDecision.netEdge, stake: stakeFor(order), pnl: pnlFor(order),
    realizedReturn: pnlFor(order) / stakeFor(order),
  }));

function bandReport(mode) {
  return EDGE_BANDS.map((band) => {
    const rows = settledEdgeOrders.filter((row) => row.mode === mode && row.edge >= band.minimum && row.edge < band.maximum);
    const score = clustered(rows, (row) => row.realizedReturn);
    return {
      band: band.label, rows: rows.length, windows: score.windows,
      meanReturn: score.mean, standardError: score.standardError,
      stakeCents: rows.reduce((sum, row) => sum + row.stake, 0),
      pnlCents: rows.reduce((sum, row) => sum + row.pnl, 0),
      positivePnlRows: rows.filter((row) => row.pnl > 0).length,
    };
  });
}

const proportionalMultiplier = (edge) => Math.min(3, Math.max(0.3, edge / 0.08));
const reduceOnly30ppMultiplier = (edge) => edge >= 0.30 ? 1 : 0.3;
function sizingReport(mode) {
  const rows = settledEdgeOrders.filter((row) => row.mode === mode && row.edge >= 0.05);
  const arm = (label, multiplier) => {
    const score = clustered(rows, (row) => row.realizedReturn, (row) => multiplier(row.edge));
    const capitalUnits = rows.reduce((sum, row) => sum + multiplier(row.edge), 0);
    const profitUnits = rows.reduce((sum, row) => sum + row.realizedReturn * multiplier(row.edge), 0);
    return {
      label, rows: rows.length, windows: score.windows, capitalUnits, profitUnits,
      returnPerCapital: capitalUnits ? profitUnits / capitalUnits : null,
      clusteredMeanReturn: score.mean, clusteredStandardError: score.standardError,
    };
  };
  return [
    arm('flat-1x', () => 1),
    arm('bounded-edge-proportional-0.3x-to-3x', proportionalMultiplier),
    arm('reduce-only-0.3x-below30pp-1x-at30pp+', reduceOnly30ppMultiplier),
  ];
}

function takerFeeFraction(price) {
  return 0.07 * price * (1 - price);
}
function takerReturn(row) {
  const cost = row.freshAsk + takerFeeFraction(row.freshAsk);
  return row.outcome === row.side ? 1 / cost - 1 : -1;
}
function makerHoldReturn(order, outcome) {
  if (!filled(order)) return 0;
  const stake = stakeFor(order);
  const payout = order.potentialPayoutCents ?? order.quantity * 100;
  return outcome === order.side ? payout / stake - 1 : -1;
}
function directionOf(delta) {
  if (delta <= -DIRECTION_TICK + 1e-9) return 'adverse';
  if (delta >= DIRECTION_TICK - 1e-9) return 'favorable';
  return 'stable';
}

function directionRows(mode) {
  return orders.filter((order) => order.executionMode === mode
    && order.strategyId !== 'long-shot-round-trip' && !order.id.includes(':exit:')
    && order.entryDecision?.policyVersion === BUY_POLICY && isMaker(order) && outcomeFor(order))
    .flatMap((order) => {
      const submitted = (order.entryExecutionObservations ?? []).find((observation) =>
        observation.event === (mode === 'live' ? 'create_quote' : 'paper_submitted'));
      const issuanceAsk = order.issuanceAskPrice ?? order.entryDecision?.actionableAsk;
      if (!submitted || !Number.isFinite(submitted.selectedAsk) || !Number.isFinite(issuanceAsk)) return [];
      const outcome = outcomeFor(order);
      const selectedProbability = order.entryDecision.selectedSideProbability;
      const freshAsk = submitted.selectedAsk;
      const freshEdge = selectedProbability - freshAsk - takerFeeFraction(freshAsk);
      const firstManagement = (order.entryExecutionObservations ?? []).find((observation) => observation.event === 'management_quote');
      const cancellableAdverse = Boolean(firstManagement
        && (firstManagement.filledCount ?? 0) <= 1e-8
        && Number.isFinite(firstManagement.selectedAsk)
        && firstManagement.selectedAsk <= freshAsk - DIRECTION_TICK + 1e-9);
      return [{
        order, closesAt: order.closesAt, side: order.side, outcome,
        issuanceAsk, freshAsk, quoteDelta: freshAsk - issuanceAsk,
        direction: directionOf(freshAsk - issuanceAsk), freshEdge,
        spread: submitted.spread ?? Number.POSITIVE_INFINITY,
        medianEdge: order.entryDecision.medianNetEdge ?? order.entryDecision.netEdge,
        confidence: order.entryDecision.confidence,
        filled: filled(order), productionReturn: makerHoldReturn(order, outcome), cancellableAdverse,
      }];
    });
}

function directionCohorts(rows) {
  return ['adverse', 'stable', 'favorable'].map((direction) => {
    const cohort = rows.filter((row) => row.direction === direction);
    const fills = cohort.filter((row) => row.filled);
    const score = clustered(cohort, (row) => row.productionReturn);
    return {
      direction, attempts: cohort.length, windows: score.windows, fills: fills.length,
      fillRate: cohort.length ? fills.length / cohort.length : null,
      eventualWins: cohort.filter((row) => row.outcome === row.side).length,
      filledEventualWins: fills.filter((row) => row.outcome === row.side).length,
      productionMeanAcrossAttempts: score.mean, productionStandardError: score.standardError,
    };
  });
}

function directionArm(rows, label, minimumFreshEdge) {
  const values = rows.map((row) => {
    const refuse = row.direction === 'adverse';
    const take = row.direction === 'favorable' && row.freshEdge + 1e-12 >= minimumFreshEdge
      && row.medianEdge + 1e-12 >= 0.10 && row.confidence + 1e-12 >= 0.65
      && row.spread <= 0.02 + 1e-12;
    const candidateReturn = refuse ? 0 : take ? takerReturn(row) : row.productionReturn;
    return { ...row, refuse, take, candidateReturn };
  });
  const score = clustered(values, (row) => row.candidateReturn);
  const difference = clustered(values, (row) => row.candidateReturn - row.productionReturn);
  const refusedFills = values.filter((row) => row.refuse && row.filled);
  return {
    label, attempts: values.length, windows: score.windows,
    preSubmitRefusals: values.filter((row) => row.refuse).length,
    optimisticTakerConversions: values.filter((row) => row.take).length,
    refusedFilledWinners: refusedFills.filter((row) => row.outcome === row.side).length,
    refusedFilledLosers: refusedFills.filter((row) => row.outcome !== row.side).length,
    meanReturnAcrossAttempts: score.mean,
    incrementalMeanReturn: difference.mean,
    incrementalStandardError: difference.standardError,
  };
}

function earlyCancelArm(rows) {
  const values = rows.map((row) => ({ ...row, candidateReturn: row.cancellableAdverse ? 0 : row.productionReturn }));
  const score = clustered(values, (row) => row.candidateReturn);
  const difference = clustered(values, (row) => row.candidateReturn - row.productionReturn);
  const removed = values.filter((row) => row.cancellableAdverse && row.filled);
  return {
    label: 'cancel-after-first-unfilled-1c-adverse-check', attempts: values.length, windows: score.windows,
    cancellations: values.filter((row) => row.cancellableAdverse).length,
    laterFilledWinnersRemoved: removed.filter((row) => row.outcome === row.side).length,
    laterFilledLosersRemoved: removed.filter((row) => row.outcome !== row.side).length,
    meanReturnAcrossAttempts: score.mean,
    incrementalMeanReturn: difference.mean,
    incrementalStandardError: difference.standardError,
  };
}

const direction = Object.fromEntries(['live', 'paper'].map((mode) => {
  const rows = directionRows(mode);
  const production = clustered(rows, (row) => row.productionReturn);
  return [mode, {
    attempts: rows.length,
    production: { ...production },
    cohorts: directionCohorts(rows),
    candidates: [directionArm(rows, 'directional-fresh-edge15pp', 0.15), directionArm(rows, 'directional-fresh-edge30pp', 0.30), earlyCancelArm(rows)],
  }];
}));

const highEdgeConcentration = Object.fromEntries(['live', 'paper'].map((mode) => {
  const rows = settledEdgeOrders.filter((row) => row.mode === mode && row.edge >= 0.30);
  const positives = [...rows].filter((row) => row.pnl > 0).sort((left, right) => right.pnl - left.pnl);
  const totalPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  return [mode, {
    rows: rows.length, windows: new Set(rows.map((row) => row.closesAt)).size,
    positiveRows: positives.length, totalPnlCents: totalPnl,
    topThreePositivePnlCents: positives.slice(0, 3).reduce((sum, row) => sum + row.pnl, 0),
    days: new Set(rows.map((row) => row.order.createdAt.slice(0, 10))).size,
  }];
}));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), inputs: { orders: orders.length, resolvedForecasts: forecasts.length },
  edgeBands: { live: bandReport('live'), paper: bandReport('paper') },
  highEdgeConcentration,
  sizing: { live: sizingReport('live'), paper: sizingReport('paper') },
  preSubmitDirection: direction,
}, null, 2));
