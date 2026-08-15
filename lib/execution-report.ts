import { ACTION_COUNTERFACTUAL_VERSION, buildActionCounterfactuals, clusterByWindow } from './action-counterfactual';
import { normalizeMarketId } from './market-registry';
import type { ExecutionMode, MakerExecutionSegment, MakerFillReport, MarketId, PaperOrder, ProviderTradeRecord, SegmentGroup, SegmentStat, TrackedForecast, TradeTrackRecord, TradingProviderId } from './types';

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);

const actualStake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents;
const actualPnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const issuanceAsk = (order: PaperOrder) => order.issuanceAskPrice ?? order.entryDecision?.actionableAsk ?? order.askPrice;

/** Expected value the order was placed on, recovered from the fill terms recorded at entry. */
function predictedEdge(order: PaperOrder): number {
  const fee = order.actualFeeCents ?? order.feeCents;
  const feeRate = order.potentialPayoutCents ? fee / order.potentialPayoutCents : 0;
  const probability = order.side === 'UP' ? order.modelProbabilityUp : 1 - order.modelProbabilityUp;
  return order.entryDecision?.netEdge ?? probability - issuanceAsk(order) - feeRate;
}

/** Cash returned per $1 staked, which is the only definition of success that pays. */
function realizedReturn(order: PaperOrder): number {
  const stake = actualStake(order);
  return stake ? actualPnl(order) / stake : 0;
}

/**
 * Statistics are clustered by settlement window because trades sharing a window share one market
 * move. Treating them as independent is what made earlier readings look far more certain than they were.
 */
function segmentStat(label: string, orders: PaperOrder[]): SegmentStat {
  const clustered = clusterByWindow(orders, (order) => order.closesAt, realizedReturn);
  return {
    label, trades: orders.length, windows: clustered.windows,
    meanPredictedEdge: orders.reduce((sum, order) => sum + predictedEdge(order), 0) / orders.length,
    meanRealizedReturn: clustered.mean ?? Number.NaN, standardError: clustered.standardError,
    winRate: orders.filter((order) => order.status === 'won').length / orders.length,
  };
}

function group(dimension: string, description: string, orders: PaperOrder[], key: (order: PaperOrder) => string | null): SegmentGroup {
  const groups = new Map<string, PaperOrder[]>();
  for (const order of orders) {
    const label = key(order);
    if (label === null) continue;
    groups.set(label, [...(groups.get(label) ?? []), order]);
  }
  return {
    dimension, description,
    segments: [...groups.entries()].map(([label, items]) => segmentStat(label, items)).sort((a, b) => b.meanRealizedReturn - a.meanRealizedReturn),
  };
}

const priceBand = (price: number) => price < 0.10 ? '<10¢'
  : price < 0.25 ? '10–25¢'
    : price < 0.35 ? '25–35¢'
      : price < 0.45 ? '35–45¢'
        : price < 0.55 ? '45–55¢'
          : price < 0.65 ? '55–65¢'
            : price < 0.75 ? '65–75¢' : '75¢+';
const timeBand = (order: PaperOrder) => {
  const seconds = (Date.parse(order.closesAt) - Date.parse(order.createdAt)) / 1000;
  return seconds < 120 ? '<2m' : seconds < 300 ? '2–5m' : seconds < 600 ? '5–10m' : '10m+';
};

const normalizedClose = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
};
const makerOutcomeKey = (symbol: string, closesAt: string) => `${symbol}:${normalizedClose(closesAt)}`;
const inferredPostOnlyRace = (order: PaperOrder) => order.noFillReason === 'post_only_race'
  || (order.status === 'unfilled' && (order.reason?.toLowerCase().includes('post-only') ?? false)
    && ((order.reason?.toLowerCase().includes('cross') ?? false) || (order.reason?.toLowerCase().includes('acknowledgement race') ?? false)));

function makerReturn(order: PaperOrder, outcome: 'UP' | 'DOWN', filled: boolean): number | null {
  const stake = filled ? actualStake(order) : order.stakeCents;
  if (!(stake > 0)) return null;
  if (filled && (order.actualPnlCents !== undefined || order.pnlCents !== undefined)) return actualPnl(order) / stake;
  const payout = outcome === order.side ? order.potentialPayoutCents : 0;
  return (payout - stake) / stake;
}

