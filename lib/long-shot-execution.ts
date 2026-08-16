import 'server-only';
import {
  evaluateLongShotEntry, longShotPolicyVersion, longShotSettings, longShotSizing,
  type LongShotSettings, type LongShotSizing,
} from './long-shot-policy';
import { HOLD_SENTINEL_VERSION, type HoldSentinel } from './hold-sentinel';
import { holdSentinelId } from './hold-sentinel-store';
import { LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import { orderStrategyId } from './execution-report';
import { estimatePaperFill, venueFeeCents } from './venue-fill';
import type { DashboardData, PaperOrder, PositionSide, Prediction } from './types';

/**
 * Per-cycle evaluation of the long-shot round-trip policy.
 *
 * **This module currently collects evidence and places no orders.** Every trigger it finds is recorded as
 * a hold sentinel with `executed: false`, which starts the ~4-candidates-a-day clock running immediately
 * while the order-placement path is written and reviewed separately. Collection has the longest lead time
 * of anything in this policy — 60 attempts is two to three weeks — so it is deliberately not blocked on
 * the part that spends money.
 */
export { longShotPolicyVersion } from './long-shot-policy';

/** Reason recorded on every sentinel until the execution path exists, so the gap is explicit in the data. */
const COLLECTION_ONLY = 'Collection only: the long-shot execution path is not wired in yet.';

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

const CENTS = 100;

export interface LongShotCycle {
  observedAt: string;
  sentinels: HoldSentinel[];
  /** Settled outcomes for this cycle's contracts, keyed `contractId:closesAt`. */
  outcomes: Record<string, PositionSide>;
  /** Named reasons triggers were declined, for the cycle log. */
  skipped: string[];
}

const sideAsk = (prediction: Prediction, side: PositionSide): number | undefined =>
  side === 'UP' ? prediction.kalshi?.askUp : prediction.kalshi?.askDown;

/**
 * Entries already made on this asset and window by this strategy, counting every generation whether open
 * or closed. Re-entry is capped for churn and fee reasons, not risk (§9).
 */
function entriesThisAssetWindow(orders: PaperOrder[], symbol: string, closesAt: string): number {
  return orders.filter((order) => orderStrategyId(order) === LONG_SHOT_ROUND_TRIP
    && order.symbol === symbol && order.closesAt === closesAt && !order.id.includes(':exit:')).length;
}

const isOpen = (order: PaperOrder) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain';

function openLongShots(orders: PaperOrder[]): PaperOrder[] {
  return orders.filter((order) => orderStrategyId(order) === LONG_SHOT_ROUND_TRIP && isOpen(order));
}

/**
 * Evaluates every live Kalshi contract for a long-shot trigger and returns the sentinels to commit.
 *
 * Sentinels are built for triggers that pass the entry rule, including ones the executing lane could not
 * take. That is the point of committing at trigger time: derived from fills the sample would inherit every
 * selection bias of execution and would answer a different question (§10).
 */
export function longShotCycle(
  dashboard: DashboardData,
  orders: PaperOrder[],
  sizing: LongShotSizing,
  settings: LongShotSettings,
  nowMs = Date.now(),
): LongShotCycle {
  const observedAt = new Date(nowMs).toISOString();
  const sentinels: HoldSentinel[] = [];
  const skipped: string[] = [];
  const open = openLongShots(orders);

  for (const prediction of dashboard.predictions ?? []) {
    const quote = prediction.kalshi;
    if (!quote?.live || !quote.ticker) continue;
    const closeMs = Date.parse(quote.closesAt);
    if (!Number.isFinite(closeMs)) continue;
    const secondsRemaining = (closeMs - nowMs) / 1000;

    for (const side of ['UP', 'DOWN'] as const) {
      const ask = sideAsk(prediction, side);
      if (!(typeof ask === 'number' && ask > 0)) continue;

      const openSameAssetWindow = open.filter((order) => order.symbol === prediction.symbol && order.closesAt === quote.closesAt).length;
      const openSameSettlementWindow = open.filter((order) => order.closesAt === quote.closesAt).length;
      const generation = entriesThisAssetWindow(orders, prediction.symbol, quote.closesAt) + 1;

      const decision = evaluateLongShotEntry({
        symbol: prediction.symbol, side, askPrice: ask, secondsRemaining,
        openSameAssetWindow, openSameSettlementWindow,
        entriesThisAssetWindow: generation - 1,
        // Nothing has traded, so nothing has been lost today. The real figure arrives with execution.
        dailyNetLossCents: 0,
      }, sizing, settings);

      if (!decision.qualifies) {
        // Only log a near miss: every window has dozens of sides nowhere near the mark and logging them
        // all would bury the ones worth reading.
        if (ask * CENTS <= settings.entryMarkCents * 2) skipped.push(`${prediction.symbol} ${side}: ${decision.reason}`);
        continue;
      }

      const fill = estimatePaperFill(sizing.ticketCents, ask, 'kalshi');
      if (!fill) {
        skipped.push(`${prediction.symbol} ${side}: ${sizing.ticketCents}¢ cannot buy the venue minimum at ${(ask * CENTS).toFixed(0)}¢.`);
        continue;
      }

      sentinels.push({
        id: holdSentinelId({ symbol: prediction.symbol, side, closesAt: quote.closesAt, entryGeneration: generation }),
        sentinelVersion: HOLD_SENTINEL_VERSION,
        policyVersion: longShotPolicyVersion(settings),
        observedAt,
        symbol: prediction.symbol,
        side,
        closesAt: quote.closesAt,
        contractId: quote.ticker,
        entryAskCents: ask * CENTS,
        oppositeAskCents: (side === 'UP' ? quote.askDown : quote.askUp) * CENTS,
        secondsRemaining,
        entryMarkCents: settings.entryMarkCents,
        exitMarkCents: settings.exitMarkCents,
        quantity: fill.quantity,
        stakeCents: fill.stakeCents,
        estimatedFeeCents: fill.feeCents,
        entryGeneration: generation,
        executed: false,
        skipReason: COLLECTION_ONLY,
      });
    }
  }

  return { observedAt, sentinels, outcomes: {}, skipped };
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
  return venueFeeCents('kalshi', sentinel.exitMarkCents, sentinel.quantity);
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
 * One collection pass: find triggers, commit sentinels, resolve settled windows.
 *
 * Runs detached from the trading cycle and never throws into it. `startingCents` is the long-shot
 * allocation; while nothing trades it only scales the recorded stake, and return per $1 staked is
 * scale-invariant apart from fee rounding, so an unfunded policy still collects usable evidence.
 */
export async function collectLongShotEvidence(input: {
  dashboard: DashboardData;
  orders: PaperOrder[];
  startingCents: number;
  existingSentinels: HoldSentinel[];
  nowMs?: number;
}): Promise<{ sentinels: HoldSentinel[]; outcomes: Record<string, PositionSide>; observedAt: string; skipped: string[] }> {
  const settings = longShotSettings();
  const nowMs = input.nowMs ?? Date.now();
  const sizing = longShotSizingFor(input.orders, input.startingCents, settings);
  // Collection continues even when the policy is switched off or halted: the evidence is what decides
  // whether to switch it on, so gating collection on being enabled would be circular. Sizing is still
  // reported honestly, and a halted policy records a zero ticket.
  const cycle = longShotCycle(input.dashboard, input.orders, sizing.halted ? { ...sizing, halted: false } : sizing, settings, nowMs);
  const outcomes = await resolveSentinelOutcomes(input.existingSentinels, nowMs);
  return { sentinels: cycle.sentinels, outcomes, observedAt: cycle.observedAt, skipped: cycle.skipped };
}
