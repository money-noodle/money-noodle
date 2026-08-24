/**
 * Last-24-hour live opportunity review with prior-day, 72-hour, and active-v22 comparisons.
 *
 * Measure: separate model/admission value, live window selection, maker fill selection, realized execution,
 * and strict-exit value. Tightening arms run first-to-fire independently and score every production position,
 * assigning zero to omitted positions; no capital reuse is invented.
 *
 * Deciding correction: all means and standard errors cluster positions inside the settlement window. Live and
 * paper are never pooled. Exact live P&L comes only from the order ledger; unsigned ask/post replays are labelled
 * optimistic. Candidate tuning is retrospective screening across twelve related arms and cannot promote policy.
 *
 * Biggest biases: a displayed ask/post does not prove an IOC/maker fill; recorded forecast history is complete
 * for production-qualified rows but cannot support admission relaxations; live activity/portfolio selection is
 * observational; and the most recent 24 hours contain only about 96 independent quarter-hour settlement windows.
 *
 * Read-only: reloads durable forecasts/orders, writes no data, and calls no order endpoint.
 * Run: npm run analyze:live-opportunities -- [optional end ISO]
 */
import { ENTRY_EXECUTION_POLICY_VERSION } from '../lib/entry-execution-policy';
import { getForecastHistory } from '../lib/forecast-tracker';
import { getExecutionOrders } from '../lib/paper-execution';
import { BUY_POLICY_VERSION } from '../lib/prediction-policy';
import { EDGE_BINARY_BUY, normalizeStrategyId } from '../lib/strategy-registry';
import type { PaperOrder, PositionSide, TrackedForecast } from '../lib/types';
import { venueFeeCents } from '../lib/venue-fill';

const V22_ACTIVATED_AT = Date.parse('2026-08-20T04:50:15.000Z');
const HOUR_MS = 3_600_000;
const EPSILON = 1e-9;

type CandidateRow = {
  key: string;
  symbol: string;
  closesAt: string;
  issuedAt: string;
  side: PositionSide;
  outcome: PositionSide;
  price: number;
  feeRate: number;
  probability: number;
  confidence: number;
  netEdge: number;
};

type Arm = {
  id: string;
  minimumEdge?: number;
  minimumPrice?: number;
  maximumPrice?: number;
  minimumConfidence?: number;
  minimumProbability?: number;
};

const arms: Arm[] = [
  { id: 'production-v22' },
  { id: 'edge-min8pp', minimumEdge: 0.08 },
  { id: 'edge-min10pp', minimumEdge: 0.10 },
  { id: 'edge-min15pp', minimumEdge: 0.15 },
  { id: 'price-min20c', minimumPrice: 0.20 },
  { id: 'price-min30c', minimumPrice: 0.30 },
  { id: 'price-max65c', maximumPrice: 0.65 },
  { id: 'price-max55c', maximumPrice: 0.55 },
  { id: 'confidence-min60', minimumConfidence: 0.60 },
  { id: 'confidence-min70', minimumConfidence: 0.70 },
  { id: 'probability-min60', minimumProbability: 0.60 },
  { id: 'edge10pp-and-price-max65c', minimumEdge: 0.10, maximumPrice: 0.65 },
  { id: 'edge15pp-and-confidence60', minimumEdge: 0.15, minimumConfidence: 0.60 },
];

const normalizedClose = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
};
const orderKey = (order: PaperOrder) => `${order.symbol}|${normalizedClose(order.closesAt)}|${order.side}`;
const candidateKey = (row: Pick<CandidateRow, 'symbol' | 'closesAt' | 'side'>) => `${row.symbol}|${normalizedClose(row.closesAt)}|${row.side}`;
const orderCost = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents;
const orderPnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const opposite = (side: PositionSide): PositionSide => side === 'UP' ? 'DOWN' : 'UP';

function cluster<T>(rows: T[], closesAt: (row: T) => string, value: (row: T) => number) {
  const groups = new Map<string, number[]>();
  for (const row of rows) groups.set(closesAt(row), [...(groups.get(closesAt(row)) ?? []), value(row)]);
  const values = [...groups.values()].map((items) => items.reduce((sum, item) => sum + item, 0) / items.length);
  const mean = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : null;
  const standardError = mean !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { rows: rows.length, windows: values.length, mean, standardError };
}

