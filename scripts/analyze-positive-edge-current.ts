/**
 * Current positive-edge execution review: does the active buy policy choose profitable positions, how
 * do actual maker/taker attempts differ, and what incremental value do the active exits add?
 *
 *   npm run analyze:positive-edge-current
 *
 * CORRECTIONS THAT DECIDE THE ANSWER
 * - Live and paper remain separate. They mirror selection but do not provide independent evidence.
 * - Returns and exit comparisons come from the production report builders, which cluster means by the
 *   settlement window instead of treating correlated positions as separate trials.
 * - The active execution-policy cohort is separate from the full active buy-policy cohort. Comparing
 *   maker with taker is descriptive, not causal: the adaptive policy deliberately sends different
 *   signals to each style, and a rejected/no-fill order deploys no capital.
 *
 * BIASES AND LIMITS
 * - The active cohorts are young. Small style/asset/direction slices cannot authorize a policy change.
 * - Maker no-fill returns are counterfactual settlement returns at issuance terms; actual filled returns
 *   use authoritative fills. Their paired gap measures selection, not deployable portfolio P&L.
 * - The report reloads durable forecasts and orders and is read-only. It writes no data and places no
 *   order. Historical contract-selection and take-the-ask controls remain in their named analyses.
 */
import { ENTRY_EXECUTION_POLICY_VERSION } from '../src/lib/entry-execution-policy';
import { buildMakerFillReport, buildTradeRecord } from '../src/lib/execution-report';
import { getForecastHistory } from '../src/lib/forecast-tracker';
import { getExecutionOrders } from '../src/lib/paper-execution';
import { BUY_POLICY_VERSION } from '../src/lib/prediction-policy';
import { EDGE_BINARY_BUY, normalizeStrategyId } from '../src/lib/strategy-registry';
import type { MakerFillReport, PaperOrder, TradeTrackRecord } from '../src/lib/types';

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const orderStake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents;
const orderPnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const normalizedClose = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
};

function clustered(values: Array<{ closesAt: string; value: number }>) {
  const windows = new Map<string, number[]>();
  for (const item of values) windows.set(item.closesAt, [...(windows.get(item.closesAt) ?? []), item.value]);
  const means = [...windows.values()].map((rows) => rows.reduce((sum, value) => sum + value, 0) / rows.length);
  const mean = means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : null;
  const standardError = mean !== null && means.length > 1
    ? Math.sqrt(means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (means.length - 1) / means.length)
    : null;
  return { decisions: values.length, windows: means.length, mean, standardError };
}

function record(record: TradeTrackRecord) {
  return {
    settled: record.settled, windows: record.windows, unfilled: record.unfilled, rejected: record.rejected,
    wins: record.wins, losses: record.losses, sold: record.sold,
    stakedCents: record.stakedCents, realizedPnlCents: record.realizedPnlCents, roi: record.roi,
    meanRealizedReturn: record.meanRealizedReturn, standardError: record.standardError,
    actionCounterfactuals: record.actionCounterfactuals,
    segments: record.segments.filter((segment) => ['Asset', 'Direction', 'Entry price', 'Time to settlement'].includes(segment.dimension)),
  };
}

function executionStyles(orders: PaperOrder[]) {
  return (['maker', 'taker'] as const).map((style) => {
    const attempts = orders.filter((order) => order.executionMode === 'live' && order.entryExecutionDecision?.executedStyle === style);
    return {
      style, attempts: attempts.length, venueAccepted: attempts.filter((order) => Boolean(order.venueOrderId)).length,
      fills: attempts.filter((order) => (order.filledCount ?? 0) > 0).length,
      record: record(buildTradeRecord(attempts, 'live')),
    };
  });
}

