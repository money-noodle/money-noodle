/**
 * Prospective evidence for the two-second maker cutover, accepted as DEC-20260828-02.
 *
 * The retrospective reading reversed sign inside a single day, so the question is settled prospectively or
 * not at all. The frozen family separates the two changes the proposal bundles — a shorter maker life and a
 * taker fallback — because a gain that the abandon arm also produces was never about crossing the spread.
 *
 * Observation-only. Nothing here may reach an order function, and the accepted execution rule is unchanged.
 */
import { clusterByWindow } from './action-counterfactual';
import { MAX_ENTRY_PRICE } from './prediction-policy';
import { estimatePaperFill, venueFeeCents } from './venue-fill';
import type { ExecutionMode, PaperOrder, PositionSide } from './types';

export const MAKER_LIFECYCLE_SENTINEL_VERSION = 'maker-lifecycle-sentinel-v1';
export const MAKER_LIFECYCLE_CUTOVER_SECONDS = 2;
export const MAKER_LIFECYCLE_CUSHION_TICKS = 2;
export const MAKER_LIFECYCLE_TICK = 0.01;
export const MAKER_LIFECYCLE_REVIEW_WINDOWS = 60;
export const MAKER_LIFECYCLE_MINIMUM_DIVERGENT_WINDOWS = 20;
export const MAKER_LIFECYCLE_MINIMUM_COVERAGE = 0.9;

export type MakerLifecycleCandidateId = 'maker-expire2s-taker-v1' | 'maker-expire2s-abandon-v1';
export const MAKER_LIFECYCLE_CANDIDATE_IDS: MakerLifecycleCandidateId[] = ['maker-expire2s-taker-v1', 'maker-expire2s-abandon-v1'];

/** Why an arm bought nothing. A missing quote is unavailable evidence, never a decision not to trade. */
export type MakerLifecycleNoTradeReason =
  | 'filled-before-cutover' | 'no-quote-at-cutover' | 'above-price-ceiling' | 'insufficient-depth'
  | 'cannot-size' | 'arm-does-not-take';

export interface MakerLifecycleArmDecision {
  candidateId: MakerLifecycleCandidateId;
  /** True when the arm acquired a position in the replay. */
  acquired: boolean;
  noTradeReason?: MakerLifecycleNoTradeReason;
  limitPrice?: number;
  fillPrice?: number;
  quantity?: number;
  costCents?: number;
  feeCents?: number;
}