function makerSegment(dimension: MakerExecutionSegment['dimension'], label: string, items: PaperOrder[], outcomeFor: (order: PaperOrder) => 'UP' | 'DOWN' | undefined): MakerExecutionSegment {
  const accepted = items.filter((order) => Boolean(order.venueOrderId));
  const fills = accepted.filter((order) => (order.filledCount ?? 0) > 0);
  const resolvedFills = fills.flatMap((order) => {
    const outcome = outcomeFor(order);
    return outcome ? [{ order, outcome }] : [];
  });
  const returns = resolvedFills.flatMap(({ order, outcome }) => {
    const value = makerReturn(order, outcome, true);
    return value === null ? [] : [value];
  });
  return {
    dimension, label, submitted: items.length, accepted: accepted.length, fills: fills.length,
    resolvedFills: resolvedFills.length,
    fillRateGivenAcceptance: accepted.length ? fills.length / accepted.length : null,
    filledWinRate: resolvedFills.length ? resolvedFills.filter(({ order, outcome }) => outcome === order.side).length / resolvedFills.length : null,
    meanFilledReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
  };
}

export function buildMakerFillReport(orders: PaperOrder[], forecasts: TrackedForecast[] = []): MakerFillReport {
  const forecastOutcomes = new Map<string, 'UP' | 'DOWN'>();
  for (const forecast of forecasts) if (forecast.status === 'resolved' && (forecast.outcome === 'UP' || forecast.outcome === 'DOWN')) {
    forecastOutcomes.set(makerOutcomeKey(forecast.symbol, forecast.closesAt), forecast.outcome);
  }
  const outcomeFor = (order: PaperOrder): 'UP' | 'DOWN' | undefined => order.outcome ?? order.counterfactualHoldOutcome
    ?? forecastOutcomes.get(makerOutcomeKey(order.symbol, order.closesAt));
  const makerEntries = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi'
    && !order.id.includes(':exit:') && order.liquidityRole !== 'taker'
    && (Boolean(order.makerFillEstimate) || order.liquidityRole === 'maker' || inferredPostOnlyRace(order)
      || (order.status === 'unfilled' && Boolean(order.venueOrderId)))
    && order.status !== 'pending_reservation' && order.status !== 'uncertain');
  const postOnlyRaces = makerEntries.filter((order) => inferredPostOnlyRace(order) && !order.venueOrderId);
  const accepted = makerEntries.filter((order) => Boolean(order.venueOrderId));
  const acceptedFills = accepted.filter((order) => (order.filledCount ?? 0) > 0);
  const acceptedNoFills = accepted.filter((order) => !((order.filledCount ?? 0) > 0));
  const completeFills = acceptedFills.filter((order) => (order.filledCount ?? 0) + 1e-8 >= (order.requestedQuantity ?? order.quantity));
  const partialFills = acceptedFills.filter((order) => !completeFills.includes(order));

  // First-passage calibration is conditional on venue acceptance. Post-only acknowledgement races
  // never entered a queue and therefore cannot be interpreted as observed queue non-fills.
  const attempts = accepted.filter((order) => order.makerFillEstimate?.model === 'quote-first-passage-v1');
  const bands = [
    { label: '0–25%', min: 0, max: 0.25 }, { label: '25–50%', min: 0.25, max: 0.5 },
    { label: '50–75%', min: 0.5, max: 0.75 }, { label: '75–100%', min: 0.75, max: 1.000001 },
  ];
  const buckets = bands.flatMap(({ label, min, max }) => {
    const items = attempts.filter((order) => order.makerFillEstimate!.probability >= min && order.makerFillEstimate!.probability < max);
    if (!items.length) return [];
    const fills = items.filter((order) => (order.filledCount ?? 0) > 0).length;
    return [{
      label, attempts: items.length, fills,
      meanPredictedProbability: items.reduce((sum, order) => sum + order.makerFillEstimate!.probability, 0) / items.length,
      observedFillRate: fills / items.length,
    }];
  });
  const resolvedFills = acceptedFills.flatMap((order) => {
    const outcome = outcomeFor(order);
    return outcome ? [{ order, outcome }] : [];
  });
  const resolvedNoFills = acceptedNoFills.flatMap((order) => {
    const outcome = outcomeFor(order);
    return outcome ? [{ order, outcome }] : [];
  });
  const filledReturns = resolvedFills.flatMap(({ order, outcome }) => {
    const value = makerReturn(order, outcome, true);
    return value === null ? [] : [value];
  });
  const noFillReturns = resolvedNoFills.flatMap(({ order, outcome }) => {
    const value = makerReturn(order, outcome, false);
    return value === null ? [] : [value];
  });
  const filledWinRate = resolvedFills.length ? resolvedFills.filter(({ order, outcome }) => outcome === order.side).length / resolvedFills.length : null;
  const noFillWinRate = resolvedNoFills.length ? resolvedNoFills.filter(({ order, outcome }) => outcome === order.side).length / resolvedNoFills.length : null;
  const pairedDifferences = (left: Array<{ order: PaperOrder; value: number }>, right: Array<{ order: PaperOrder; value: number }>) => {
    const leftWindows = new Map<string, number[]>();
    const rightWindows = new Map<string, number[]>();
    for (const item of left) leftWindows.set(normalizedClose(item.order.closesAt), [...(leftWindows.get(normalizedClose(item.order.closesAt)) ?? []), item.value]);
    for (const item of right) rightWindows.set(normalizedClose(item.order.closesAt), [...(rightWindows.get(normalizedClose(item.order.closesAt)) ?? []), item.value]);
    const differences = [...leftWindows.entries()].flatMap(([window, values]) => {
      const comparison = rightWindows.get(window);
      return comparison ? [values.reduce((sum, value) => sum + value, 0) / values.length - comparison.reduce((sum, value) => sum + value, 0) / comparison.length] : [];
    });
    const mean = differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null;
    const standardError = mean !== null && differences.length > 1
      ? Math.sqrt(differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (differences.length - 1) / differences.length)
      : null;
    return { windows: differences.length, mean, standardError };
  };
  const pairedWins = pairedDifferences(
    resolvedFills.map(({ order, outcome }) => ({ order, value: outcome === order.side ? 1 : 0 })),
    resolvedNoFills.map(({ order, outcome }) => ({ order, value: outcome === order.side ? 1 : 0 })),
  );
  const pairedReturns = pairedDifferences(
    resolvedFills.flatMap(({ order, outcome }) => { const value = makerReturn(order, outcome, true); return value === null ? [] : [{ order, value }]; }),
    resolvedNoFills.flatMap(({ order, outcome }) => { const value = makerReturn(order, outcome, false); return value === null ? [] : [{ order, value }]; }),
  );
  const groupedSegments: Array<[MakerExecutionSegment['dimension'], (order: PaperOrder) => string | null]> = [
    ['Direction', (order) => order.side],
    ['Attempt', (order) => `attempt ${order.attemptNumber ?? 1}`],
    ['Entry price', (order) => issuanceAsk(order) < 0.1 ? '<10¢' : issuanceAsk(order) < 0.25 ? '10–25¢' : issuanceAsk(order) < 0.5 ? '25–50¢' : '50¢+'],
    ['Quote distance', (order) => !order.makerFillEstimate ? null : order.makerFillEstimate.quoteDistance < 0.005 ? '<0.5¢' : order.makerFillEstimate.quoteDistance <= 0.01 ? '0.5–1¢' : order.makerFillEstimate.quoteDistance <= 0.02 ? '1–2¢' : '2¢+'],
    ['Quote volatility', (order) => !order.makerFillEstimate ? null : order.makerFillEstimate.quoteVolatilityPerSecond * 100 < 0.5 ? '<0.5¢/s' : order.makerFillEstimate.quoteVolatilityPerSecond * 100 < 1 ? '0.5–1¢/s' : order.makerFillEstimate.quoteVolatilityPerSecond * 100 < 2 ? '1–2¢/s' : '2¢+/s'],
  ];
  const segments = groupedSegments.flatMap(([dimension, key]) => {
    const groups = new Map<string, PaperOrder[]>();
    for (const order of makerEntries) {
      const label = key(order);
      if (label) groups.set(label, [...(groups.get(label) ?? []), order]);
    }
    return [...groups.entries()].map(([label, items]) => makerSegment(dimension, label, items, outcomeFor));
  });
  const fills = attempts.filter((order) => (order.filledCount ?? 0) > 0).length;
  const shadowEvaluations = orders.filter((order) => order.executionMode === 'live' && Boolean(order.entryExecutionDecision));
  const takerRecommendations = shadowEvaluations.filter((order) => order.entryExecutionDecision?.recommendedStyle === 'taker');
  const resolvedShadowTakerReturns = takerRecommendations.flatMap((order) => {
    const outcome = outcomeFor(order), stake = order.shadowTakerAllInCents, quantity = order.shadowTakerQuantity;
    if (!outcome || !(stake && stake > 0) || !(quantity && quantity > 0)) return [];
    const payout = outcome === order.side ? quantity * 100 : 0;
    return [(payout - stake) / stake];
  });
  const actualTakerOrders = orders.filter((order) => order.executionMode === 'live' && !order.id.includes(':exit:')
    && order.entryExecutionDecision?.executedStyle === 'taker');
  const actualTakerFills = actualTakerOrders.filter((order) => (order.filledCount ?? 0) > 0);
  const resolvedActualTakerReturns = actualTakerFills.flatMap((order) => {
    const outcome = outcomeFor(order);
    const value = outcome ? makerReturn(order, outcome, true) : null;
    return value === null ? [] : [value];
  });
  const auditedAttempts = makerEntries.filter((order) => order.entryExecutionObservations?.length);
  const depthObservations = auditedAttempts.flatMap((order) => order.entryExecutionObservations ?? [])
    .filter((observation) => observation.displayedAhead !== undefined);
  const cancellationObservations = auditedAttempts.flatMap((order) => order.entryExecutionObservations ?? [])
    .filter((observation) => observation.cancellationLatencyMs !== undefined);
  const restingObservations = auditedAttempts.flatMap((order) => order.entryExecutionObservations ?? [])
    .filter((observation) => observation.restingDurationMs !== undefined);
  const lifecycleOrders = orders.filter((order) => order.executionMode === 'live' && order.positionObservations?.length);
  const matchedPaper = orders.filter((order) => order.executionMode === 'paper' && Boolean(order.matchedLiveFill));
  const independentlyFilledMatchedPaper = matchedPaper.filter((order) => (order.filledCount ?? 0) > 0);
  return {
    matchedLivePaper: {
      matchedIntents: matchedPaper.length,
      independentPaperFills: independentlyFilledMatchedPaper.length,
      liveOnlyFills: matchedPaper.length - independentlyFilledMatchedPaper.length,
      bothFilled: independentlyFilledMatchedPaper.length,
      meanMatchedQuantity: matchedPaper.length
        ? matchedPaper.reduce((sum, order) => sum + order.matchedLiveFill!.quantity, 0) / matchedPaper.length : null,
      meanLiveFillPrice: matchedPaper.length
        ? matchedPaper.reduce((sum, order) => sum + order.matchedLiveFill!.fillPrice, 0) / matchedPaper.length : null,
    },
    adaptiveExecution: {
      policyVersion: shadowEvaluations.at(-1)?.entryExecutionDecision?.policyVersion ?? 'maker-taker-adaptive-shadow-v1',
      shadowEvaluations: shadowEvaluations.length, takerRecommendations: takerRecommendations.length,
      resolvedTakerRecommendations: resolvedShadowTakerReturns.length,
      meanTakerCounterfactualReturn: resolvedShadowTakerReturns.length ? resolvedShadowTakerReturns.reduce((sum, value) => sum + value, 0) / resolvedShadowTakerReturns.length : null,
      actualTakerOrders: actualTakerOrders.length, actualTakerFills: actualTakerFills.length,
      resolvedActualTakerFills: resolvedActualTakerReturns.length,
      meanActualTakerReturn: resolvedActualTakerReturns.length ? resolvedActualTakerReturns.reduce((sum, value) => sum + value, 0) / resolvedActualTakerReturns.length : null,
    },
    attempts: attempts.length, fills,
    meanPredictedProbability: attempts.length ? attempts.reduce((sum, order) => sum + order.makerFillEstimate!.probability, 0) / attempts.length : null,
    observedFillRate: attempts.length ? fills / attempts.length : null,
    buckets, model: 'quote-first-passage-v1',
    submittedAttempts: makerEntries.length, postOnlyRaces: postOnlyRaces.length,
    otherRejectedAttempts: makerEntries.length - postOnlyRaces.length - accepted.length,
    acceptedAttempts: accepted.length, restedNoFillAttempts: acceptedNoFills.length,
    partialFills: partialFills.length, completeFills: completeFills.length,
    acceptanceRate: makerEntries.length ? accepted.length / makerEntries.length : null,
    fillRateGivenAcceptance: accepted.length ? acceptedFills.length / accepted.length : null,
    resolvedFilledAttempts: resolvedFills.length,
    resolvedFilledWindows: new Set(resolvedFills.map(({ order }) => normalizedClose(order.closesAt))).size,
    resolvedAcceptedNoFillAttempts: resolvedNoFills.length,
    resolvedAcceptedNoFillWindows: new Set(resolvedNoFills.map(({ order }) => normalizedClose(order.closesAt))).size,
    filledWinRate,
    acceptedNoFillCounterfactualWinRate: noFillWinRate,
    adverseSelectionWinRateGap: filledWinRate === null || noFillWinRate === null ? null : filledWinRate - noFillWinRate,
    pairedAdverseSelectionWindows: pairedWins.windows,
    pairedWinRateGap: pairedWins.mean, pairedWinRateGapStandardError: pairedWins.standardError,
    meanFilledReturn: filledReturns.length ? filledReturns.reduce((sum, value) => sum + value, 0) / filledReturns.length : null,
    meanAcceptedNoFillCounterfactualReturn: noFillReturns.length ? noFillReturns.reduce((sum, value) => sum + value, 0) / noFillReturns.length : null,
    pairedReturnGap: pairedReturns.mean, pairedReturnGapStandardError: pairedReturns.standardError,
    executionAudit: {
      attemptsWithPath: auditedAttempts.length,
      attemptsWithDepth: auditedAttempts.filter((order) => order.entryExecutionObservations?.some((item) => item.displayedAhead !== undefined)).length,
      repricedAttempts: auditedAttempts.filter((order) => order.entryExecutionObservations?.some((item) => item.event === 'amend_accepted')).length,
      meanDisplayedAhead: depthObservations.length
        ? depthObservations.reduce((sum, item) => sum + item.displayedAhead!, 0) / depthObservations.length : null,
      cancellationsObserved: cancellationObservations.length,
      meanCancellationLatencyMs: cancellationObservations.length
        ? cancellationObservations.reduce((sum, item) => sum + item.cancellationLatencyMs!, 0) / cancellationObservations.length : null,
      meanRestingDurationMs: restingObservations.length
        ? restingObservations.reduce((sum, item) => sum + item.restingDurationMs!, 0) / restingObservations.length : null,
      positionsObserved: lifecycleOrders.length,
      positionSnapshots: lifecycleOrders.reduce((sum, order) => sum + (order.positionObservations?.length ?? 0), 0),
    },
    segments,
  };
}