function makerDiagnostics(orders: PaperOrder[], outcomes: Map<string, 'UP' | 'DOWN'>) {
  const attempts = orders.filter((order) => order.executionMode === 'live'
    && order.entryExecutionDecision?.executedStyle === 'maker' && Boolean(order.venueOrderId));
  const rows = attempts.flatMap((order) => {
    const outcome = order.outcome ?? order.counterfactualHoldOutcome
      ?? outcomes.get(`${order.symbol}|${normalizedClose(order.closesAt)}`);
    if (!outcome) return [];
    const filled = (order.filledCount ?? 0) > 0;
    const issuanceAsk = order.issuanceAskPrice ?? order.entryDecision?.actionableAsk ?? order.askPrice;
    const postOrFill = filled
      ? order.authoritativeFillPrice ?? order.initialSubmittedPrice ?? order.askPrice
      : order.initialSubmittedPrice ?? order.askPrice;
    return [{
      order, filled, won: outcome === order.side,
      ask: issuanceAsk, discountCents: (issuanceAsk - postOrFill) * 100,
      spreadCents: order.spread * 100,
      netEdge: order.entryDecision?.netEdge ?? Number.NaN,
      edgeSpike: (order.entryDecision?.netEdge ?? 0) - (order.entryDecision?.medianNetEdge ?? 0),
      secondsRemaining: (Date.parse(order.closesAt) - Date.parse(order.createdAt)) / 1_000,
      quoteVolatilityCentsPerSecond: (order.makerFillEstimate?.quoteVolatilityPerSecond ?? Number.NaN) * 100,
    }];
  });
  const summary = (items: typeof rows) => ({
    attempts: items.length, wins: items.filter((item) => item.won).length,
    meanIssuanceAsk: average(items.map((item) => item.ask)),
    meanFillOrPostDiscountCents: average(items.map((item) => item.discountCents)),
    meanSpreadCents: average(items.map((item) => item.spreadCents)),
    meanNetEdge: average(items.map((item) => item.netEdge).filter(Number.isFinite)),
    meanEdgeSpike: average(items.map((item) => item.edgeSpike)),
    meanSecondsRemaining: average(items.map((item) => item.secondsRemaining)),
    meanQuoteVolatilityCentsPerSecond: average(items.map((item) => item.quoteVolatilityCentsPerSecond).filter(Number.isFinite)),
  });
  const winners = rows.filter((item) => item.won), losers = rows.filter((item) => !item.won);
  return {
    acceptedWithOutcome: rows.length,
    filled: summary(rows.filter((item) => item.filled)),
    acceptedNoFill: summary(rows.filter((item) => !item.filled)),
    fillRateConditionalOnWinner: winners.length ? winners.filter((item) => item.filled).length / winners.length : null,
    fillRateConditionalOnLoser: losers.length ? losers.filter((item) => item.filled).length / losers.length : null,
  };
}

function strictExitDiagnostics(orders: PaperOrder[], mode: 'live' | 'paper') {
  const exits = orders.filter((order) => order.executionMode === mode && order.status === 'sold'
    && order.standaloneExitPolicy === 'strict-value-v1' && order.counterfactualHoldPnlCents !== undefined);
  const rows = exits.map((order) => ({
    order,
    incrementalCents: orderPnl(order) - order.counterfactualHoldPnlCents!,
    triggerMarginCents: (order.saleProceedsCents ?? 0) - (order.standaloneExitOptimisticHoldValueCents ?? 0),
    secondsRemaining: (Date.parse(order.closesAt) - Date.parse(order.standaloneExitAttemptedAt ?? order.settledAt ?? order.closesAt)) / 1_000,
  }));
  const bands = [[0, 5], [5, 10], [10, Number.POSITIVE_INFINITY]] as const;
  return {
    exits: rows.length,
    windows: new Set(rows.map((row) => normalizedClose(row.order.closesAt))).size,
    exitsBeatingHold: rows.filter((row) => row.incrementalCents > 0).length,
    holdWinners: rows.filter((row) => row.order.counterfactualHoldOutcome === row.order.side).length,
    meanTriggerMarginCents: average(rows.map((row) => row.triggerMarginCents)),
    medianTriggerMarginCents: rows.length ? [...rows].sort((a, b) => a.triggerMarginCents - b.triggerMarginCents)[Math.floor(rows.length / 2)].triggerMarginCents : null,
    meanSecondsRemaining: average(rows.map((row) => row.secondsRemaining)),
    incremental: clustered(rows.map((row) => ({ closesAt: row.order.closesAt, value: row.incrementalCents / orderStake(row.order) }))),
    bands: bands.map(([minimum, maximum]) => {
      const items = rows.filter((row) => row.triggerMarginCents >= minimum && row.triggerMarginCents < maximum);
      return {
        label: maximum === Number.POSITIVE_INFINITY ? `${minimum}c+` : `${minimum}-${maximum}c`, exits: items.length,
        incrementalCents: items.reduce((sum, item) => sum + item.incrementalCents, 0),
        exitsBeatingHold: items.filter((item) => item.incrementalCents > 0).length,
      };
    }),
  };
}