function returnAtAsk(row: CandidateRow): number {
  const cost = row.price + row.feeRate;
  return row.outcome === row.side ? (1 - cost) / cost : -1;
}

function forecastCandidate(row: TrackedForecast): CandidateRow | null {
  if (row.policyVersion !== BUY_POLICY_VERSION || row.qualified === false || row.status !== 'resolved'
    || !row.entrySide || !row.outcome || !Number.isFinite(Date.parse(row.issuedAt))
    || !Number.isFinite(Date.parse(row.closesAt))) return null;
  const option = row.actionableVenuePrices?.find((item) => item.venue === 'kalshi' && item.side === row.entrySide);
  const price = option?.price ?? (row.entryVenue === 'kalshi' ? row.entryAsk : undefined);
  const outcome = row.venueOutcomes?.kalshi?.outcome
    ?? (row.evaluationVenue === 'kalshi' ? row.outcome : undefined);
  if (!(price && price >= 0.10 && price <= 0.75) || (outcome !== 'UP' && outcome !== 'DOWN')) return null;
  const probability = row.entrySide === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
  const feeRate = 0.07 * price * (1 - price);
  const netEdge = probability - price - feeRate;
  if (probability < 0.55 || row.confidence < 0.50 || netEdge + 1e-12 < 0.05 || netEdge >= 1) return null;
  return {
    key: `${row.symbol}|${normalizedClose(row.closesAt)}|${row.entrySide}`,
    symbol: row.symbol, closesAt: normalizedClose(row.closesAt), issuedAt: row.issuedAt,
    side: row.entrySide, outcome, price, feeRate, probability, confidence: row.confidence, netEdge,
  };
}

function admitted(row: CandidateRow, arm: Arm): boolean {
  return row.netEdge + 1e-12 >= (arm.minimumEdge ?? 0.05)
    && row.price + 1e-12 >= (arm.minimumPrice ?? 0.10)
    && row.price <= (arm.maximumPrice ?? 0.75) + 1e-12
    && row.confidence + 1e-12 >= (arm.minimumConfidence ?? 0.50)
    && row.probability + 1e-12 >= (arm.minimumProbability ?? 0.55);
}

function firstToFire(rows: CandidateRow[], arm: Arm): Map<string, CandidateRow> {
  const result = new Map<string, CandidateRow>();
  for (const row of rows) if (admitted(row, arm) && !result.has(row.key)) result.set(row.key, row);
  return result;
}

function armReport(rows: CandidateRow[]) {
  const baseline = firstToFire(rows, arms[0]);
  return arms.map((arm) => {
    const candidate = firstToFire(rows, arm);
    const comparisons = [...baseline.values()].map((production) => {
      const selected = candidate.get(production.key);
      const productionReturn = returnAtAsk(production);
      const candidateReturn = selected ? returnAtAsk(selected) : 0;
      return { closesAt: production.closesAt, productionReturn, candidateReturn, incremental: candidateReturn - productionReturn, production, selected };
    });
    const selected = [...candidate.values()];
    const dropped = comparisons.filter((row) => !row.selected);
    return {
      id: arm.id,
      decisions: candidate.size,
      windows: new Set(selected.map((row) => row.closesAt)).size,
      wins: selected.filter((row) => row.outcome === row.side).length,
      losses: selected.filter((row) => row.outcome !== row.side).length,
      meanAsk: selected.length ? selected.reduce((sum, row) => sum + row.price, 0) / selected.length : null,
      meanPredictedProbability: selected.length ? selected.reduce((sum, row) => sum + row.probability, 0) / selected.length : null,
      observedWinRate: selected.length ? selected.filter((row) => row.outcome === row.side).length / selected.length : null,
      conditionalReturn: cluster(selected, (row) => row.closesAt, returnAtAsk),
      everyProductionPosition: cluster(comparisons, (row) => row.closesAt, (row) => row.candidateReturn),
      incrementalVsProduction: cluster(comparisons, (row) => row.closesAt, (row) => row.incremental),
      droppedPositions: dropped.length,
      droppedWinners: dropped.filter((row) => row.production.outcome === row.production.side).length,
      droppedLosers: dropped.filter((row) => row.production.outcome !== row.production.side).length,
    };
  });
}

