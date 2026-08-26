import { initialManagedMakerPrice, type ManagedMakerQuote } from './managed-maker';
import { effectiveQueueAhead } from './paper-fill-calibration';
import type { PaperMakerSimulationResult } from './paper-maker-simulation';
import type { KalshiTradePrint } from './kalshi-market-data';
import type { MarketId, PositionSide, StrategyId, TradingProviderId } from './types';

/** Detached prospective timing family. It has no paper-status, bankroll, or order authority. */
export const PAPER_EXECUTION_TIMING_SHADOW_VERSION = 'paper-execution-timing-shadow-v1' as const;
export const PAPER_CREATE_DELAY_MS = 400;
export const PAPER_ACKNOWLEDGEMENT_DELAY_MS = 250;
export const PAPER_FINAL_EVIDENCE_GRACE_MS = 3_000;
export const PAPER_TIMING_MAX_INTENTS_PER_CALCULATION = 6;
export const PAPER_TIMING_MAX_PRINTS_PER_INTENT = 500;

export interface PaperExecutionTimingDecision {
  version: typeof PAPER_EXECUTION_TIMING_SHADOW_VERSION;
  id: string;
  recordedAt: string;
  orderId: string;
  mirrorPairId: string;
  strategyId: StrategyId;
  marketId: MarketId;
  providerId: TradingProviderId;
  providerVariantId?: string;
  paperExecutionVersion: string;
  contractId: string;
  symbol: string;
  side: PositionSide;
  closesAt: string;
  calculationAt: string;
  requestedCount: number;
  maximumPrice: number;
  requestedStart: number;
  createDelayMs: typeof PAPER_CREATE_DELAY_MS;
  acknowledgementDelayMs: typeof PAPER_ACKNOWLEDGEMENT_DELAY_MS;
  finalEvidenceGraceMs: typeof PAPER_FINAL_EVIDENCE_GRACE_MS;
}

export interface PaperTimingQuoteEvidence {
  requestedAt: string;
  observedAt: string;
  selectedBid: number;
  selectedAsk: number;
  limitPrice: number;
}

export interface PaperAcceptanceTimingResult {
  status: 'accepted' | 'post_only_race' | 'unavailable';
  completedAt: string;
  createQuote?: PaperTimingQuoteEvidence;
  acknowledgementQuote?: PaperTimingQuoteEvidence;
  reason?: string;
}

export interface PaperGraceReplayResult {
  filledCount: number;
  purchaseCents: number;
  averagePrice: number;
  consumingPrints: number;
}

export interface PaperExecutionGraceResult {
  status: 'available' | 'unavailable';
  completedAt: string;
  acceptedAt?: string;
  restingUntil?: string;
  graceReadRequestedAt?: string;
  retainedPrints?: KalshiTradePrint[];
  production: PaperGraceReplayResult;
  eventTimeReplay?: PaperGraceReplayResult;
  reason?: string;
}

export interface PaperExecutionTimingRecord {
  decision: PaperExecutionTimingDecision;
  acceptance?: PaperAcceptanceTimingResult;
  grace?: PaperExecutionGraceResult;
}

export type PaperExecutionTimingEvent =
  | { op: 'decision'; value: PaperExecutionTimingDecision }
  | { op: 'acceptance'; id: string; value: PaperAcceptanceTimingResult }
  | { op: 'grace'; id: string; value: PaperExecutionGraceResult };

export function paperExecutionTimingShadowId(orderId: string): string {
  return `${PAPER_EXECUTION_TIMING_SHADOW_VERSION}:${orderId}`;
}

export function evaluateAcceptanceTimingShadow(input: {
  createQuote: ManagedMakerQuote;
  acknowledgementQuote: ManagedMakerQuote;
  maximumPrice: number;
  requestedStart: number;
}): { status: 'accepted' | 'post_only_race'; limitPrice: number } | { status: 'unavailable'; reason: string } {
  const limitPrice = initialManagedMakerPrice({
    quote: input.createQuote, maximumPrice: input.maximumPrice, requestedStart: input.requestedStart,
  });
  if (!(limitPrice > 0)) return { status: 'unavailable', reason: 'No passive candidate limit fit below the create quote ask.' };
  return input.acknowledgementQuote.ask <= limitPrice + 1e-9
    ? { status: 'post_only_race', limitPrice }
    : { status: 'accepted', limitPrice };
}

interface ReplayRung {
  startsAtMs: number;
  limitPrice: number;
  queueAhead?: number;
}