function exitMarginReplay(orders: PaperOrder[], mode: 'live' | 'paper', outcomes: Map<string, 'UP' | 'DOWN'>) {
  const positions = orders.filter((order) => order.executionMode === mode && !order.switchedToOrderId
    && (order.status === 'won' || order.status === 'lost' || order.status === 'sold')
    && Boolean(order.positionObservations?.length));
  const holdPnl = (order: PaperOrder) => {
    if (order.counterfactualHoldPnlCents !== undefined) return order.counterfactualHoldPnlCents;
    const outcome = order.outcome ?? outcomes.get(`${order.symbol}|${normalizedClose(order.closesAt)}`);
    if (!outcome) return null;
    return outcome === order.side ? (order.potentialPayoutCents ?? order.quantity * 100) - orderStake(order) : -orderStake(order);
  };
  const usable = positions.filter((order) => holdPnl(order) !== null);
  const result = (label: string, marginCents: number | null) => {
    let fired = 0;
    const rows = usable.map((order) => {
      const observation = marginCents === null ? undefined : [...(order.positionObservations ?? [])]
        .sort((left, right) => left.at.localeCompare(right.at))
        .find((item) => {
          const uncertainty = Math.max(0.03, Math.min(0.15, (1 - item.confidence) * 0.25));
          const optimisticHold = order.quantity * 100 * Math.min(1, item.ownedSideProbability + uncertainty);
          return item.netLiquidationCents >= optimisticHold + marginCents - 1e-9;
        });
      if (observation) fired += 1;
      const pnl = observation ? observation.netLiquidationCents - orderStake(order) : holdPnl(order)!;
      return { order, pnl, incremental: pnl - orderPnl(order) };
    });
    return {
      label, fired, totalPnlCents: rows.reduce((sum, row) => sum + row.pnl, 0),
      incrementalCents: rows.reduce((sum, row) => sum + row.incremental, 0),
      incremental: clustered(rows.map((row) => ({ closesAt: row.order.closesAt, value: row.incremental / orderStake(row.order) }))),
    };
  };
  return {
    positions: usable.length,
    fillAssumption: mode === 'paper' ? 'exact simulated execution' : 'optimistic executable-bid fill replay',
    variants: [1, 2, 3, 5, 10, 20, 50].map((margin) => result(`${margin}c`, margin)).concat(result('hold', null)),
  };
}

function maker(report: MakerFillReport) {
  return {
    adaptiveExecution: report.adaptiveExecution,
    submittedAttempts: report.submittedAttempts, acceptedAttempts: report.acceptedAttempts,
    filledAttempts: report.partialFills + report.completeFills,
    resolvedFilledAttempts: report.resolvedFilledAttempts,
    filledWinRate: report.filledWinRate, meanFilledReturn: report.meanFilledReturn,
    resolvedAcceptedNoFillAttempts: report.resolvedAcceptedNoFillAttempts,
    acceptedNoFillCounterfactualWinRate: report.acceptedNoFillCounterfactualWinRate,
    meanAcceptedNoFillCounterfactualReturn: report.meanAcceptedNoFillCounterfactualReturn,
    pairedAdverseSelectionWindows: report.pairedAdverseSelectionWindows,
    pairedWinRateGap: report.pairedWinRateGap,
    pairedWinRateGapStandardError: report.pairedWinRateGapStandardError,
    pairedReturnGap: report.pairedReturnGap,
    pairedReturnGapStandardError: report.pairedReturnGapStandardError,
    segments: report.segments,
  };
}