function modelSegments(rows: CandidateRow[]) {
  const first = [...firstToFire(rows, arms[0]).values()];
  const summarize = (items: CandidateRow[]) => ({
    decisions: items.length,
    windows: new Set(items.map((row) => row.closesAt)).size,
    wins: items.filter((row) => row.outcome === row.side).length,
    winRate: items.length ? items.filter((row) => row.outcome === row.side).length / items.length : null,
    meanProbability: items.length ? items.reduce((sum, row) => sum + row.probability, 0) / items.length : null,
    calibrationGap: items.length ? items.reduce((sum, row) => sum + Number(row.outcome === row.side) - row.probability, 0) / items.length : null,
    brier: items.length ? items.reduce((sum, row) => sum + (row.probability - Number(row.outcome === row.side)) ** 2, 0) / items.length : null,
    return: cluster(items, (row) => row.closesAt, returnAtAsk),
  });
  const groups = <T extends string>(values: T[], select: (row: CandidateRow) => T) => Object.fromEntries(
    values.map((value) => [value, summarize(first.filter((row) => select(row) === value))]),
  );
  return {
    overall: summarize(first),
    byAsset: Object.fromEntries([...new Set(first.map((row) => row.symbol))].sort()
      .map((symbol) => [symbol, summarize(first.filter((row) => row.symbol === symbol))])),
    byDirection: groups(['UP', 'DOWN'], (row) => row.side),
    byEdge: groups(['5-8pp', '8-10pp', '10-15pp', '15pp+'], (row) => row.netEdge < 0.08 ? '5-8pp'
      : row.netEdge < 0.10 ? '8-10pp' : row.netEdge < 0.15 ? '10-15pp' : '15pp+'),
    byPrice: groups(['10-30c', '30-45c', '45-55c', '55-65c', '65-75c'], (row) => row.price < 0.30 ? '10-30c'
      : row.price < 0.45 ? '30-45c' : row.price < 0.55 ? '45-55c' : row.price < 0.65 ? '55-65c' : '65-75c'),
  };
}

function outcomeForOrder(order: PaperOrder, outcomeByKey: Map<string, PositionSide>): PositionSide | undefined {
  if (order.counterfactualHoldOutcome) return order.counterfactualHoldOutcome;
  if (order.outcome) return order.outcome;
  if (order.status === 'won') return order.side;
  if (order.status === 'lost') return opposite(order.side);
  return outcomeByKey.get(`${order.symbol}|${normalizedClose(order.closesAt)}`);
}

function hypotheticalPnl(order: PaperOrder, price: number, quantity: number, role: 'maker' | 'taker', outcome: PositionSide): { stake: number; pnl: number; return: number } | null {
  if (!(price > 0 && price < 1 && quantity > 0)) return null;
  const fee = venueFeeCents('kalshi', price * 100, quantity, role);
  const stake = price * quantity * 100 + fee;
  const pnl = outcome === order.side ? quantity * 100 - stake : -stake;
  return { stake, pnl, return: pnl / stake };
}