/**
 * Provider identity for an order, including the 1,394 records written before `providerId` existed. Those
 * always used the venue as the provider, so the venue is the correct answer rather than a guess — which
 * is what lets historical results be split per provider without losing them.
 */
export function orderProviderId(order: PaperOrder): TradingProviderId {
  return order.providerId ?? order.venue;
}

/** Market an order belongs to, defaulting to the only market that existed when it was written. */
export function orderMarketId(order: PaperOrder): MarketId {
  return normalizeMarketId(order.marketId);
}

/**
 * Splits a mode's orders into one record per (provider, market). Ordered by settled count so the
 * provider with the most evidence reads first, with provider id as a stable tiebreak.
 */
export function buildProviderTradeRecords(orders: PaperOrder[], mode: ExecutionMode): ProviderTradeRecord[] {
  const groups = new Map<string, { providerId: TradingProviderId; marketId: MarketId; orders: PaperOrder[] }>();
  for (const order of orders.filter((item) => item.executionMode === mode)) {
    const providerId = orderProviderId(order);
    const marketId = orderMarketId(order);
    const key = `${providerId}:${marketId}`;
    const group = groups.get(key) ?? { providerId, marketId, orders: [] };
    group.orders.push(order);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ providerId: group.providerId, marketId: group.marketId, record: buildTradeRecord(group.orders, mode) }))
    .sort((a, b) => b.record.settled - a.record.settled || a.providerId.localeCompare(b.providerId));
}

