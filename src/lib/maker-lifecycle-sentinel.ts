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
import { EDGE_BINARY_BUY } from './strategy-registry';
import type { ExecutionMode, PaperOrder, PositionSide, StrategyId } from './types';

export const MAKER_LIFECYCLE_SENTINEL_VERSION = 'maker-lifecycle-sentinel-v1';
export const MAKER_LIFECYCLE_CUTOVER_SECONDS = 2;
export const MAKER_LIFECYCLE_CUSHION_TICKS = 2;
export const MAKER_LIFECYCLE_TICK = 0.01;
export const MAKER_LIFECYCLE_REVIEW_WINDOWS = 60;
export const MAKER_LIFECYCLE_MINIMUM_DIVERGENT_WINDOWS = 20;
export const MAKER_LIFECYCLE_MINIMUM_COVERAGE = 0.9;

/**
 * The two tracks append different event vocabularies for the same lifecycle moments: live records a venue
 * acknowledgement and a terminal state read, paper records its simulated submission and terminal. Matching
 * only live's names silently produced no paper record at all, so both are named explicitly here.
 */
const RESTING_EVENTS = ['accepted', 'paper_submitted'] as const;
const TERMINAL_EVENTS = ['terminal_fill', 'paper_fill', 'paper_expired'] as const;

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
    /** Queue position ahead of us at the touch. Named as decision-time evidence by DEC-20260828-02. */
    displayedAhead?: number;
  };
  productionFilled: boolean;
  productionQuantity: number;
  arms: MakerLifecycleArmDecision[];
  outcome?: PositionSide;
  resolvedAt?: string;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Reaches the cushion tick by index rather than by repeated addition or `toFixed` rounding (AGENTS.md §1):
 * `toFixed` rounds half-up, which turned an off-ladder ask into three ticks of cushion instead of two.
 * Floors onto the ladder, then applies the absolute production ceiling; never rounds a price up past it.
 */
export function makerLifecycleTakerLimit(ask: number): number | null {
  if (!finite(ask) || ask <= 0) return null;
  if (ask > MAX_ENTRY_PRICE + 1e-9) return null;
  const ticksFromZero = Math.floor(ask / MAKER_LIFECYCLE_TICK + 1e-9) + MAKER_LIFECYCLE_CUSHION_TICKS;
  const advanced = ticksFromZero * MAKER_LIFECYCLE_TICK;
  return Math.min(MAX_ENTRY_PRICE, advanced);
}

/**
 * Builds the frozen arm decisions from one terminal maker order. Called before settlement is known, so no
 * arm can be tuned to an outcome.
 */
export function makerLifecycleSentinelFromOrder(order: PaperOrder, recordedAt: string): MakerLifecycleSentinel | null {
  const observations = order.entryExecutionObservations ?? [];
  const accepted = observations.find((observation) => (RESTING_EVENTS as readonly string[]).includes(observation.event));
  const terminal = [...observations].reverse().find((observation) => (TERMINAL_EVENTS as readonly string[]).includes(observation.event));
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
    displayedAhead: finite(poll.displayedAhead) ? poll.displayedAhead : undefined,
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
    // Book levels carry the 1e-6 tolerance, not the 1e-9 used for prices and cents (AGENTS.md §1).
    if (cutover.bestAskDepth !== undefined && cutover.bestAskDepth + 1e-6 < size.quantity) {
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
function productionResult(sentinel: MakerLifecycleSentinel, order: PaperOrder | undefined): { stake: number; pnl: number } | null {
  // No order means no baseline. Treating it as "production did not trade" would invert the comparison.
  if (!order) return null;
  if (!sentinel.productionFilled) return { stake: 0, pnl: 0 };
  return { stake: order.stakeCents ?? 0, pnl: order.pnlCents ?? 0 };
}

/**
 * Null means the row leaves the scored cohort rather than counting as a decision not to trade.
 *
 * Two cases must not be scored as abstention. A maker that filled before the cutover was never reached by
 * the rule, so the arm inherits production's fill and is identical to it — scoring it as no-trade made both
 * candidates look like "never trade" on exactly the fast fills that pay. And an absent quote is unavailable
 * evidence, already counted against coverage; scoring it too would penalize an arm for a data gap.
 */
function armResult(
  sentinel: MakerLifecycleSentinel, decision: MakerLifecycleArmDecision, production: { stake: number; pnl: number },
): { stake: number; pnl: number } | null {
  if (!sentinel.outcome) return null;
  if (decision.noTradeReason === 'no-quote-at-cutover') return null;
  if (decision.noTradeReason === 'filled-before-cutover') return production;
  if (!decision.acquired || decision.quantity === undefined) return { stake: 0, pnl: 0 };
  const cost = decision.costCents ?? 0;
  const fee = decision.feeCents ?? 0;
  const payout = sentinel.outcome === sentinel.side ? Math.floor(decision.quantity * 100 + 1e-9) : 0;
  return { stake: cost + fee, pnl: payout - cost - fee };
}

export function buildMakerLifecycleSentinelReport(input: {
  startedAt: string; sentinels: MakerLifecycleSentinel[]; orders: PaperOrder[]; strategyId?: StrategyId;
}): MakerLifecycleSentinelReport {
  const byOrderId = new Map(input.orders.map((order) => [order.id, order]));
  const strategyId = input.strategyId ?? EDGE_BINARY_BUY;
  const track = (mode: ExecutionMode): MakerLifecycleTrackReport => {
    // Money aggregations are re-narrowed by strategy (AGENTS.md §4); pooling tracks would not be separable.
    const rows = input.sentinels.filter((sentinel) => sentinel.executionMode === mode && sentinel.strategyId === strategyId);
    const resolved = rows.filter((sentinel) => sentinel.outcome);
    const unavailable = rows.filter((sentinel) => !sentinel.cutover);

    const arm = (candidateId: MakerLifecycleCandidateId | 'production'): MakerLifecycleArmReport => {
      const scored = resolved.flatMap((sentinel) => {
        const base = productionResult(sentinel, byOrderId.get(sentinel.orderId));
        if (!base) return [];
        if (candidateId === 'production') {
          return [{ sentinel, own: base, base, divergent: false, incremental: 0 }];
        }
        const decision = sentinel.arms.find((item) => item.candidateId === candidateId);
        if (!decision) return [];
        const own = armResult(sentinel, decision, base);
        // Null leaves the cohort: unavailable evidence is never scored as a decision.
        if (!own) return [];
        return [{ sentinel, own, divergent: own.pnl !== base.pnl || own.stake !== base.stake, incremental: own.pnl - base.pnl, base }];
      });
      const divergent = scored.filter((item) => item.divergent);
      const cents = clusterByWindow(divergent, (item) => item.sentinel.closesAt, (item) => item.incremental);
      // Normalized against the PRODUCTION stake, matching the sibling instruments: an abstention row has no
      // stake of its own, so dividing by it turned raw cents into a fraction and inflated the mean.
      const returns = clusterByWindow(
        divergent.filter((item) => item.base.stake > 0),
        (item) => item.sentinel.closesAt,
        (item) => item.incremental / item.base.stake,
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
        // Counts alone never unlock a review; the family-wise correction is applied at review.
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