function executionReport(orders: PaperOrder[], outcomeByKey: Map<string, PositionSide>) {
  const attempts = orders.filter((order) => order.executionMode === 'live'
    && normalizeStrategyId(order.strategyId) === EDGE_BINARY_BUY && !order.id.includes(':exit:'));
  const resolved = attempts.flatMap((order) => {
    const outcome = outcomeForOrder(order, outcomeByKey);
    return outcome ? [{ order, outcome }] : [];
  });
  const filled = resolved.filter(({ order }) => (order.filledCount ?? 0) > 0);
  const acceptedMisses = resolved.filter(({ order }) => order.status === 'unfilled' && Boolean(order.venueOrderId)
    && order.entryExecutionDecision?.executedStyle === 'maker');
  const unique = new Map<string, typeof resolved[number]>();
  for (const row of resolved) if (!unique.has(orderKey(row.order))) unique.set(orderKey(row.order), row);
  const askRows = [...unique.values()].flatMap(({ order, outcome }) => {
    const price = order.issuanceAskPrice ?? order.entryDecision?.actionableAsk ?? order.askPrice;
    const replay = hypotheticalPnl(order, price, order.requestedQuantity ?? order.quantity, 'taker', outcome);
    return replay ? [{ order, outcome, replay }] : [];
  });
  const missRows = acceptedMisses.flatMap(({ order, outcome }) => {
    const replay = hypotheticalPnl(order, order.initialSubmittedPrice ?? Number.NaN,
      order.requestedQuantity ?? order.quantity, 'maker', outcome);
    return replay ? [{ order, outcome, replay }] : [];
  });
  const fillHoldRows = filled.map(({ order, outcome }) => {
    const stake = orderCost(order);
    const holdPnl = outcome === order.side ? order.quantity * 100 - stake : -stake;
    return { order, outcome, holdPnl, holdReturn: holdPnl / stake };
  });
  const strictExits = filled.filter(({ order }) => order.status === 'sold'
    && order.standaloneExitPolicy === 'strict-value-v1' && order.counterfactualHoldPnlCents !== undefined);
  const makerFillsByWindow = new Map<string, number[]>();
  for (const row of fillHoldRows.filter(({ order }) => (order.entryExecutionDecision?.executedStyle
    ?? order.archivedEvidence?.summary.entryExecutionStyle) === 'maker')) {
    makerFillsByWindow.set(row.order.closesAt, [...(makerFillsByWindow.get(row.order.closesAt) ?? []), row.holdReturn]);
  }
  const makerMissesByWindow = new Map<string, number[]>();
  for (const row of missRows) makerMissesByWindow.set(row.order.closesAt,
    [...(makerMissesByWindow.get(row.order.closesAt) ?? []), row.replay.return]);
  const pairedMakerWindows = [...makerFillsByWindow].flatMap(([closesAt, fillReturns]) => {
    const missReturns = makerMissesByWindow.get(closesAt);
    if (!missReturns?.length) return [];
    const fillReturn = fillReturns.reduce((sum, value) => sum + value, 0) / fillReturns.length;
    const missReturn = missReturns.reduce((sum, value) => sum + value, 0) / missReturns.length;
    return [{ closesAt, fillReturn, missReturn, difference: fillReturn - missReturn }];
  });
  const style = (order: PaperOrder) => order.entryExecutionDecision?.executedStyle
    ?? order.archivedEvidence?.summary.entryExecutionStyle ?? 'unknown';
  const filledSummary = (items: typeof filled) => ({
    positions: items.length,
    profitable: items.filter(({ order }) => orderPnl(order) > EPSILON).length,
    stakeCents: items.reduce((sum, { order }) => sum + orderCost(order), 0),
    pnlCents: items.reduce((sum, { order }) => sum + orderPnl(order), 0),
    clusteredReturn: cluster(items, ({ order }) => order.closesAt, ({ order }) => orderPnl(order) / orderCost(order)),
  });
  const makerAttempts = attempts.filter((order) => style(order) === 'maker');
  const makerRestriction = (id: string, admits: (order: PaperOrder) => boolean) => {
    const values = makerAttempts.map((order) => {
      const filled = (order.filledCount ?? 0) > 0;
      const productionReturn = filled ? orderPnl(order) / orderCost(order) : 0;
      const admitted = admits(order);
      return { order, admitted, productionReturn, candidateReturn: admitted ? productionReturn : 0 };
    });
    return {
      id, attempts: values.length, refused: values.filter((row) => !row.admitted).length,
      divergentWindows: new Set(values.filter((row) => !row.admitted).map((row) => row.order.closesAt)).size,
      productionPnlCents: values.reduce((sum, row) => sum + ((row.order.filledCount ?? 0) > 0 ? orderPnl(row.order) : 0), 0),
      candidatePnlCents: values.reduce((sum, row) => sum + (row.admitted && (row.order.filledCount ?? 0) > 0 ? orderPnl(row.order) : 0), 0),
      incrementalReturn: cluster(values, (row) => row.order.closesAt, (row) => row.candidateReturn - row.productionReturn),
    };
  };
  return {
    attempts: attempts.length,
    resolvedAttempts: resolved.length,
    venueAccepted: attempts.filter((order) => Boolean(order.venueOrderId)).length,
    filled: filled.length,
    unfilled: attempts.filter((order) => order.status === 'unfilled').length,
    rejectedOrOther: attempts.filter((order) => !['won', 'lost', 'sold', 'unfilled'].includes(order.status)).length,
    routeStyles: Object.fromEntries(['maker', 'taker', 'unknown'].map((route) => {
      const routeFills = filled.filter(({ order }) => style(order) === route);
      return [route, {
        attempts: attempts.filter((order) => style(order) === route).length,
        accepted: attempts.filter((order) => style(order) === route && Boolean(order.venueOrderId)).length,
        fills: routeFills.length,
        profitable: routeFills.filter(({ order }) => orderPnl(order) > EPSILON).length,
        pnlCents: routeFills.reduce((sum, { order }) => sum + orderPnl(order), 0),
        clusteredReturn: cluster(routeFills, ({ order }) => order.closesAt, ({ order }) => orderPnl(order) / orderCost(order)),
      }];
    })),
    prospectiveMakerRestrictions: [
      makerRestriction('maker-spread-max2c-v1', (order) => (order.entryDecision?.spread
        ?? order.issuanceSpread ?? order.spread) <= 0.02 + EPSILON),
      makerRestriction('maker-spike-max2pp-v1', (order) => {
        const edge = order.entryDecision?.netEdge;
        const median = order.entryDecision?.medianNetEdge;
        return edge !== undefined && median !== undefined && median !== null && edge - median < 0.02 - 1e-12;
      }),
    ],
    actual: {
      settled: filled.length,
      profitable: filled.filter(({ order }) => orderPnl(order) > EPSILON).length,
      wins: filled.filter(({ order }) => order.status === 'won').length,
      losses: filled.filter(({ order }) => order.status === 'lost').length,
      sold: filled.filter(({ order }) => order.status === 'sold').length,
      stakedCents: filled.reduce((sum, { order }) => sum + orderCost(order), 0),
      pnlCents: filled.reduce((sum, { order }) => sum + orderPnl(order), 0),
      clusteredReturn: cluster(filled, ({ order }) => order.closesAt, ({ order }) => orderPnl(order) / orderCost(order)),
      byAsset: Object.fromEntries([...new Set(filled.map(({ order }) => order.symbol))].sort()
        .map((symbol) => [symbol, filledSummary(filled.filter(({ order }) => order.symbol === symbol))])),
      byDirection: Object.fromEntries((['UP', 'DOWN'] as const)
        .map((side) => [side, filledSummary(filled.filter(({ order }) => order.side === side))])),
    },
    heldFillCounterfactual: {
      wins: fillHoldRows.filter((row) => row.outcome === row.order.side).length,
      pnlCents: fillHoldRows.reduce((sum, row) => sum + row.holdPnl, 0),
      clusteredReturn: cluster(fillHoldRows, (row) => row.order.closesAt, (row) => row.holdReturn),
    },
    makerFillSelection: {
      pairedWindows: pairedMakerWindows.length,
      filledMinusMissedReturn: cluster(pairedMakerWindows, (row) => row.closesAt, (row) => row.difference),
      filledReturn: cluster(pairedMakerWindows, (row) => row.closesAt, (row) => row.fillReturn),
      missedReturn: cluster(pairedMakerWindows, (row) => row.closesAt, (row) => row.missReturn),
    },
    acceptedMakerMissCounterfactual: {
      positions: missRows.length,
      wins: missRows.filter((row) => row.outcome === row.order.side).length,
      stakeCents: missRows.reduce((sum, row) => sum + row.replay.stake, 0),
      pnlCents: missRows.reduce((sum, row) => sum + row.replay.pnl, 0),
      clusteredReturn: cluster(missRows, (row) => row.order.closesAt, (row) => row.replay.return),
    },
    takeEveryFirstAttemptAtAskCounterfactual: {
      positions: askRows.length,
      wins: askRows.filter((row) => row.outcome === row.order.side).length,
      stakeCents: askRows.reduce((sum, row) => sum + row.replay.stake, 0),
      pnlCents: askRows.reduce((sum, row) => sum + row.replay.pnl, 0),
      clusteredReturn: cluster(askRows, (row) => row.order.closesAt, (row) => row.replay.return),
    },
    strictExit: {
      exits: strictExits.length,
      windows: new Set(strictExits.map(({ order }) => order.closesAt)).size,
      beatHold: strictExits.filter(({ order }) => orderPnl(order) - order.counterfactualHoldPnlCents! > EPSILON).length,
      incrementalCents: strictExits.reduce((sum, { order }) => sum + orderPnl(order) - order.counterfactualHoldPnlCents!, 0),
      clusteredIncrementalReturn: cluster(strictExits, ({ order }) => order.closesAt,
        ({ order }) => (orderPnl(order) - order.counterfactualHoldPnlCents!) / orderCost(order)),
    },
  };
}

