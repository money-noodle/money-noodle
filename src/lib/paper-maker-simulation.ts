import { initialManagedMakerPrice, MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS, nextManagedMakerPrice, type ManagedMakerQuote } from './managed-maker';
import { selectedSideDepth } from './order-book-depth';
import type { EntryExecutionObservation, PositionSide } from './types';
import type { KalshiTradePrint } from './kalshi-market-data';
import {
  PAPER_NEUTRAL_EXECUTION_VERSION, effectiveQueueAhead, type PaperFillCalibration,
} from './paper-fill-calibration';

/**
 * Durable identity stamped on paper edge-policy orders using this execution simulation.
 *
 * **v7 enforces the exact maker horizon.** V6 added neutral bounded calibration while retaining the
 * fully conservative displayed-depth queue. V7 keeps that queue arithmetic and excludes every public
 * trade whose venue event time is after the inclusive 12-second `restingUntil` boundary. Existing
 * generations remain immutable evidence; affected v6 timing rows are unavailable rather than rewritten.
 */
export const PAPER_MANAGED_MAKER_EXECUTION_VERSION = PAPER_NEUTRAL_EXECUTION_VERSION;

export interface PaperMakerQueueState {
  side: PositionSide;
  requestedCount: number;
  currentLimit: number;
  queueAhead?: number;
  filledCount: number;
  purchaseCents: number;
  observedTradeIds: Set<string>;
}

export interface PaperMakerTradeEvidence {
  consumingTradeCount: number;
  consumingTradeQuantity: number;
  firstConsumingTradeAt?: string;
  lastConsumingTradeAt?: string;
  queueAheadBefore?: number;
  queueAheadAfter?: number;
  fillAdded: number;
}

export interface PaperMakerSimulationResult {
  submittedAt: string;
  completedAt: string;
  restingUntil: string;
  initialPrice: number;
  finalPrice: number;
  filledCount: number;
  averagePrice: number;
  purchaseCents: number;
  evidenceComplete: boolean;
  observations: EntryExecutionObservation[];
}

export interface PaperMakerSimulationDependencies {
  quote: () => Promise<ManagedMakerQuote>;
  tradesSince: (sinceMs: number) => Promise<KalshiTradePrint[]>;
  wait?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  checks?: number;
  pollMs?: number;
  /** Synchronous observability hook for the on-demand quote; it must not perform I/O. */
  onInitialQuoteSettled?: (error?: unknown) => void;
  /** Versioned calibration applied whenever paper joins a queue. Never read from a live fill. */
  calibration?: PaperFillCalibration;
}

/**
 * Applies aggressive public trade prints to our conservative queue proxy. A selected-side resting bid
 * is consumed by a taker buying the opposite outcome. Ask touch alone is deliberately not a fill.
 */
export function paperMakerEventTimeMicros(value: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return undefined;
  const secondMs = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(secondMs)) return undefined;
  const fractionalMicros = Number((match[2] ?? '').padEnd(6, '0'));
  const result = secondMs * 1_000 + fractionalMicros;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function paperMakerEventWithinHorizon(
  eventAtMicros: number, acceptedAtMicros: number, restingUntilMicros: number,
): boolean {
  return Number.isSafeInteger(eventAtMicros) && Number.isSafeInteger(acceptedAtMicros)
    && Number.isSafeInteger(restingUntilMicros) && restingUntilMicros >= acceptedAtMicros
    && eventAtMicros >= acceptedAtMicros && eventAtMicros <= restingUntilMicros;
}

