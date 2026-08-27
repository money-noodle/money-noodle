import 'server-only';
import { fetchKalshiManagedMakerPriceQuote, fetchKalshiTradePrintsSince } from './kalshi-market-data';
import {
  PAPER_ACKNOWLEDGEMENT_DELAY_MS, PAPER_CREATE_DELAY_MS, PAPER_EXECUTION_TIMING_SHADOW_VERSION,
  PAPER_FINAL_EVIDENCE_GRACE_MS, PAPER_TIMING_MAX_INTENTS_PER_CALCULATION, PAPER_TIMING_MAX_PRINTS_PER_INTENT,
  evaluateAcceptanceTimingShadow, paperExecutionTimingShadowId, replayPaperMakerAtEventTime,
  type PaperExecutionTimingDecision, type PaperTimingQuoteEvidence,
} from './paper-execution-timing-shadow';
import {
  recordPaperAcceptanceTimingResult, recordPaperExecutionGraceResult, recordPaperExecutionTimingDecision,
} from './paper-execution-timing-shadow-store';
import { paperMakerEventTimeMicros, type PaperMakerSimulationResult } from './paper-maker-simulation';
import type { KalshiTradePrint } from './kalshi-market-data';
import type { PaperOrder } from './types';

const assignmentKey = Symbol.for('money-noodle.paper-execution-timing-shadow-assignments');
const globals = globalThis as typeof globalThis & { [assignmentKey]?: Set<string> };
const assigned = globals[assignmentKey] ??= new Set<string>();
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface PaperExecutionTimingObserverDependencies {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
  quote?: typeof fetchKalshiManagedMakerPriceQuote;
  tradesSince?: typeof fetchKalshiTradePrintsSince;
  recordDecision?: typeof recordPaperExecutionTimingDecision;
  recordAcceptance?: typeof recordPaperAcceptanceTimingResult;
  recordGrace?: typeof recordPaperExecutionGraceResult;
}

function timingDecision(order: PaperOrder, recordedAt: string): PaperExecutionTimingDecision | undefined {
  const mirrorPairId = order.executionMirrorPair?.id;
  const paperExecutionVersion = order.entryDecision?.executionPolicyVersion;
  const maximumPrice = order.approvedMaximumPrice ?? order.askPrice;
  const requestedStart = order.issuanceBidPrice ?? order.bidPrice;
  if (!mirrorPairId || !paperExecutionVersion || !Number.isFinite(maximumPrice) || !Number.isFinite(requestedStart)) return undefined;
  return {
    version: PAPER_EXECUTION_TIMING_SHADOW_VERSION,
    id: paperExecutionTimingShadowId(order.id), recordedAt, orderId: order.id, mirrorPairId,
    strategyId: order.strategyId ?? 'edge-binary-buy', marketId: order.marketId ?? 'crypto-15m',
    providerId: order.providerId ?? 'kalshi', providerVariantId: order.providerVariantId,
    paperExecutionVersion, contractId: order.contractId, symbol: order.symbol, side: order.side,
    closesAt: order.closesAt, calculationAt: order.calculationAt,
    requestedCount: order.requestedQuantity ?? order.quantity, maximumPrice, requestedStart,
    createDelayMs: PAPER_CREATE_DELAY_MS, acknowledgementDelayMs: PAPER_ACKNOWLEDGEMENT_DELAY_MS,
    finalEvidenceGraceMs: PAPER_FINAL_EVIDENCE_GRACE_MS,
  };
}

async function waitUntil(targetMs: number, now: () => number, wait: (milliseconds: number) => Promise<unknown>): Promise<void> {
  const remaining = targetMs - now();
  if (remaining > 0) await wait(remaining);
}

function quoteEvidence(requestedAtMs: number, observedAtMs: number, quote: Awaited<ReturnType<typeof fetchKalshiManagedMakerPriceQuote>>, limitPrice: number): PaperTimingQuoteEvidence {
  return {
    requestedAt: new Date(requestedAtMs).toISOString(), observedAt: new Date(observedAtMs).toISOString(),
    selectedBid: quote.bid, selectedAsk: quote.ask, limitPrice,
  };
}