const [forecasts, orders] = await Promise.all([getForecastHistory(), getExecutionOrders()]);
const generatedAt = new Date().toISOString();
const candidates = forecasts.flatMap((row) => {
  const candidate = forecastCandidate(row);
  return candidate ? [candidate] : [];
}).sort((left, right) => left.issuedAt.localeCompare(right.issuedAt));
const latestResolvedClose = Math.max(...candidates.map((row) => Date.parse(row.closesAt)).filter((value) => value <= Date.now()));
const requestedEnd = process.argv[2] ? Date.parse(process.argv[2]) : latestResolvedClose;
if (!Number.isFinite(requestedEnd)) throw new Error('No resolved v22 close or invalid optional end ISO.');
const endMs = Math.min(requestedEnd, latestResolvedClose);
const outcomeByKey = new Map<string, PositionSide>();
for (const row of candidates) outcomeByKey.set(`${row.symbol}|${row.closesAt}`, row.outcome);
const periods = [
  { id: 'last24h', startMs: endMs - 24 * HOUR_MS, endMs },
  { id: 'prior24h', startMs: endMs - 48 * HOUR_MS, endMs: endMs - 24 * HOUR_MS },
  { id: 'last72h', startMs: endMs - 72 * HOUR_MS, endMs },
  { id: 'activeV22', startMs: V22_ACTIVATED_AT, endMs },
];
const report = Object.fromEntries(periods.map((period) => {
  const periodCandidates = candidates.filter((row) => Date.parse(row.closesAt) > period.startMs && Date.parse(row.closesAt) <= period.endMs);
  const periodOrders = orders.filter((order) => Date.parse(order.closesAt) > period.startMs && Date.parse(order.closesAt) <= period.endMs
    && order.entryDecision?.policyVersion === BUY_POLICY_VERSION
    && order.entryExecutionDecision?.policyVersion === ENTRY_EXECUTION_POLICY_VERSION);
  const activeWindows = new Set(periodOrders.filter((order) => order.executionMode === 'live').map((order) => normalizedClose(order.closesAt)));
  const activeWindowCandidates = periodCandidates.filter((row) => activeWindows.has(row.closesAt));
  const orderedKeys = new Set(periodOrders.filter((order) => order.executionMode === 'live').map(orderKey));
  const filledKeys = new Set(periodOrders.filter((order) => order.executionMode === 'live' && (order.filledCount ?? 0) > 0).map(orderKey));
  const first = [...firstToFire(activeWindowCandidates, arms[0]).values()];
  return [period.id, {
    interval: { start: new Date(period.startMs).toISOString(), end: new Date(period.endMs).toISOString() },
    model: modelSegments(periodCandidates),
    policyTighteningScreen: armReport(periodCandidates),
    liveWindowSelection: {
      activeWindows: activeWindows.size,
      allCandidatesInActiveWindows: cluster(first, (row) => row.closesAt, returnAtAsk),
      orderedCandidates: cluster(first.filter((row) => orderedKeys.has(candidateKey(row))), (row) => row.closesAt, returnAtAsk),
      filledCandidates: cluster(first.filter((row) => filledKeys.has(candidateKey(row))), (row) => row.closesAt, returnAtAsk),
    },
    execution: executionReport(periodOrders, outcomeByKey),
  }];
}));

console.log(JSON.stringify({
  generatedAt,
  dataThroughResolvedClose: new Date(endMs).toISOString(),
  inputs: { forecastRows: forecasts.length, executionOrders: orders.length, activeV22KalshiCandidateObservations: candidates.length },
  versions: { buyPolicy: BUY_POLICY_VERSION, liveExecution: ENTRY_EXECUTION_POLICY_VERSION },
  method: {
    horizonUnit: 'resolved settlement close',
    correction: 'positions averaged within closesAt before standard error',
    tuningFamily: `${arms.length - 1} retrospective tightening candidates plus production`,
    fillCaveat: 'ask and posted-maker replays are optimistic and assign no value to capital reuse',
  },
  periods: report,
}, null, 2));