function replayRungs(result: PaperMakerSimulationResult, queueClearFraction: number): ReplayRung[] {
  const rungs: ReplayRung[] = [];
  for (const observation of result.observations) {
    if (observation.event !== 'paper_submitted' && observation.event !== 'management_quote'
      && observation.event !== 'amend_accepted') continue;
    const at = Date.parse(observation.at);
    const limitPrice = observation.limitPrice;
    if (!Number.isFinite(at) || !Number.isFinite(limitPrice) || !(limitPrice! > 0)) continue;
    if (observation.event === 'management_quote') {
      const current = rungs.at(-1);
      if (current && Math.abs(current.limitPrice - limitPrice!) <= 1e-9
        && current.queueAhead === undefined && observation.displayedAhead !== undefined) {
        current.queueAhead = effectiveQueueAhead(observation.displayedAhead, queueClearFraction);
      }
      continue;
    }
    const queueAhead = effectiveQueueAhead(observation.displayedAhead, queueClearFraction);
    const current = rungs.at(-1);
    if (current && Math.abs(current.limitPrice - limitPrice!) <= 1e-9) {
      if (current.queueAhead === undefined && queueAhead !== undefined) current.queueAhead = queueAhead;
      continue;
    }
    rungs.push({ startsAtMs: at, limitPrice: limitPrice!, queueAhead });
  }
  return rungs;
}

/**
 * Replays the complete grace-read print set by venue event time. A print after `restingUntil` is never
 * admitted, and a print first exposed late still faces the limit and queue active when it occurred.
 */
export function replayPaperMakerAtEventTime(input: {
  side: PositionSide;
  requestedCount: number;
  queueClearFraction: number;
  simulation: PaperMakerSimulationResult;
  prints: KalshiTradePrint[];
}): PaperGraceReplayResult | undefined {
  const acceptedAtMs = Date.parse(input.simulation.submittedAt);
  const restingUntilMs = Date.parse(input.simulation.restingUntil);
  if (!Number.isFinite(acceptedAtMs) || !Number.isFinite(restingUntilMs) || restingUntilMs < acceptedAtMs) return undefined;
  const rungs = replayRungs(input.simulation, input.queueClearFraction);
  if (!rungs.length || rungs[0].startsAtMs > acceptedAtMs + 1e-6) return undefined;

  const consumingTakerSide = input.side === 'UP' ? 'no' : 'yes';
  const seen = new Set<string>();
  let rungIndex = 0, filledCount = 0, purchaseCents = 0, consumingPrints = 0;
  let queueAhead = rungs[0].queueAhead;
  const ordered = [...input.prints].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)
    || left.id.localeCompare(right.id));
  for (const print of ordered) {
    if (seen.has(print.id)) continue;
    seen.add(print.id);
    const at = Date.parse(print.at);
    if (!Number.isFinite(at) || at + 1e-6 < acceptedAtMs || at - 1e-6 > restingUntilMs) continue;
    while (rungIndex + 1 < rungs.length && rungs[rungIndex + 1].startsAtMs <= at + 1e-6) {
      rungIndex += 1;
      queueAhead = rungs[rungIndex].queueAhead;
    }
    if (print.takerSide !== consumingTakerSide || queueAhead === undefined) continue;
    const selectedPrice = input.side === 'UP' ? print.yesPrice : print.noPrice;
    if (selectedPrice > rungs[rungIndex].limitPrice + 1e-9) continue;
    consumingPrints += 1;
    let available = print.count;
    const ahead = Math.min(queueAhead, available);
    queueAhead = Math.max(0, queueAhead - ahead);
    available -= ahead;
    if (available <= 1e-8) continue;
    const fill = Math.min(available, input.requestedCount - filledCount);
    if (fill <= 1e-8) continue;
    filledCount += fill;
    purchaseCents += fill * rungs[rungIndex].limitPrice * 100;
    if (filledCount + 1e-8 >= input.requestedCount) {
      filledCount = input.requestedCount;
      break;
    }
  }
  const roundedFilledCount = Number(filledCount.toFixed(2));
  return {
    filledCount: roundedFilledCount,
    purchaseCents,
    averagePrice: filledCount > 0 ? purchaseCents / filledCount / 100 : 0,
    consumingPrints,
  };
}

export function replayPaperExecutionTimingEvents(
  existing: PaperExecutionTimingRecord[], events: PaperExecutionTimingEvent[],
): PaperExecutionTimingRecord[] {
  const records = new Map(existing.map((record) => [record.decision.id, structuredClone(record)]));
  for (const event of events) {
    if (event.op === 'decision') {
      if (!records.has(event.value.id)) records.set(event.value.id, { decision: structuredClone(event.value) });
      continue;
    }
    const record = records.get(event.id);
    if (!record) continue;
    if (event.op === 'acceptance' && !record.acceptance) record.acceptance = structuredClone(event.value);
    if (event.op === 'grace' && !record.grace) record.grace = structuredClone(event.value);
  }
  return [...records.values()];
}
