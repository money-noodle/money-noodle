import 'server-only';
import {
  longShotPolicyVersion, longShotSettings, longShotSizing,
  type LongShotSettings, type LongShotSizing,
} from './long-shot-policy';
import { HOLD_SENTINEL_VERSION, type HoldSentinel } from './hold-sentinel';
import { holdSentinelId } from './hold-sentinel-store';
import { LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import { orderStrategyId } from './execution-report';
import { venueFeeCents } from './venue-fill';
import type { DashboardData, ExecutionMode, PaperOrder, PositionSide, Prediction } from './types';

/**
 * Observation and reporting helpers for the long-shot round-trip policy.
 *
 * Trigger capture is owned by the one-second paper decision path. The detached pass here only recovers
 * version-stamped decisions, observes later peak bids, and resolves settlements; it cannot manufacture a
 * trigger from the slower dashboard cadence.
 */
export { longShotPolicyVersion } from './long-shot-policy';

/** The allocation this policy launches with, per docs/long-shot-policy-design.md §15. */
export const LONG_SHOT_DEFAULT_ALLOCATION_PERCENT = 30;

/**
 * Long-shot starting allocation in cents.
 *
 * `crypto-15m` is the only market and takes the whole provider today, so the market cap is the configured
 * budget. Until an allocation is durably configured this is a **sizing assumption for collection only** —
 * it scales the recorded stake and nothing else, and return per $1 staked is scale-invariant apart from
 * fee rounding, so the evidence remains usable. It grants no spending authority whatsoever.
 */
export function longShotAllocationCents(marketCapCents: number, configuredStartingCents?: number): number {
  if (Number.isFinite(configuredStartingCents) && (configuredStartingCents as number) > 0) return Math.floor(configuredStartingCents as number);
  if (!Number.isFinite(marketCapCents) || marketCapCents <= 0) return 0;
  return Math.floor(marketCapCents * LONG_SHOT_DEFAULT_ALLOCATION_PERCENT / 100);
}

/**
 * The capital basis one track sizes from.
 *
 * **Paper sizes from the paper bankroll; live sizes from the funded market allocation.** They are
 * different pots and they answer different questions. Live is bounded by cash actually on deposit at the
 * venue. Paper's job is to collect evidence, and at a live-sized allocation the ticket is small enough
 * that Kalshi's 1c minimum fee is a double-digit tax on every recorded trade — which distorts the very
 * return the evidence is measuring. Sizing paper from the paper bankroll removes that distortion without
 * touching a real-money control.
 *
 * SPEC 12.3 permits exactly this: tracks differ in execution and capital — fill model, budget and sizing,
 * rate limits, risk stops, reconciliation — and never in the entry decision. The entry rule layer still
 * takes no execution-mode parameter.
 *
 * The live allocation's configured `startingCents` is deliberately ignored for paper: it is the amount an
 * operator committed to the live venue, and spending it as a paper basis would make a paper stake read as
 * a live commitment.
 */
export function longShotTrackStartingCents(input: {
  mode: ExecutionMode;
  marketCapCents: number;
  paperBankrollCents: number;
  configuredStartingCents?: number;
}): number {
  return input.mode === 'paper'
    ? longShotAllocationCents(input.paperBankrollCents)
    : longShotAllocationCents(input.marketCapCents, input.configuredStartingCents);
}

const CENTS = 100;

export interface LongShotCycle {
  observedAt: string;
  sentinels: HoldSentinel[];
  /** Settled outcomes for this cycle's contracts, keyed `contractId:closesAt`. */
  outcomes: Record<string, PositionSide>;
  /**
   * Owned-side bid observed this cycle for each unresolved sentinel, keyed by sentinel id. The store keeps
   * the running maximum. Without this the round-trip arm is a tautology — see `sentinelPeakBids`.
   */
  peakBids: Record<string, number>;
  /** Named reasons triggers were declined, for the cycle log. */
  skipped: string[];
}

/**
 * This cycle's owned-side bid for every sentinel still awaiting settlement.
 *
 * The hold arm's whole purpose is to compare holding against the round trip on one trigger, and the round
 * trip is only distinguishable from the hold when the peak bid is known: `reachedExitMark` reads
 * `peakOwnedSideBidCents`, so a sentinel without one collapses the two arms together and reports a
 * difference of exactly zero. That is what shipped between 2026-08-15 and 2026-08-17, because this
 * function did not exist and `peakBids` was never populated. See docs/long-shot-policy-design.md §10a.
 *
 * Two constraints are load-bearing:
 *
 * - **Strictly after the decision point.** A sentinel observed on this same cycle is skipped, so the quote
 *   that triggered the entry can never also serve as the peak it is judged against.
 * - **The bid is derived, never a stored field.** Kalshi's two sides share one book, so the owned side's
 *   bid is `100¢ − ask(other side)` (§3.1). The opposite ask is the only quote read here.
 *
 * Sampled at the collection cadence, not the one-second exit poll — a sentinel holds no position to poll —
 * so every peak here is a **floor**.
 */
export function sentinelPeakBids(
  dashboard: DashboardData,
  sentinels: HoldSentinel[],
  observedAt: string,
): Record<string, number> {
  const peaks: Record<string, number> = {};
  const observedMs = Date.parse(observedAt);
  const byContract = new Map<string, Prediction>();
  for (const prediction of dashboard.predictions ?? []) {
    if (prediction.kalshi?.live && prediction.kalshi.ticker) byContract.set(prediction.kalshi.ticker, prediction);
  }

  for (const sentinel of sentinels) {
    if (sentinel.resolvedAt) continue;
    // A sentinel first seen on this cycle has no "after" yet; including now would be its own entry quote.
    if (!(Date.parse(sentinel.observedAt) < observedMs)) continue;
    const quote = byContract.get(sentinel.contractId)?.kalshi;
    if (!quote) continue;
    const oppositeAsk = sentinel.side === 'UP' ? quote.askDown : quote.askUp;
    if (!(typeof oppositeAsk === 'number' && oppositeAsk > 0)) continue;
    const bidCents = CENTS - oppositeAsk * CENTS;
    // A malformed book must not manufacture a touch; fail closed rather than record an impossible bid.
    if (!Number.isFinite(bidCents) || bidCents <= 0 || bidCents >= CENTS) continue;
    peaks[sentinel.id] = bidCents;
  }
  return peaks;
}

/**
 * Reconstructs only a prospectively stamped paper decision. Historical orders have no stamp and are
 * deliberately refused, so fixing capture cannot backfill a selected fills-only cohort.
 */
export function holdSentinelFromStampedPaperOrder(
  order: PaperOrder,
  execution: { executed: boolean; skipReason?: string } = { executed: true },
): HoldSentinel | null {
  if (order.executionMode !== 'paper' || orderStrategyId(order) !== LONG_SHOT_ROUND_TRIP
    || order.id.includes(':exit:') || order.holdSentinelVersion !== HOLD_SENTINEL_VERSION) return null;
  const observedAt = order.createdAt;
  const entryAskCents = (order.issuanceAskPrice ?? order.askPrice) * CENTS;
  const oppositeAskCents = (1 - (order.issuanceBidPrice ?? order.bidPrice)) * CENTS;
  const secondsRemaining = (Date.parse(order.closesAt) - Date.parse(observedAt)) / 1000;
  const entryGeneration = order.entryGeneration ?? 1;
  const values = [entryAskCents, oppositeAskCents, secondsRemaining, order.entryTargetCents,
    order.exitTargetCents, order.quantity, order.stakeCents, order.feeCents, entryGeneration];
  if (!order.strategyPolicyVersion || !values.every((value) => Number.isFinite(value))
    || !(entryAskCents > 0 && entryAskCents < CENTS) || !(oppositeAskCents > 0 && oppositeAskCents < CENTS)
    || !(order.quantity > 0) || !(order.stakeCents > 0) || order.feeCents < 0
    || !Number.isSafeInteger(entryGeneration) || !(entryGeneration >= 1)
    || !order.entryTargetCents || !order.exitTargetCents) return null;
  return {
    id: holdSentinelId({ symbol: order.symbol, side: order.side, closesAt: order.closesAt, entryGeneration }),
    sentinelVersion: HOLD_SENTINEL_VERSION,
    policyVersion: order.strategyPolicyVersion,
    observedAt,
    symbol: order.symbol,
    side: order.side,
    closesAt: order.closesAt,
    contractId: order.contractId,
    entryAskCents,
    oppositeAskCents,
    secondsRemaining,
    entryMarkCents: order.entryTargetCents,
    exitMarkCents: order.exitTargetCents,
    quantity: order.quantity,
    stakeCents: order.stakeCents,
    estimatedFeeCents: order.feeCents,
    entryGeneration,
    executed: execution.executed,
    ...(execution.executed || !execution.skipReason ? {} : { skipReason: execution.skipReason }),
  };
}

/**
 * Settled outcomes for sentinels whose window has closed, read from Kalshi.
 *
 * Bounded per cycle: an unresolved sentinel is retried on the next pass, and a slow venue must not hold up
 * evidence collection, let alone anything with money in it.
 */
export async function resolveSentinelOutcomes(sentinels: HoldSentinel[], nowMs = Date.now(), limit = 8): Promise<Record<string, PositionSide>> {
  const due = sentinels
    .filter((sentinel) => !sentinel.resolvedAt && Date.parse(sentinel.closesAt) <= nowMs)
    .slice(0, limit);
  const outcomes: Record<string, PositionSide> = {};
  await Promise.all(due.map(async (sentinel) => {
    try {
      const response = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(sentinel.contractId)}`,
        { signal: AbortSignal.timeout(4_000), cache: 'no-store' },
      );
      if (!response.ok) return;
      const body = await response.json() as { market?: { result?: string } };
      const result = body.market?.result?.toLowerCase();
      // An unpublished or ambiguous result stays unresolved rather than being graded as a loss.
      if (result === 'yes') outcomes[`${sentinel.contractId}:${sentinel.closesAt}`] = 'UP';
      else if (result === 'no') outcomes[`${sentinel.contractId}:${sentinel.closesAt}`] = 'DOWN';
    } catch {
      // A transient venue failure is not an outcome; the next cycle retries.
    }
  }));
  return outcomes;
}

/** Exit fee for a sentinel's round trip, from the production fee model rather than a second copy of it. */
export function longShotExitFeeCents(sentinel: Pick<HoldSentinel, 'exitMarkCents' | 'quantity'>): number {
  return venueFeeCents('kalshi', sentinel.exitMarkCents, sentinel.quantity, 'taker');
}

/**
 * Long-shot equity and ticket for the current cycle.
 *
 * Equity is the funded allocation plus this strategy's own realized P&L, read from the shared ledger. A
 * live percentage of current market equity would size this strategy's ticket from the other's results and
 * dilute its own losses, so the drawdown halt could never fire on the strategy that earned it.
 */
export function longShotSizingFor(orders: PaperOrder[], startingCents: number, settings = longShotSettings()): LongShotSizing {
  const realized = orders
    .filter((order) => orderStrategyId(order) === LONG_SHOT_ROUND_TRIP && order.executionMode === 'live'
      && ['won', 'lost', 'sold', 'invalid'].includes(order.status))
    .reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0);
  return longShotSizing(Math.max(0, startingCents + realized), settings);
}

/**
 * Detached reconciliation pass. Trigger creation belongs exclusively to the one-second paper decision
 * path; this pass can only recover prospectively version-stamped orders, observe later peaks, and settle.
 */
export async function collectLongShotEvidence(input: {
  dashboard: DashboardData;
  orders: PaperOrder[];
  existingSentinels: HoldSentinel[];
  nowMs?: number;
}): Promise<LongShotCycle> {
  const nowMs = input.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const outcomes = await resolveSentinelOutcomes(input.existingSentinels, nowMs);
  return {
    sentinels: input.orders.flatMap((order) => {
      const sentinel = holdSentinelFromStampedPaperOrder(order);
      return sentinel ? [sentinel] : [];
    }),
    outcomes,
    // Every sentinel already on file is re-observed each cycle; the store keeps the running maximum.
    peakBids: sentinelPeakBids(input.dashboard, input.existingSentinels, observedAt),
    observedAt,
    skipped: [],
  };
}