const [orders, forecasts] = await Promise.all([getExecutionOrders(), getForecastHistory()]);
const entries = orders.filter((order) => normalizeStrategyId(order.strategyId) === EDGE_BINARY_BUY && !order.id.includes(':exit:'));
const activeBuy = entries.filter((order) => order.entryDecision?.policyVersion === BUY_POLICY_VERSION);
const activeExecution = activeBuy.filter((order) => order.entryExecutionDecision?.policyVersion === ENTRY_EXECUTION_POLICY_VERSION);
const outcomes = new Map<string, 'UP' | 'DOWN'>();
for (const forecast of forecasts) if (forecast.status === 'resolved' && (forecast.outcome === 'UP' || forecast.outcome === 'DOWN')) {
  outcomes.set(`${forecast.symbol}|${normalizedClose(forecast.closesAt)}`, forecast.outcome);
}

// One candidate position, not every repeated qualifying update. This is the current-policy gate value
// before portfolio choice and execution select subsets from it.
const candidates = new Map<string, { key: string; closesAt: string; value: number }>();
for (const forecast of [...forecasts].sort((left, right) => left.issuedAt.localeCompare(right.issuedAt))) {
  if (forecast.policyVersion !== BUY_POLICY_VERSION || forecast.qualified === false
    || forecast.status !== 'resolved' || !forecast.outcome || !forecast.entrySide
    || !(forecast.entryAsk && forecast.entryAsk > 0 && forecast.entryAsk < 1)) continue;
  const fee = forecast.entryFeeRate ?? 0;
  const cost = forecast.entryAsk + fee;
  if (!(cost > 0)) continue;
  const key = `${forecast.symbol}|${forecast.closesAt}|${forecast.entrySide}`;
  if (!candidates.has(key)) candidates.set(key, {
    key, closesAt: forecast.closesAt,
    value: forecast.outcome === forecast.entrySide ? (1 - cost) / cost : -1,
  });
}
const orderedKeys = new Set(activeBuy.filter((order) => order.executionMode === 'live')
  .map((order) => `${order.symbol}|${order.closesAt}|${order.side}`));
const filledKeys = new Set(activeBuy.filter((order) => order.executionMode === 'live' && (order.filledCount ?? 0) > 0)
  .map((order) => `${order.symbol}|${order.closesAt}|${order.side}`));
const candidateRows = [...candidates.values()];

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputs: { orders: orders.length, forecasts: forecasts.length },
  buyPolicyVersion: BUY_POLICY_VERSION,
  executionPolicyVersion: ENTRY_EXECUTION_POLICY_VERSION,
  activeBuyPolicy: {
    attempts: activeBuy.length,
    signalSelection: {
      everyQualifiedPositionAtAskHeld: clustered(candidateRows),
      positionsOrderedLiveAtAskHeld: clustered(candidateRows.filter((candidate) => orderedKeys.has(candidate.key))),
      positionsFilledLiveAtAskHeld: clustered(candidateRows.filter((candidate) => filledKeys.has(candidate.key))),
    },
    executionStyles: executionStyles(activeBuy),
    maker: maker(buildMakerFillReport(activeBuy, forecasts)),
    makerDiagnostics: makerDiagnostics(activeBuy, outcomes),
    strictExitDiagnostics: {
      live: strictExitDiagnostics(activeBuy, 'live'), paper: strictExitDiagnostics(activeBuy, 'paper'),
    },
    exitMarginReplay: {
      live: exitMarginReplay(activeBuy, 'live', outcomes), paper: exitMarginReplay(activeBuy, 'paper', outcomes),
    },
    live: record(buildTradeRecord(activeBuy, 'live')),
    paper: record(buildTradeRecord(activeBuy, 'paper')),
  },
  activeExecutionPolicy: {
    attempts: activeExecution.length,
    executionStyles: executionStyles(activeExecution),
    maker: maker(buildMakerFillReport(activeExecution, forecasts)),
    makerDiagnostics: makerDiagnostics(activeExecution, outcomes),
    strictExitDiagnostics: strictExitDiagnostics(activeExecution, 'live'),
    exitMarginReplay: exitMarginReplay(activeExecution, 'live', outcomes),
    live: record(buildTradeRecord(activeExecution, 'live')),
  },
  lifetimeMakerDiagnostics: makerDiagnostics(entries, outcomes),
  lifetimeExitMarginReplay: {
    live: exitMarginReplay(entries, 'live', outcomes), paper: exitMarginReplay(entries, 'paper', outcomes),
  },
}, null, 2));