/** One precommitted create/acknowledgement candidate. It never reads live order state. */
export async function observePaperAcceptanceTiming(
  order: PaperOrder, dependencies: PaperExecutionTimingObserverDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? sleep;
  const quote = dependencies.quote ?? fetchKalshiManagedMakerPriceQuote;
  const recordDecision = dependencies.recordDecision ?? recordPaperExecutionTimingDecision;
  const recordAcceptance = dependencies.recordAcceptance ?? recordPaperAcceptanceTimingResult;
  const startedAtMs = now();
  const decision = timingDecision(order, new Date(startedAtMs).toISOString());
  if (!decision) return;
  await recordDecision(decision);
  try {
    await waitUntil(startedAtMs + PAPER_CREATE_DELAY_MS, now, wait);
    const createRequestedAtMs = now();
    const createQuote = await quote(order.contractId, order.side);
    const createObservedAtMs = now();
    const provisional = evaluateAcceptanceTimingShadow({
      createQuote, acknowledgementQuote: createQuote,
      maximumPrice: decision.maximumPrice, requestedStart: decision.requestedStart,
    });
    if (provisional.status === 'unavailable') {
      await recordAcceptance(decision.id, {
        status: 'unavailable', completedAt: new Date(now()).toISOString(), reason: provisional.reason,
      });
      return;
    }
    await waitUntil(createObservedAtMs + PAPER_ACKNOWLEDGEMENT_DELAY_MS, now, wait);
    const acknowledgementRequestedAtMs = now();
    const acknowledgementQuote = await quote(order.contractId, order.side);
    const acknowledgementObservedAtMs = now();
    const result = evaluateAcceptanceTimingShadow({
      createQuote, acknowledgementQuote,
      maximumPrice: decision.maximumPrice, requestedStart: decision.requestedStart,
    });
    if (result.status === 'unavailable') {
      await recordAcceptance(decision.id, {
        status: 'unavailable', completedAt: new Date(now()).toISOString(), reason: result.reason,
      });
      return;
    }
    await recordAcceptance(decision.id, {
      status: result.status, completedAt: new Date(now()).toISOString(),
      createQuote: quoteEvidence(createRequestedAtMs, createObservedAtMs, createQuote, result.limitPrice),
      acknowledgementQuote: quoteEvidence(
        acknowledgementRequestedAtMs, acknowledgementObservedAtMs, acknowledgementQuote, result.limitPrice,
      ),
    });
  } catch (error) {
    await recordAcceptance(decision.id, {
      status: 'unavailable', completedAt: new Date(now()).toISOString(),
      reason: error instanceof Error ? error.message : 'Timing quote observation failed.',
    });
  }
}

async function recordCapUnavailable(order: PaperOrder, reason: string, dependencies: PaperExecutionTimingObserverDependencies): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const completedAt = new Date(now()).toISOString();
  const decision = timingDecision(order, completedAt);
  if (!decision) return;
  const recordDecision = dependencies.recordDecision ?? recordPaperExecutionTimingDecision;
  await recordDecision(decision);
  await (dependencies.recordAcceptance ?? recordPaperAcceptanceTimingResult)(decision.id, {
    status: 'unavailable', completedAt, reason,
  });
  await (dependencies.recordGrace ?? recordPaperExecutionGraceResult)(decision.id, {
    status: 'unavailable', completedAt,
    production: { filledCount: 0, purchaseCents: 0, averagePrice: 0, consumingPrints: 0 },
    reason,
  });
}

/**
 * Starts at most six detached observers after the paper intents are durable. Caller never awaits the
 * returned work; cap overflow is explicit evidence and makes no venue request.
 */
export function startPaperExecutionTimingObservers(
  orders: PaperOrder[], dependencies: PaperExecutionTimingObserverDependencies = {},
): void {
  const makers = orders.filter((order) => (order.paperEntryRoute ?? order.liquidityRole) === 'maker');
  for (const order of makers.slice(0, PAPER_TIMING_MAX_INTENTS_PER_CALCULATION)) {
    assigned.add(order.id);
    void observePaperAcceptanceTiming(order, dependencies)
      .catch((error) => console.error('Paper acceptance timing observation failed:', error));
  }
  for (const order of makers.slice(PAPER_TIMING_MAX_INTENTS_PER_CALCULATION)) {
    void recordCapUnavailable(order, 'Timing-shadow per-calculation request cap was exhausted.', dependencies)
      .catch((error) => console.error('Paper timing cap evidence failed:', error));
  }
}