export function buildTradeRecord(orders: PaperOrder[], mode: ExecutionMode): TradeTrackRecord {
  const mine = orders.filter((order) => order.executionMode === mode);
  const settled = mine.filter((order) => settledStatuses.has(order.status));
  const staked = settled.reduce((sum, order) => sum + actualStake(order), 0);
  const returned = settled.reduce((sum, order) => sum + (order.payoutCents ?? 0), 0);
  const overall = settled.length ? segmentStat('all', settled) : null;
  const evaluatedSwitches = mine.filter((order) => order.switchVsHoldCents !== undefined);
  const evaluatedStandaloneExits = mine.filter((order) => order.status === 'sold' && !order.switchedToOrderId
    && order.counterfactualHoldPnlCents !== undefined && !order.id.includes(':exit:'));
  // Observation-only alternative: at the full exit's realized average net price, sell only enough
  // quantity to recover exact principal and retain the residual binary payout. It is intentionally
  // reported rather than traded until independent exit windows justify changing the approved policy.
  const principalRecovery = evaluatedStandaloneExits.flatMap((order) => {
    const stake = actualStake(order), netProceeds = stake + actualPnl(order);
    if (!(netProceeds >= stake) || !(netProceeds > 0) || !order.counterfactualHoldOutcome) return [];
    const retainedFraction = Math.max(0, 1 - stake / netProceeds);
    const counterfactualPnl = order.counterfactualHoldOutcome === order.side ? order.potentialPayoutCents * retainedFraction : 0;
    return [{ order, incremental: counterfactualPnl - actualPnl(order) }];
  });
  const principalRecoveryVsFullExitCents = principalRecovery.length
    ? principalRecovery.reduce((sum, item) => sum + item.incremental, 0)
    : null;
  return {
    mode,
    settled: settled.length,
    pending: mine.filter((order) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain').length,
    windows: new Set(settled.map((order) => order.closesAt)).size,
    wins: mine.filter((order) => order.status === 'won').length,
    losses: mine.filter((order) => order.status === 'lost').length,
    invalid: mine.filter((order) => order.status === 'invalid').length,
    sold: mine.filter((order) => order.status === 'sold').length,
    unfilled: mine.filter((order) => order.status === 'unfilled').length,
    rejected: mine.filter((order) => order.status === 'rejected').length,
    stakedCents: staked, returnedCents: returned,
    realizedPnlCents: returned - staked,
    roi: staked ? (returned - staked) / staked : null,
    winRate: overall?.winRate ?? null,
    meanPredictedEdge: overall?.meanPredictedEdge ?? null,
    meanRealizedReturn: overall?.meanRealizedReturn ?? null,
    standardError: overall?.standardError ?? null,
    switchesEvaluated: evaluatedSwitches.length,
    meanSwitchVsHoldCents: evaluatedSwitches.length ? evaluatedSwitches.reduce((sum, order) => sum + order.switchVsHoldCents!, 0) / evaluatedSwitches.length : null,
    standaloneExitsEvaluated: evaluatedStandaloneExits.length,
    actionCounterfactualVersion: ACTION_COUNTERFACTUAL_VERSION,
    actionCounterfactuals: buildActionCounterfactuals(orders, mode),
    principalRecoveryExitsEvaluated: principalRecovery.length,
    principalRecoveryVsFullExitCents,
    meanPrincipalRecoveryVsFullExitCents: principalRecoveryVsFullExitCents === null ? null : principalRecoveryVsFullExitCents / principalRecovery.length,
    segments: settled.length ? [
      group('Asset', 'Which markets paid', settled, (order) => order.symbol),
      group('Direction', 'Which binary side was purchased', settled, (order) => order.side),
      group('Venue', 'Where the fill happened', settled, (order) => order.venue),
      group('Entry price', 'Cheap entries are where model error dominates', settled, (order) => priceBand(issuanceAsk(order))),
      group('Time to settlement', 'Later entries are more predictable', settled, timeBand),
    ] : [],
  };
}