export function applyTradePrintsToPaperQueue(
  state: PaperMakerQueueState, trades: KalshiTradePrint[], acceptedAtMs: number, restingUntilMs: number,
): PaperMakerTradeEvidence {
  const consumingTakerSide = state.side === 'UP' ? 'no' : 'yes';
  const queueAheadBefore = state.queueAhead;
  const filledBefore = state.filledCount;
  let consumingTradeCount = 0, consumingTradeQuantity = 0;
  let firstConsumingTradeAt: string | undefined, lastConsumingTradeAt: string | undefined;
  for (const trade of [...trades].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))) {
    if (state.observedTradeIds.has(trade.id)) continue;
    const eventAtMicros = paperMakerEventTimeMicros(trade.at);
    if (eventAtMicros === undefined
      || !paperMakerEventWithinHorizon(eventAtMicros, acceptedAtMs * 1_000, restingUntilMs * 1_000)) continue;
    state.observedTradeIds.add(trade.id);
    if (trade.takerSide !== consumingTakerSide) continue;
    const selectedTradePrice = state.side === 'UP' ? trade.yesPrice : trade.noPrice;
    if (selectedTradePrice > state.currentLimit + 1e-9 || state.queueAhead === undefined) continue;
    consumingTradeCount += 1;
    consumingTradeQuantity += trade.count;
    firstConsumingTradeAt ??= trade.at;
    lastConsumingTradeAt = trade.at;
    let available = trade.count;
    const ahead = Math.min(state.queueAhead, available);
    state.queueAhead = Math.max(0, state.queueAhead - ahead);
    available -= ahead;
    if (available <= 1e-8) continue;
    const fill = Math.min(available, state.requestedCount - state.filledCount);
    if (fill <= 1e-8) continue;
    // Had our superior/equal bid really been present, an aggressive seller would execute at our limit,
    // not at the lower print produced by a book that necessarily omits the hypothetical paper order.
    state.filledCount += fill;
    state.purchaseCents += fill * state.currentLimit * 100;
    if (state.filledCount + 1e-8 >= state.requestedCount) {
      state.filledCount = state.requestedCount;
      break;
    }
  }
  return {
    consumingTradeCount,
    consumingTradeQuantity,
    firstConsumingTradeAt,
    lastConsumingTradeAt,
    queueAheadBefore,
    queueAheadAfter: state.queueAhead,
    fillAdded: state.filledCount - filledBefore,
  };
}