function relevantPrints(order: PaperOrder, result: PaperMakerSimulationResult, prints: KalshiTradePrint[]): KalshiTradePrint[] {
  const acceptedAtMicros = Date.parse(result.submittedAt) * 1_000;
  const restingUntilMicros = Date.parse(result.restingUntil) * 1_000;
  const consumingTakerSide = order.side === 'UP' ? 'no' : 'yes';
  const maximumPrice = order.approvedMaximumPrice ?? order.askPrice;
  return prints.filter((print) => {
    const atMicros = paperMakerEventTimeMicros(print.at);
    const selectedPrice = order.side === 'UP' ? print.yesPrice : print.noPrice;
    return atMicros !== undefined && atMicros >= acceptedAtMicros && atMicros <= restingUntilMicros
      && print.takerSide === consumingTakerSide && selectedPrice <= maximumPrice + 1e-9;
  });
}

/** One final read after expiry; venue event time, not response time, owns eligibility. */
export async function observePaperFinalEvidenceGrace(
  order: PaperOrder, result: PaperMakerSimulationResult,
  dependencies: PaperExecutionTimingObserverDependencies = {},
): Promise<void> {
  if (!assigned.has(order.id)) return;
  assigned.delete(order.id);
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? sleep;
  const recordGrace = dependencies.recordGrace ?? recordPaperExecutionGraceResult;
  const production = {
    filledCount: result.filledCount, purchaseCents: result.purchaseCents, averagePrice: result.averagePrice,
    consumingPrints: result.observations.reduce((sum, observation) => sum + (observation.consumingTradeCount ?? 0), 0),
  };
  const id = paperExecutionTimingShadowId(order.id);
  try {
    const restingUntilMs = Date.parse(result.restingUntil);
    if (!Number.isFinite(restingUntilMs)) throw new Error('Paper resting horizon was malformed.');
    await waitUntil(restingUntilMs + PAPER_FINAL_EVIDENCE_GRACE_MS, now, wait);
    const graceReadRequestedAt = new Date(now()).toISOString();
    const prints = relevantPrints(order, result,
      await (dependencies.tradesSince ?? fetchKalshiTradePrintsSince)(order.contractId, Date.parse(result.submittedAt)));
    if (prints.length > PAPER_TIMING_MAX_PRINTS_PER_INTENT) {
      await recordGrace(id, {
        status: 'unavailable', completedAt: new Date(now()).toISOString(),
        acceptedAt: result.submittedAt, restingUntil: result.restingUntil, graceReadRequestedAt, production,
        reason: `In-horizon print evidence exceeded the ${PAPER_TIMING_MAX_PRINTS_PER_INTENT}-print bound.`,
      });
      return;
    }
    const replay = replayPaperMakerAtEventTime({
      side: order.side, requestedCount: order.requestedQuantity ?? order.quantity,
      queueClearFraction: order.paperFillCalibration?.queueClearFraction ?? 0,
      simulation: result, prints,
    });
    await recordGrace(id, replay ? {
      status: 'available', completedAt: new Date(now()).toISOString(),
      acceptedAt: result.submittedAt, restingUntil: result.restingUntil, graceReadRequestedAt,
      retainedPrints: prints, production, eventTimeReplay: replay,
    } : {
      status: 'unavailable', completedAt: new Date(now()).toISOString(),
      acceptedAt: result.submittedAt, restingUntil: result.restingUntil, graceReadRequestedAt, production,
      reason: 'Paper limit/queue timeline was incomplete for event-time replay.',
    });
  } catch (error) {
    await recordGrace(id, {
      status: 'unavailable', completedAt: new Date(now()).toISOString(), production,
      acceptedAt: result.submittedAt, restingUntil: result.restingUntil,
      reason: error instanceof Error ? error.message : 'Final evidence grace failed.',
    });
  }
}

export function recordPaperFinalEvidenceUnavailable(
  order: PaperOrder, reason: string, dependencies: PaperExecutionTimingObserverDependencies = {},
): void {
  if (!assigned.has(order.id)) return;
  assigned.delete(order.id);
  const completedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
  void (dependencies.recordGrace ?? recordPaperExecutionGraceResult)(paperExecutionTimingShadowId(order.id), {
    status: 'unavailable', completedAt,
    production: { filledCount: 0, purchaseCents: 0, averagePrice: 0, consumingPrints: 0 },
    reason,
  }).catch((error) => console.error('Paper final-evidence unavailability write failed:', error));
}

export function resetPaperExecutionTimingObserverForTests(): void {
  assigned.clear();
}