export interface MakerLifecycleSentinel {
  id: string;
  sentinelVersion: typeof MAKER_LIFECYCLE_SENTINEL_VERSION;
  recordedAt: string;
  orderId: string;
  executionMode: ExecutionMode;
  strategyId: string;
  symbol: string;
  side: PositionSide;
  contractId: string;
  closesAt: string;
  /** Absent when no observation existed at the cutover; the cycle is then unavailable, not a refusal. */
  cutover?: {
    at: string;
    secondsAfterAccepted: number;
    filledCountAtCutover: number;
    selectedBid: number;
    selectedAsk: number;
    bestAskDepth?: number;
  };
  productionFilled: boolean;
  productionQuantity: number;
  arms: MakerLifecycleArmDecision[];
  outcome?: PositionSide;
  resolvedAt?: string;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Floors onto the venue ladder, then applies the absolute production ceiling. Never rounds a price up past it. */
export function makerLifecycleTakerLimit(ask: number): number | null {
  if (!finite(ask) || ask <= 0) return null;
  if (ask > MAX_ENTRY_PRICE + 1e-9) return null;
  const advanced = ask + MAKER_LIFECYCLE_CUSHION_TICKS * MAKER_LIFECYCLE_TICK;
  return Math.min(MAX_ENTRY_PRICE, Number(advanced.toFixed(2)));
}

/**
 * Builds the frozen arm decisions from one terminal maker order. Called before settlement is known, so no
 * arm can be tuned to an outcome.
 */
export function makerLifecycleSentinelFromOrder(order: PaperOrder, recordedAt: string): MakerLifecycleSentinel | null {
  const observations = order.entryExecutionObservations ?? [];
  const accepted = observations.find((observation) => observation.event === 'accepted');
  const terminal = [...observations].reverse().find((observation) => observation.event === 'terminal_fill');
  // Fail closed on a row that cannot be narrowed by strategy: money aggregations must stay separable.
  if (!accepted || !terminal || !order.contractId || !order.strategyId) return null;

  const acceptedMs = Date.parse(accepted.at);
  const poll = observations.find((observation) => observation.event === 'management_quote'
    && finite(observation.selectedAsk) && finite(observation.selectedBid)
    && (Date.parse(observation.at) - acceptedMs) / 1000 >= MAKER_LIFECYCLE_CUTOVER_SECONDS);

  const productionQuantity = finite(terminal.filledCount) ? terminal.filledCount : 0;
  const base = {
    id: `${MAKER_LIFECYCLE_SENTINEL_VERSION}:${order.executionMode}:${order.id}`,
    sentinelVersion: MAKER_LIFECYCLE_SENTINEL_VERSION as typeof MAKER_LIFECYCLE_SENTINEL_VERSION,
    recordedAt, orderId: order.id, executionMode: order.executionMode,
    strategyId: order.strategyId as string, symbol: order.symbol, side: order.side,
    contractId: order.contractId, closesAt: order.closesAt,
    productionFilled: productionQuantity > 0, productionQuantity,
  };

  if (!poll) {
    // No usable quote at the cutover: unavailable evidence. Both arms record it identically.
    return { ...base, arms: MAKER_LIFECYCLE_CANDIDATE_IDS.map((candidateId) => ({ candidateId, acquired: false, noTradeReason: 'no-quote-at-cutover' as const })) };
  }

  const filledAtCutover = finite(poll.filledCount) ? poll.filledCount : 0;
  const cutover = {
    at: poll.at,
    secondsAfterAccepted: Number(((Date.parse(poll.at) - acceptedMs) / 1000).toFixed(3)),
    filledCountAtCutover: filledAtCutover,
    selectedBid: poll.selectedBid!,
    selectedAsk: poll.selectedAsk!,
    bestAskDepth: finite(poll.bestAskDepth) ? poll.bestAskDepth : undefined,
  };

  const arms: MakerLifecycleArmDecision[] = MAKER_LIFECYCLE_CANDIDATE_IDS.map((candidateId) => {
    if (filledAtCutover > 0) return { candidateId, acquired: false, noTradeReason: 'filled-before-cutover' };
    if (candidateId === 'maker-expire2s-abandon-v1') return { candidateId, acquired: false, noTradeReason: 'arm-does-not-take' };
    const limitPrice = makerLifecycleTakerLimit(cutover.selectedAsk);
    if (limitPrice === null) return { candidateId, acquired: false, noTradeReason: 'above-price-ceiling' };
    const stakeLimitCents = order.entrySizingDecision?.stakeLimitCents ?? order.stakeCents;
    const size = Number.isInteger(stakeLimitCents) && stakeLimitCents > 0
      ? estimatePaperFill(stakeLimitCents, limitPrice, 'kalshi') : null;
    if (!size) return { candidateId, acquired: false, noTradeReason: 'cannot-size' };
    // A replayed fill never exceeds the depth actually displayed at the touch.
    if (cutover.bestAskDepth !== undefined && cutover.bestAskDepth + 1e-9 < size.quantity) {
      return { candidateId, acquired: false, noTradeReason: 'insufficient-depth' };
    }
    return {
      candidateId, acquired: true, limitPrice, fillPrice: cutover.selectedAsk, quantity: size.quantity,
      costCents: Math.ceil(size.quantity * cutover.selectedAsk * 100 - 1e-9),
      feeCents: venueFeeCents('kalshi', cutover.selectedAsk * 100, size.quantity, 'taker'),
    };
  });

  return { ...base, cutover, arms };
}

export interface MakerLifecycleArmReport {
  candidateId: MakerLifecycleCandidateId | 'production';
  records: number;
  acquisitions: number;
  windows: number;
  divergentWindows: number;
  stakeCents: number;
  pnlCents: number;
  incrementalMeanReturn: number | null;
  incrementalStandardError: number | null;
  reviewUnlocked: boolean;
}

export interface MakerLifecycleTrackReport {
  records: number;
  resolvedRecords: number;
  unavailableRecords: number;
  coverage: number;
  production: MakerLifecycleArmReport;
  candidates: MakerLifecycleArmReport[];
}

export interface MakerLifecycleSentinelReport {
  sentinelVersion: typeof MAKER_LIFECYCLE_SENTINEL_VERSION;
  startedAt: string;
  tracks: Record<ExecutionMode, MakerLifecycleTrackReport>;
}

/** Production's realised result on the same row, in the same whole-cent budget view the arms use. */
function productionResult(sentinel: MakerLifecycleSentinel, order: PaperOrder | undefined): { stake: number; pnl: number } {
  if (!sentinel.productionFilled || !order) return { stake: 0, pnl: 0 };
  return { stake: order.stakeCents ?? 0, pnl: order.pnlCents ?? 0 };
}

function armResult(sentinel: MakerLifecycleSentinel, decision: MakerLifecycleArmDecision): { stake: number; pnl: number } {
  if (!decision.acquired || !sentinel.outcome || decision.quantity === undefined) return { stake: 0, pnl: 0 };
  const cost = decision.costCents ?? 0;
  const fee = decision.feeCents ?? 0;
  const payout = sentinel.outcome === sentinel.side ? Math.floor(decision.quantity * 100 + 1e-9) : 0;
  return { stake: cost + fee, pnl: payout - cost - fee };
}

export function buildMakerLifecycleSentinelReport(input: {
  startedAt: string; sentinels: MakerLifecycleSentinel[]; orders: PaperOrder[];
}): MakerLifecycleSentinelReport {
  const byOrderId = new Map(input.orders.map((order) => [order.id, order]));
  const track = (mode: ExecutionMode): MakerLifecycleTrackReport => {
    const rows = input.sentinels.filter((sentinel) => sentinel.executionMode === mode);
    const resolved = rows.filter((sentinel) => sentinel.outcome);
    const unavailable = rows.filter((sentinel) => !sentinel.cutover);
    const production = resolved.map((sentinel) => ({ sentinel, ...productionResult(sentinel, byOrderId.get(sentinel.orderId)) }));

    const arm = (candidateId: MakerLifecycleCandidateId | 'production'): MakerLifecycleArmReport => {
      const scored = resolved.map((sentinel) => {
        const own = candidateId === 'production'
          ? productionResult(sentinel, byOrderId.get(sentinel.orderId))
          : armResult(sentinel, sentinel.arms.find((item) => item.candidateId === candidateId)
            ?? { candidateId: candidateId as MakerLifecycleCandidateId, acquired: false });
        const base = production.find((item) => item.sentinel.id === sentinel.id) ?? { stake: 0, pnl: 0 };
        return { sentinel, own, divergent: own.pnl !== base.pnl || own.stake !== base.stake, incremental: own.pnl - base.pnl };
      });
      const divergent = scored.filter((item) => item.divergent);
      const cents = clusterByWindow(divergent, (item) => item.sentinel.closesAt, (item) => item.incremental);
      const returns = clusterByWindow(
        divergent.filter((item) => item.own.stake > 0 || item.incremental !== 0),
        (item) => item.sentinel.closesAt,
        (item) => item.incremental / Math.max(1, item.own.stake),
      );
      const windows = new Set(scored.map((item) => item.sentinel.closesAt)).size;
      return {
        candidateId,
        records: scored.length,
        acquisitions: scored.filter((item) => item.own.stake > 0).length,
        windows,
        divergentWindows: cents.windows,
        stakeCents: scored.reduce((sum, item) => sum + item.own.stake, 0),
        pnlCents: scored.reduce((sum, item) => sum + item.own.pnl, 0),
        incrementalMeanReturn: candidateId === 'production' ? null : returns.mean,
        incrementalStandardError: candidateId === 'production' ? null : returns.standardError,
        // Counts alone never unlock a review; coverage and the family-wise correction are applied at review.
        reviewUnlocked: candidateId !== 'production'
          && windows >= MAKER_LIFECYCLE_REVIEW_WINDOWS
          && cents.windows >= MAKER_LIFECYCLE_MINIMUM_DIVERGENT_WINDOWS
          && rows.length > 0 && (rows.length - unavailable.length) / rows.length + 1e-12 >= MAKER_LIFECYCLE_MINIMUM_COVERAGE,
      };
    };

    return {
      records: rows.length,
      resolvedRecords: resolved.length,
      unavailableRecords: unavailable.length,
      coverage: rows.length ? (rows.length - unavailable.length) / rows.length : 0,
      production: arm('production'),
      candidates: MAKER_LIFECYCLE_CANDIDATE_IDS.map(arm),
    };
  };
  return { sentinelVersion: MAKER_LIFECYCLE_SENTINEL_VERSION, startedAt: input.startedAt, tracks: { live: track('live'), paper: track('paper') } };
}