/** Independent two-second paper manager using live's exact pricing path and public queue/trade evidence. */
export async function simulateManagedPaperMaker(input: {
  side: PositionSide;
  requestedCount: number;
  maximumPrice: number;
  requestedStart?: number;
}, dependencies: PaperMakerSimulationDependencies): Promise<PaperMakerSimulationResult> {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const checks = dependencies.checks ?? MAKER_MANAGEMENT_CHECKS;
  const pollMs = dependencies.pollMs ?? MAKER_MANAGEMENT_POLL_MS;
  let initialQuote: ManagedMakerQuote;
  try {
    initialQuote = await dependencies.quote();
    dependencies.onInitialQuoteSettled?.();
  } catch (error) {
    dependencies.onInitialQuoteSettled?.(error);
    throw error;
  }
  const initialPrice = initialManagedMakerPrice({
    quote: initialQuote, maximumPrice: input.maximumPrice, requestedStart: input.requestedStart,
  });
  if (!(initialPrice > 0)) throw new Error(`No passive paper ${input.side} bid fits below the exact-contract ask.`);
  const acceptedAtMs = now();
  const submittedAt = new Date(acceptedAtMs).toISOString();
  const restingUntil = new Date(acceptedAtMs + checks * pollMs).toISOString();
  const initialDepth = selectedSideDepth(initialQuote.orderBook, input.side, initialQuote.bid, initialQuote.ask, initialPrice);
  const queueClearFraction = dependencies.calibration?.queueClearFraction ?? 0;
  const initialAhead = effectiveQueueAhead(initialDepth.displayedAhead, queueClearFraction);
  const observations: EntryExecutionObservation[] = [{
    at: submittedAt, event: 'paper_submitted', selectedBid: initialQuote.bid, selectedAsk: initialQuote.ask,
    spread: initialQuote.ask - initialQuote.bid, limitPrice: initialPrice, remainingCount: input.requestedCount,
    touched: initialQuote.ask <= initialPrice + 1e-9, ...initialDepth,
  }];
  const state: PaperMakerQueueState = {
    side: input.side, requestedCount: input.requestedCount, currentLimit: initialPrice,
    queueAhead: initialAhead, filledCount: 0, purchaseCents: 0, observedTradeIds: new Set(),
  };
  let latestQuote = initialQuote;
  let finalTradeReadSucceeded = false;

  for (let attempt = 0; attempt < checks; attempt += 1) {
    await wait(pollMs);
    const readStartedAt = new Date(now()).toISOString();
    const tradeRead = dependencies.tradesSince(acceptedAtMs);
    const quoteRead = attempt < checks - 1 ? dependencies.quote() : Promise.resolve<ManagedMakerQuote | undefined>(undefined);
    const [tradeResult, quoteResult] = await Promise.allSettled([tradeRead, quoteRead]);
    finalTradeReadSucceeded = tradeResult.status === 'fulfilled';
    if (tradeResult.status === 'fulfilled') {
      const evidence = applyTradePrintsToPaperQueue(state, tradeResult.value, acceptedAtMs, acceptedAtMs + checks * pollMs);
      observations.push({
        at: new Date(now()).toISOString(), event: 'paper_trade_evidence', limitPrice: state.currentLimit,
        filledCount: Number(state.filledCount.toFixed(2)),
        remainingCount: Number((input.requestedCount - state.filledCount).toFixed(2)),
        readStartedAt,
        ...evidence,
      });
    }
    if (state.filledCount + 1e-8 >= state.requestedCount) break;
    if (attempt >= checks - 1 || quoteResult.status !== 'fulfilled' || !quoteResult.value) continue;

    latestQuote = quoteResult.value;
    const depth = selectedSideDepth(latestQuote.orderBook, input.side, latestQuote.bid, latestQuote.ask, state.currentLimit);
    observations.push({
      at: new Date(now()).toISOString(), event: 'management_quote', selectedBid: latestQuote.bid,
      selectedAsk: latestQuote.ask, spread: latestQuote.ask - latestQuote.bid, limitPrice: state.currentLimit,
      filledCount: Number(state.filledCount.toFixed(2)), remainingCount: Number((input.requestedCount - state.filledCount).toFixed(2)),
      touched: latestQuote.ask <= state.currentLimit + 1e-9, ...depth,
    });
    if (state.queueAhead === undefined && depth.displayedAhead !== undefined) {
      state.queueAhead = effectiveQueueAhead(depth.displayedAhead, queueClearFraction);
    }
    const nextPrice = nextManagedMakerPrice({
      quote: latestQuote, maximumPrice: input.maximumPrice, currentPrice: state.currentLimit,
      managementAttempt: attempt, managementChecks: checks,
    });
    if (nextPrice <= state.currentLimit + 1e-10) continue;
    state.currentLimit = nextPrice;
    const amendedDepth = selectedSideDepth(latestQuote.orderBook, input.side, latestQuote.bid, latestQuote.ask, nextPrice);
    // Moving up loses the old queue position and joins behind the calibrated displayed proxy at the
    // new price or better. The neutral fraction is exact prior behavior; private rank remains unknown.
    state.queueAhead = effectiveQueueAhead(amendedDepth.displayedAhead, queueClearFraction);
    observations.push({
      at: new Date(now()).toISOString(), event: 'amend_accepted', selectedBid: latestQuote.bid,
      selectedAsk: latestQuote.ask, spread: latestQuote.ask - latestQuote.bid, limitPrice: nextPrice,
      filledCount: Number(state.filledCount.toFixed(2)), remainingCount: Number((input.requestedCount - state.filledCount).toFixed(2)),
      touched: latestQuote.ask <= nextPrice + 1e-9, ...amendedDepth,
    });
  }

  const completedAtMs = now();
  const filledCount = Number(state.filledCount.toFixed(2));
  const averagePrice = state.filledCount > 0 ? state.purchaseCents / state.filledCount / 100 : 0;
  observations.push(filledCount > 0 ? {
    at: new Date(completedAtMs).toISOString(), event: 'paper_fill', selectedBid: latestQuote.bid,
    selectedAsk: latestQuote.ask, spread: latestQuote.ask - latestQuote.bid, limitPrice: state.currentLimit,
    filledCount, remainingCount: 0, restingDurationMs: completedAtMs - acceptedAtMs,
    touched: latestQuote.ask <= state.currentLimit + 1e-9,
  } : {
    at: new Date(completedAtMs).toISOString(), event: 'paper_expired', limitPrice: state.currentLimit,
    filledCount: 0, remainingCount: 0, restingDurationMs: completedAtMs - acceptedAtMs,
    reason: finalTradeReadSucceeded ? 'No queue-qualified aggressive trade volume reached the simulated order.' : 'Final public trade evidence was unavailable; this attempt is not classified as a fill miss.',
  });
  return {
    submittedAt, completedAt: new Date(completedAtMs).toISOString(), restingUntil,
    initialPrice, finalPrice: state.currentLimit, filledCount,
    averagePrice, purchaseCents: state.purchaseCents, evidenceComplete: finalTradeReadSucceeded,
    observations,
  };
}
