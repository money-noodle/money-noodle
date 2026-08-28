import 'server-only';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beginLiveTransaction, blockExecutionDrain, completeExecutionDrain, endLiveTransaction, getExecutionDrainStatus, startExecutionDrain } from './execution-drain-state';
import { CALENDAR_EVALUATION_VERSION, calendarFixedSnapshotDue, updateCalendarEvaluationStore, type CalendarEvaluationCycle } from './calendar-evaluation-store';
import { reconcileExecutionLedger } from './execution-reconciliation';
import { ENTRY_EXECUTION_POLICY_VERSION, MAX_ENTRY_EPISODES_PER_WINDOW, entrySideProbability, evaluateEntryExecutionPolicy, makerCohortEvidence, parseEntryExecutionMode, type EntryExecutionDecision } from './entry-execution-policy';
import { executionMirrorPairStamp } from './execution-mirror-pair';
import { hydrateExecutionOrders, readExecutionLedgerFile } from './execution-ledger-storage';
import { observeEntryDirection } from './entry-direction-observation';
import { evaluateEntrySizing } from './entry-sizing-policy';
import { POST_EXIT_REENTRY_COOLDOWN_MS, evaluateExitPolicy } from './exit-policy';
import { estimateMakerFill } from './maker-fill-model';
import { boundedTakerLimit } from './managed-maker';
import { fetchKalshiManagedMakerQuote, fetchKalshiTradePrintsSince } from './kalshi-market-data';
import { observeKalshiOrderBook } from './kalshi-depth';
import { immediateBuyFill, immediateSellFill } from './ioc-fill-model';
import type { LiveSkipClass } from './live-skip';
import { recordLiveSkip } from './live-skip-store';

/**
 * Journals a withhold decided inside the switch path.
 *
 * These three sites wrote only to `lastLiveSkip` when the journal landed, which left the switch path
 * with exactly the single-slot problem SPEC §12.8 step 2 exists to remove. The window is the incumbent's
 * own settlement window: a switch withheld is a decision about that window, not about the account.
 */
function recordSwitchSkip(classification: LiveSkipClass, reason: string, incumbent: PaperOrder, ledger: Ledger): void {
  ledger.lastLiveSkip = { reason, at: new Date().toISOString() };
  void recordLiveSkip({ classification, reason, windows: [incumbent.closesAt], symbol: incumbent.symbol, side: incumbent.side })
    .catch((error) => console.error('Live skip journal write failed:', error));
}
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION, simulateManagedPaperMaker, type PaperMakerSimulationResult } from './paper-maker-simulation';
import {
  observePaperFinalEvidenceGrace, recordPaperFinalEvidenceUnavailable, startPaperExecutionTimingObservers,
} from './paper-execution-timing-observer';
import { isPaperFillCalibration, type PaperFillCalibration } from './paper-fill-calibration';
import { getActivePaperFillCalibration } from './paper-fill-calibration-store';
import { isFreshCalculationTimestamp } from './freshness';
import { selectedSideDepth } from './order-book-depth';
import { orderMarketId, orderProviderId, orderStrategyId } from './execution-report';
import { EDGE_BINARY_BUY } from './strategy-registry';
import { beginTaskCadenceRun, recordTaskCadenceSuccess } from './task-cadence-runtime';
import { assetAdmitted } from './asset-exclusion';
import { LEGACY_PAPER_BANKROLL_ID, nextPaperBankrollFunding, orderEpochId } from './budget-epoch';
import { cycleRegimeFor } from './cycle-path-store';
import { DEFAULT_MARKET_ID } from './market-registry';
import { marketFunding } from './provider-budget-policy';
import { getProviderBudgets, providerBudget } from './provider-budget-store';
import { getExecutionLedgerRuntime, serializeExecutionLedgerOperation, waitForExecutionLedger, type ExecutionLedgerMutation } from './execution-ledger-runtime';
import { isStatelessDeployment } from './runtime-environment';
import { postgresPaperProjectionSyncEnabled, readPublicPaperBudgetFromPostgres, syncPublicPaperBudgetToPostgres } from './postgres-paper-projection';
import {
  fetchKalshiIncrementalReconciliationSnapshot,
  fetchKalshiReconciliationSnapshot,
  type KalshiReconciliationSnapshot,
} from './kalshi-reconciliation';
import { adaptiveEntryEpisodeDecision, entryAttemptsForLogicalOrder, entryEpisodeId, makerAttemptId, makerRetryDecision, maximumLiveMakerAttempts, terminalizeAdaptiveContinuation, terminalizeRefusedAdaptiveContinuation, type MakerRetryDecision } from './maker-retry-policy';
import { liveBlockers, liveTradingEnabled, maxLiveOrdersPerHour, maxLiveStakeCents, placeKalshiBuy, placeKalshiSell, placeKalshiTakerBuy } from './live-orders';
import { assertUniqueLiveEntryClientOrderId, liveEntryClientOrderId } from './live-order-identity';
import { countFilledLiveVenueOrders } from './order-rate-limit';
import { selectPortfolio, cryptoExposureGroup, DEFAULT_PORTFOLIO_CONSTRAINTS, parseMaximumOpenPositions, type PortfolioConstraints } from './portfolio-policy';
import { PORTFOLIO_CHOICE_SET_VERSION, type PortfolioChoiceSetRecord } from './portfolio-choice-set';
import { maintainPortfolioChoiceSets, recordPortfolioChoiceSet } from './portfolio-choice-set-store';
import { bestEntry, bestVenueEntry, BUY_POLICY_VERSION, edgeStrength, MAX_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, qualifiesAsBuyEdge, qualifiesVenueBuyEdge, sideProbability, venueFeeRate } from './prediction-policy';
import { quoteTrajectoryForDecision } from './quote-trajectory-spread';
import { getKalshiReconciliationStatus, serializedReconciliation, setKalshiReconciliationStatus, type KalshiReconciliationStatus } from './reconciliation-state';
import {
  KALSHI_RECONCILIATION_CHECKPOINT_VERSION,
  readKalshiReconciliationCheckpoint,
  writeKalshiReconciliationCheckpoint,
  type ReconciliationCheckpointTrigger,
} from './reconciliation-checkpoint';
import {
  incrementalReconciliationInterval,
  liveReconciliationAuthorityFingerprint,
  localReconciliationPlan,
} from './reconciliation-scope';
import { getRegimeGateStatus, updateRegimeGate, type RegimeGateStatus, type RegimeSentinelCandidate } from './regime-gate-store';
import { advanceSignalPersistence, evaluateSignalPersistence, evaluateSignalPersistenceIgnoringSpike, productionSignalPersistence, signalPersistenceAfter, type SignalEligibility, type SignalPersistenceState } from './signal-persistence';
import { spikeAdmits } from './edge-spike-policy';
import { EDGE_SPIKE_SENTINEL_VERSION, edgeSpikeSentinelId, type EdgeSpikeSentinel } from './edge-spike-sentinel';
import { updateEdgeSpikeSentinels } from './edge-spike-sentinel-store';
import { maintainMakerRestrictionSentinels, recordMakerRestrictionOrder } from './maker-restriction-sentinel-store';
import { maintainMakerLifecycleSentinels, recordMakerLifecycleOrder } from './maker-lifecycle-sentinel-store';
import {
  getExitPolicyContinuationOrderIds, maintainExitPolicySentinels, recordExitPolicySentinelObservation,
} from './exit-policy-sentinel-store';
import { REQUIRED_SWITCH_SNAPSHOTS, REQUIRED_SWITCH_SPAN_MS, advanceSwitchPersistence, switchCooldownRemainingMs, switchEvidenceReady, switchEvidenceSpanMs, type SwitchPersistenceState } from './switch-hysteresis';
import { evaluateSwitchProbabilityGate, switchPolicySettings, valueSwitch } from './switch-policy';
import { autoResumeTradingAfterReconciliation, getTradingControl, pauseTrading, reconcileTradingBudget, recordTradingReconciliationFailure, releaseTradingBudget, reserveTradingBudget, settleTradingBudget, stopTradingForLiveRisk, suspendTrading } from './trading-control';
import { MAKER_MISS_TAKER_CUSHION_TICKS, makerMissTakerHardCeiling, makerMissTakerNetEdge, makerMissTakerQuoteRefusal, refreshedAskFitsTakerCap, takerQuoteCap } from './taker-quote-policy';
import type { BinaryOrderBook, DashboardData, ExecutionMode, ExecutionSignalReadiness, ExecutionSummary, LiveLedgerCorrection, MarketFunding, MarketId, PaperOrder, PortfolioDecisionView, PositionLifecycleObservation, PositionSide, Prediction, ProviderBudgetConfiguration, PublicPaperBudget, PublicPaperExecutionRecord, StrategyId, TradingControlData, TradingProviderId } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'paper-orders.json');
const MIN_TIME_TO_CLOSE_MS = 30_000;
const MAX_SPREAD = 0.10;
const MIN_SWITCH_SECONDS = 120;
const DEFAULT_PAPER_BANKROLL_CENTS = 10_000;
/**
 * Deliberately tight while the desk is validating whether it can trade venue disagreement profitably.
 * Raise only after realized edge is measured as positive over a meaningful sample.
 */
const DEFAULT_MAX_PAPER_STAKE_CENTS = 200;
let automaticReconciliationRequested = false;

/**
 * An out-of-band adjustment to the paper bankroll, appended by a correction script and never rewritten.
 *
 * Two arrays exist and they relate to the order-derived P&L view differently, which is the whole reason
 * they are kept apart rather than pooled:
 *
 * - `makerFeeCorrections` returned taker fees charged on paper *maker* fills. That fee is still baked
 *   into the `stakeCents` and `pnlCents` of the edge-policy orders it was taken from, so any figure
 *   summed from those orders must add it back or it will disagree with the bankroll.
 * - `strategyLeakCorrections` removed another strategy's payouts that were wrongly credited here. Those
 *   orders are excluded from the edge-policy sum by the strategy filter already, so applying it to an
 *   order-derived figure would subtract it a second time.
 */
interface BankrollCorrection { at: string; reason: string; orderIds: string[]; availableCents: number; realizedPnlCents: number }
interface PaperBudget {
  startingCents: number; availableCents: number; realizedPnlCents: number; resets?: number; startedAt?: string;
  /** Identity of the current bankroll funding; absent means the original, never-reset bankroll. */
  fundingId?: string;
  fundingSequence?: number;
  makerFeeCorrections?: BankrollCorrection[];
  strategyLeakCorrections?: BankrollCorrection[];
  reconciliationCorrections?: BankrollCorrection[];
}
export const MAX_PAPER_BANKROLL_CENTS = 1_000_000;
interface Ledger { version: 8 | 9; paperBudget: PaperBudget; orders: PaperOrder[]; signalPersistence: Record<string, SignalPersistenceState>; portfolioDecisions: Record<string, PortfolioDecisionView>; switchPersistence: Record<string, SwitchPersistenceState>; liveCorrections: LiveLedgerCorrection[]; lastLiveSkip?: { reason: string; at: string } }

const ledgerRuntime = getExecutionLedgerRuntime<Ledger>();

async function loadLedgerFromDisk(): Promise<Ledger> {
  try {
    const raw = await readExecutionLedgerFile(DATA_DIR) as Partial<Ledger> & { orders?: PaperOrder[] };
    return {
      version: raw.version === 9 ? 9 : 8,
      paperBudget: raw.paperBudget ?? { startingCents: DEFAULT_PAPER_BANKROLL_CENTS, availableCents: DEFAULT_PAPER_BANKROLL_CENTS, realizedPnlCents: 0 },
      orders: (raw.orders ?? []).map((order) => ({ ...order, executionMode: order.executionMode ?? 'paper' })),
      // Persistence is side-specific. Legacy UP-only streaks are discarded rather than reused
      // for a potentially opposite-side order after deployment.
      signalPersistence: Object.fromEntries(Object.entries(raw.signalPersistence ?? {}).filter(([, state]) => state.side === 'UP' || state.side === 'DOWN')),
      portfolioDecisions: raw.portfolioDecisions ?? {},
      switchPersistence: raw.switchPersistence ?? {},
      liveCorrections: raw.liveCorrections ?? [],
      lastLiveSkip: raw.lastLiveSkip,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 9, paperBudget: { startingCents: DEFAULT_PAPER_BANKROLL_CENTS, availableCents: DEFAULT_PAPER_BANKROLL_CENTS, realizedPnlCents: 0 }, orders: [], signalPersistence: {}, portfolioDecisions: {}, switchPersistence: {}, liveCorrections: [] };
    }
    throw error;
  }
}

async function committedLedger(): Promise<Ledger> {
  if (ledgerRuntime.committed) return ledgerRuntime.committed;
  if (!ledgerRuntime.loading) {
    ledgerRuntime.loading = loadLedgerFromDisk().then((ledger) => {
      ledgerRuntime.committed = ledger;
      return ledger;
    }).finally(() => { ledgerRuntime.loading = undefined; });
  }
  return ledgerRuntime.loading;
}

async function mutableLedger(): Promise<Ledger> {
  const mutation = ledgerRuntime.activeMutation;
  if (!mutation) throw new Error('Execution ledger mutation attempted outside the process-global serializer.');
  mutation.working ??= structuredClone(await committedLedger());
  return mutation.working;
}

async function readLedgerView<Result>(derive: (ledger: Ledger) => Result): Promise<Result> {
  return serializeExecutionLedgerOperation(async () => structuredClone(derive(await committedLedger())));
}

function serializeLedgerMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
  return serializeExecutionLedgerOperation(async () => {
    if (ledgerRuntime.activeMutation) throw new Error('Nested execution ledger mutation is not permitted.');
    const mutation: ExecutionLedgerMutation<Ledger> = { successfulWrites: 0, writeFailed: false };
    ledgerRuntime.activeMutation = mutation;
    try {
      const result = await operation();
      if (mutation.successfulWrites > 0 && !mutation.writeFailed && mutation.working) {
        ledgerRuntime.committed = mutation.working;
      }
      return result;
    } catch (error) {
      if (mutation.successfulWrites > 0 || mutation.writeFailed) ledgerRuntime.committed = undefined;
      throw error;
    } finally {
      ledgerRuntime.activeMutation = undefined;
    }
  });
}

async function writeLedger(ledger: Ledger): Promise<void> {
  const mutation = ledgerRuntime.activeMutation;
  if (!mutation || mutation.working !== ledger) {
    throw new Error('Execution ledger write refused outside its active process-global mutation.');
  }
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${LEDGER_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(ledger));
    await rename(temporary, LEDGER_FILE);
    mutation.successfulWrites += 1;
  } catch (error) {
    mutation.writeFailed = true;
    ledgerRuntime.committed = undefined;
    throw error;
  }
  // JSON remains authoritative during the replication phase; never make execution depend on Postgres.
  if (postgresPaperProjectionSyncEnabled()) {
    void syncPublicPaperBudgetToPostgres(publicPaperBudgetFromLedger(ledger))
      .catch((error) => console.error('Postgres public paper projection sync failed:', error));
  }
}

function maximumPaperStakeCents(): number {
  const value = Number(process.env.MONEY_NOODLE_MAX_PAPER_STAKE_CENTS ?? DEFAULT_MAX_PAPER_STAKE_CENTS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_PAPER_STAKE_CENTS;
}

function entryExecutionSettings() {
  const bounded = (name: string, fallback: number, maximum: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value >= 0 ? Math.min(maximum, value) : fallback;
  };
  return {
    mode: parseEntryExecutionMode(process.env.MONEY_NOODLE_ENTRY_EXECUTION_MODE),
    minimumMedianNetEdge: bounded('MONEY_NOODLE_MIN_TAKER_MEDIAN_EDGE', 0.10, 0.5),
    minimumConfidence: bounded('MONEY_NOODLE_MIN_TAKER_QUALITY', 0.65, 1),
    maximumSpread: bounded('MONEY_NOODLE_MAX_TAKER_SPREAD', 0.02, 0.25),
  };
}

function maximumOpenPositions(): number {
  return parseMaximumOpenPositions(process.env.MONEY_NOODLE_MAX_OPEN_POSITIONS);
}

function portfolioConstraints(): PortfolioConstraints {
  const maximumPositions = maximumOpenPositions();
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(maximum, value) : fallback;
  };
  const cents = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value >= 0 ? Math.min(25, value) : fallback;
  };
  return {
    maximumPositions,
    maximumSameWindow: integer('MONEY_NOODLE_MAX_SAME_WINDOW_POSITIONS', DEFAULT_PORTFOLIO_CONSTRAINTS.maximumSameWindow, maximumPositions),
    maximumSameGroupPerWindow: integer('MONEY_NOODLE_MAX_SAME_GROUP_POSITIONS', DEFAULT_PORTFOLIO_CONSTRAINTS.maximumSameGroupPerWindow, maximumPositions),
    correlationPenaltyCents: cents('MONEY_NOODLE_CORRELATION_PENALTY_CENTS', DEFAULT_PORTFOLIO_CONSTRAINTS.correlationPenaltyCents),
    sameGroupPenaltyCents: cents('MONEY_NOODLE_SAME_GROUP_PENALTY_CENTS', DEFAULT_PORTFOLIO_CONSTRAINTS.sameGroupPenaltyCents),
  };
}

/** A fill at or above the $1 payout is a guaranteed loss, so it is refused regardless of policy. */
import { MAX_FILLABLE_ASK, estimatePaperFill, venueFeeCents } from './venue-fill';
export { MAX_FILLABLE_ASK, estimatePaperFill, venueFeeCents } from './venue-fill';

const baseOrderId = (prediction: Prediction, mode: ExecutionMode, side: PositionSide) => `${mode}:${prediction.symbol}:${side}:${prediction.market.closesAt}`;
const sideWindowOrders = (ledger: Ledger, prediction: Prediction, mode: ExecutionMode, side: PositionSide) => ledger.orders
  .filter((order) => order.executionMode === mode && order.symbol === prediction.symbol && order.side === side && order.closesAt === prediction.market.closesAt && !order.id.includes(':exit:'))
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
const entryGeneration = (ledger: Ledger, prediction: Prediction, mode: ExecutionMode, side: PositionSide) =>
  sideWindowOrders(ledger, prediction, mode, side).filter((order) => order.status === 'sold').length + 1;
const orderId = (prediction: Prediction, mode: ExecutionMode, side: PositionSide, ledger: Ledger) => {
  const base = baseOrderId(prediction, mode, side);
  const generation = entryGeneration(ledger, prediction, mode, side);
  return generation <= 1 ? base : `${base}:reentry:${generation}`;
};
const liveAttempts = (ledger: Ledger, prediction: Prediction, side: PositionSide) => entryAttemptsForLogicalOrder(ledger.orders, orderId(prediction, 'live', side, ledger));
const paperAttempts = (ledger: Ledger, prediction: Prediction, side: PositionSide) => entryAttemptsForLogicalOrder(ledger.orders, orderId(prediction, 'paper', side, ledger), 'paper');
const reentryCooldownRemainingMs = (ledger: Ledger, prediction: Prediction, mode: ExecutionMode, side: PositionSide, nowMs = Date.now()) => {
  const sold = sideWindowOrders(ledger, prediction, mode, side).filter((order) => order.status === 'sold' && order.settledAt).at(-1);
  return sold ? Math.max(0, Date.parse(sold.settledAt!) + POST_EXIT_REENTRY_COOLDOWN_MS - nowMs) : 0;
};
const persistenceKey = (prediction: Prediction, side: PositionSide) => `${prediction.symbol}:${side}:${prediction.market.closesAt}`;
const selectedSide = (prediction: Prediction): PositionSide | undefined => bestEntry(prediction)?.side;

/** Updates raw signal evidence once per distinct dashboard calculation; it never changes qualification. */
function updateSignalPersistence(dashboard: DashboardData, ledger: Ledger): boolean {
  let changed = false;
  const fresh = isFreshCalculationTimestamp(dashboard.generatedAt);
  const currentKeys = new Set<string>();
  for (const prediction of dashboard.predictions) {
    const entry = bestEntry(prediction);
    if (!entry) continue;
    const key = persistenceKey(prediction, entry.side);
    currentKeys.add(key);
    const previous = ledger.signalPersistence[key];
    const next = advanceSignalPersistence(previous, {
      symbol: prediction.symbol, side: entry.side, closesAt: prediction.market.closesAt, calculationAt: dashboard.generatedAt,
      qualifies: fresh && qualifiesAsBuyEdge(prediction), netEdge: entry.netEdge,
      quality: prediction.confidence,
    });
    if (next !== previous && JSON.stringify(next) !== JSON.stringify(previous)) { ledger.signalPersistence[key] = next; changed = true; }
  }
  for (const key of Object.keys(ledger.signalPersistence)) {
    // Absence from the current selected-side snapshot is a failed current observation. Delete it
    // immediately so a later UP↔DOWN flip cannot resurrect stale persistence from the other side.
    if (!currentKeys.has(key)) { delete ledger.signalPersistence[key]; changed = true; }
  }
  return changed;
}

export function evaluateEntryEpisodePersistence(
  state: SignalPersistenceState | undefined, nowMs: number, completedAt?: string,
): SignalEligibility {
  return evaluateSignalPersistence(
    completedAt ? signalPersistenceAfter(state, completedAt) : state,
    nowMs, MIN_NET_EDGE, MIN_ESTIMATE_QUALITY,
  );
}

function executionEligibility(prediction: Prediction, side: PositionSide, ledger: Ledger, nowMs = Date.now()): SignalEligibility {
  return evaluateEntryEpisodePersistence(ledger.signalPersistence[persistenceKey(prediction, side)], nowMs);
}

interface LiveAttemptState {
  attempts: PaperOrder[];
  retry: MakerRetryDecision;
  eligibility: SignalEligibility;
  requalifyingEpisode: boolean;
  takerFallback: boolean;
  requalifiedAfterOrderId?: string;
}

/**
 * One source of truth for every live selection/readiness/submission call site. Adaptive v8 permits one
 * managed maker and two immediate fresh-check taker continuations; ordinary persistence applies only to
 * the first intent. Other configured modes retain the historical bounded-retry helper.
 */
function liveAttemptState(
  prediction: Prediction, side: PositionSide, ledger: Ledger, nowMs = Date.now(),
): LiveAttemptState {
  const attempts = liveAttempts(ledger, prediction, side);
  const adaptive = entryExecutionSettings().mode === 'adaptive';
  const retry = adaptive
    ? adaptiveEntryEpisodeDecision(attempts, ENTRY_EXECUTION_POLICY_VERSION)
    : makerRetryDecision(attempts, nowMs, prediction.market.closesAt, maximumLiveMakerAttempts());
  const takerFallback = adaptive && Boolean(retry.takerFallback);
  const requalifyingEpisode = adaptive && retry.allowed && retry.attemptNumber > 1 && Boolean(retry.retryOfOrderId);
  const parent = requalifyingEpisode ? attempts.find((attempt) => attempt.id === retry.retryOfOrderId) : undefined;
  const state = ledger.signalPersistence[persistenceKey(prediction, side)];
  const eligibility = takerFallback
    ? { eligible: true, reason: 'Authoritative predecessor permits immediate fresh fallback checks.', cycleAgeMs: 0, remainingMs: 0, qualifyingSnapshots: 1, medianNetEdge: null, edgeSpike: null }
    : evaluateEntryEpisodePersistence(state, nowMs);
  return {
    attempts, retry, requalifyingEpisode, takerFallback, requalifiedAfterOrderId: parent?.id, eligibility,
  };
}

/**
 * Prospective evidence for the v18 edge-spike freshness gate.
 *
 * Records every decision that passed every other entry and persistence gate and reached the spike check,
 * labelled by whether the gate admitted it. Both arms therefore come from one evaluation on one
 * population, which is what makes them comparable — the admitted arm is deliberately not taken from the
 * order ledger, because that would score a real-fills cohort against a counterfactual one and reproduce
 * the maker selection the gate exists to avoid.
 *
 * Committed at decision time and independent of budget, caps, automation state and execution mode, so a
 * decision the desk could not fund still lands in the sample. The two regime gates are deliberately not
 * applied: they are time-varying operational filters, one of which is about to restart its warm-up on
 * this very version bump, and the comparison only needs the two arms drawn from the same population.
 *
 * See docs/edge-spike-sentinel-design.md §4.
 */
function edgeSpikeSentinelCycle(dashboard: DashboardData, ledger: Ledger, nowMs = Date.now()): EdgeSpikeSentinel[] {
  if (!isFreshCalculationTimestamp(dashboard.generatedAt, nowMs)) return [];
  const observed: EdgeSpikeSentinel[] = [];
  for (const prediction of dashboard.predictions) {
    const side = selectedSide(prediction);
    if (!side || !prediction.market.live || !prediction.kalshi?.live || !assetAdmitted(prediction.symbol)) continue;
    if (!qualifiesAsBuyEdge(prediction) || !qualifiesVenueBuyEdge(prediction, 'kalshi', side)) continue;
    const state = ledger.signalPersistence[persistenceKey(prediction, side)];
    const eligibility = evaluateSignalPersistenceIgnoringSpike(state, nowMs, MIN_NET_EDGE, MIN_ESTIMATE_QUALITY);
    // Anything refused before the spike check belongs in neither arm.
    if (!eligibility.eligible || eligibility.edgeSpike === null || eligibility.medianNetEdge === null) continue;
    const quote = venueQuote(prediction, 'kalshi', side);
    const entry = bestVenueEntry(prediction, 'kalshi', side);
    if (!quote || !entry || !(quote.ask > 0) || !(quote.bid > 0) || quote.bid > quote.ask) continue;
    observed.push({
      id: edgeSpikeSentinelId({ policyVersion: BUY_POLICY_VERSION, symbol: prediction.symbol, side, closesAt: prediction.kalshi.closesAt }),
      sentinelVersion: EDGE_SPIKE_SENTINEL_VERSION,
      policyVersion: BUY_POLICY_VERSION,
      symbol: prediction.symbol,
      contractId: prediction.kalshi.ticker,
      side,
      closesAt: prediction.kalshi.closesAt,
      createdAt: dashboard.generatedAt,
      admitted: spikeAdmits(eligibility.edgeSpike),
      edgeSpike: eligibility.edgeSpike,
      netEdge: entry.netEdge,
      medianNetEdge: eligibility.medianNetEdge,
      selectedSideProbability: sideProbability(prediction, side),
      confidence: prediction.confidence,
      askPrice: quote.ask,
      estimatedFeeRate: entry.feeRate,
      qualifyingSnapshots: eligibility.qualifyingSnapshots,
    });
  }
  return observed;
}

/**
 * Selects one fixed-notional Kalshi recommendation per correlated settlement window. This sentinel
 * ignores paper bankroll and the live regime gate, so it keeps producing recovery evidence while
 * new real-money entries are cooling off.
 */
function regimeSentinelCandidate(dashboard: DashboardData, ledger: Ledger): RegimeSentinelCandidate | undefined {
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return undefined;
  const selected = dashboard.predictions.flatMap((prediction) => {
    const side = selectedSide(prediction);
    // Cross-venue rule comparability may be approximate; identity is exact because this sentinel stores
    // and later resolves the same Kalshi ticker. The dashboard already rejects close-time misalignment.
    if (!side || !prediction.market.live || !prediction.kalshi?.live) return [];
    if (!qualifiesVenueBuyEdge(prediction, 'kalshi', side) || !executionEligibility(prediction, side, ledger).eligible) return [];
    const entry = bestVenueEntry(prediction, 'kalshi', side);
    if (!entry) return [];
    const ask = side === 'UP' ? prediction.kalshi.askUp : prediction.kalshi.askDown;
    const bid = side === 'UP' ? prediction.kalshi.bidUp : prediction.kalshi.bidDown;
    if (!(ask > 0) || ask > MAX_FILLABLE_ASK || !(bid > 0) || bid > ask || ask - bid > MAX_SPREAD) return [];
    return [{ prediction, side, entry, ask, score: entry.netEdge * prediction.confidence }];
  }).sort((a, b) => b.score - a.score)[0];
  if (!selected) return undefined;
  const { prediction, side, entry, ask } = selected;
  const closesAt = prediction.kalshi!.closesAt;
  return {
    id: `regime-sentinel:${BUY_POLICY_VERSION}:${closesAt}`,
    policyVersion: BUY_POLICY_VERSION,
    symbol: prediction.symbol,
    contractId: prediction.kalshi!.ticker,
    side,
    closesAt,
    createdAt: new Date().toISOString(),
    selectedSideProbability: sideProbability(prediction, side),
    askPrice: ask,
    estimatedFeeRate: entry.feeRate,
    predictedNetEdge: entry.netEdge,
  };
}

function calendarEvaluationCycle(dashboard: DashboardData, ledger: Ledger): CalendarEvaluationCycle {
  const observedMs = Date.parse(dashboard.generatedAt);
  const forecasts: CalendarEvaluationCycle['forecasts'] = [];
  const windows = new Map<string, CalendarEvaluationCycle['windows'][number]>();
  for (const prediction of dashboard.predictions) {
    if (!prediction.market.live || !prediction.kalshi?.live) continue;
    const closesAt = prediction.kalshi.closesAt;
    const windowId = `${CALENDAR_EVALUATION_VERSION}:${BUY_POLICY_VERSION}:${closesAt}`;
    if (!windows.has(windowId)) windows.set(windowId, {
      id: windowId, collectionVersion: CALENDAR_EVALUATION_VERSION, policyVersion: BUY_POLICY_VERSION,
      closesAt, evaluationAt: new Date(Date.parse(closesAt) - 300_000).toISOString(),
      firstObservedAt: dashboard.generatedAt, candidateStatus: 'pending',
    });
    const secondsRemaining = (Date.parse(closesAt) - observedMs) / 1_000;
    // Capture the first collector update at or below five minutes. A bounded 30-second tolerance avoids
    // backfilling a missed fixed snapshot from materially later information.
    if (!calendarFixedSnapshotDue(secondsRemaining)) continue;
    const side = selectedSide(prediction);
    const entry = side ? bestVenueEntry(prediction, 'kalshi', side) : undefined;
    forecasts.push({
      id: `${CALENDAR_EVALUATION_VERSION}:${BUY_POLICY_VERSION}:${prediction.symbol}:${closesAt}`,
      collectionVersion: CALENDAR_EVALUATION_VERSION, policyVersion: BUY_POLICY_VERSION,
      modelVersion: dashboard.modelVersion, symbol: prediction.symbol, contractId: prediction.kalshi.ticker,
      closesAt, observedAt: dashboard.generatedAt, secondsRemaining,
      probabilityUp: prediction.modelProbabilityUp, confidence: prediction.confidence,
      askUp: prediction.kalshi.askUp, bidUp: prediction.kalshi.bidUp,
      askDown: prediction.kalshi.askDown, bidDown: prediction.kalshi.bidDown,
      estimatedFeeUp: venueFeeRate('kalshi', prediction.kalshi.askUp, 'taker'),
      estimatedFeeDown: venueFeeRate('kalshi', prediction.kalshi.askDown, 'taker'),
      qualified: qualifiesAsBuyEdge(prediction), selectedSide: side,
      predictedNetEdge: entry?.netEdge, cycleRegime: prediction.cycleRegime?.regime,
      factors: prediction.factors.map(({ id, score, contribution, available }) => ({ id, score, contribution, available })),
    });
  }
  // Select independently of capital, positions, and the adaptive gate. Unlike the older regime sentinel,
  // this cohort includes the active asset and classified-path rules so an excluded best edge cannot hide
  // the next valid candidate or contaminate a clock cohort.
  const selected = dashboard.predictions.flatMap((prediction) => {
    const side = selectedSide(prediction);
    if (!side || !prediction.market.live || !prediction.kalshi?.live || !assetAdmitted(prediction.symbol)
      || !regimeAdmits(prediction.cycleRegime?.regime)) return [];
    if (!qualifiesAsBuyEdge(prediction) || !qualifiesVenueBuyEdge(prediction, 'kalshi', side)
      || !executionEligibility(prediction, side, ledger).eligible) return [];
    const entry = bestVenueEntry(prediction, 'kalshi', side);
    const quote = venueQuote(prediction, 'kalshi', side);
    if (!entry || !quote || !(quote.ask > 0) || quote.ask > MAX_FILLABLE_ASK || !(quote.bid > 0)
      || quote.bid > quote.ask || quote.ask - quote.bid > MAX_SPREAD) return [];
    return [{ prediction, side, entry, quote, score: entry.netEdge * prediction.confidence }];
  }).sort((a, b) => b.score - a.score)[0];
  if (selected) {
    const { prediction, side, entry, quote } = selected;
    const window = windows.get(`${CALENDAR_EVALUATION_VERSION}:${BUY_POLICY_VERSION}:${prediction.kalshi!.closesAt}`)!;
    const touch = prediction.makerFillEstimates?.[side] ?? prediction.makerFillEstimate ?? null;
    const evidence = makerCohortEvidence(ledger.orders, quote.ask, quote.ask - quote.bid);
    const makerEstimate = estimateMakerFill({
      touch, cohortLabel: evidence.label, cohortAttempts: evidence.accepted, cohortFills: evidence.fills,
    });
    window.candidateStatus = 'selected';
    window.candidate = {
      symbol: prediction.symbol, contractId: prediction.kalshi!.ticker, side,
      createdAt: dashboard.generatedAt, selectedSideProbability: sideProbability(prediction, side),
      confidence: prediction.confidence, askPrice: quote.ask, bidPrice: quote.bid,
      // `calendar-effects-v1` stamped this maker-labelled field with taker economics. Preserve that durable
      // convention until the collector audit versions the schema; changing it in place would blend meanings.
      estimatedFeeRate: entry.feeRate, estimatedMakerFeeRate: venueFeeRate('kalshi', quote.bid, 'taker'),
      predictedNetEdge: entry.netEdge,
      makerFillProbability: makerEstimate?.probability ?? null, makerFillModel: makerEstimate?.model,
    };
  }
  return { productionPolicyVersion: BUY_POLICY_VERSION, observedAt: dashboard.generatedAt, forecasts, windows: [...windows.values()] };
}

function entryExecutionDecision(
  prediction: Prediction, side: PositionSide, order: PaperOrder, ledger: Ledger,
  attempt: Pick<LiveAttemptState, 'eligibility'> & Partial<Pick<LiveAttemptState, 'takerFallback' | 'requalifiedAfterOrderId'>>,
  refreshedQuote?: { bid: number; ask: number; spread: number },
): EntryExecutionDecision {
  const settings = entryExecutionSettings();
  const eligibility = attempt.eligibility;
  const ask = refreshedQuote?.ask ?? order.askPrice;
  const bid = refreshedQuote?.bid ?? order.bidPrice;
  const spread = refreshedQuote?.spread ?? order.spread;
  const probability = entrySideProbability(prediction.modelProbabilityUp, side);
  const evidence = makerCohortEvidence(ledger.orders, ask, spread);
  return evaluateEntryExecutionPolicy({
    ...settings,
    currentNetEdge: probability - ask - venueFeeRate('kalshi', ask, 'taker'),
    medianNetEdge: eligibility.medianNetEdge ?? Number.NEGATIVE_INFINITY,
    confidence: prediction.confidence,
    spread,
    makerNetEdge: probability - bid - venueFeeRate('kalshi', bid, 'maker'),
    makerEvidence: evidence,
    makerMissFallback: Boolean(attempt.takerFallback),
    fallbackFromOrderId: attempt.requalifiedAfterOrderId,
  });
}

/** Re-runs the active venue buy rule on the selected-side signed quote; no experiment threshold is copied. */
export function boundedTakerFreshQuoteRefusal(
  prediction: Prediction, side: PositionSide, quote: { bid: number; ask: number; spread: number },
): string | undefined {
  if (!prediction.kalshi) return 'The exact Kalshi contract is unavailable.';
  if (![quote.bid, quote.ask, quote.spread].every(Number.isFinite) || quote.bid <= 0 || quote.ask <= quote.bid
    || Math.abs((quote.ask - quote.bid) - quote.spread) > 1e-9) return 'The refreshed selected-side quote is malformed.';
  if (quote.spread > MAX_SPREAD + 1e-9) return `Refreshed spread ${(quote.spread * 100).toFixed(1)}c exceeds the ${MAX_SPREAD * 100}c production ceiling.`;
  const selectedUp = side === 'UP';
  const refreshed: Prediction = {
    ...prediction,
    kalshi: {
      ...prediction.kalshi,
      askUp: selectedUp ? quote.ask : 1 - quote.bid,
      bidUp: selectedUp ? quote.bid : 1 - quote.ask,
      askDown: selectedUp ? 1 - quote.bid : quote.ask,
      bidDown: selectedUp ? 1 - quote.ask : quote.bid,
    },
  };
  if (!qualifiesVenueBuyEdge(refreshed, 'kalshi', side)) {
    return `Refreshed ${side} ask ${(quote.ask * 100).toFixed(1)}c no longer clears the active production venue buy rule.`;
  }
  return undefined;
}

function terminalEntryLimit(order: PaperOrder): number {
  return [...(order.entryExecutionObservations ?? [])].reverse().find((item) => Number.isFinite(item.limitPrice))?.limitPrice
    ?? order.initialSubmittedPrice ?? order.askPrice;
}

function terminalEntryMidpoint(order: PaperOrder): number {
  const observation = [...(order.entryExecutionObservations ?? [])].reverse()
    .find((item) => Number.isFinite(item.selectedBid) && Number.isFinite(item.selectedAsk));
  return observation ? (observation.selectedBid! + observation.selectedAsk!) / 2
    : ((order.issuanceBidPrice ?? order.bidPrice) + (order.issuanceAskPrice ?? order.askPrice)) / 2;
}

export function applyMakerMissTakerReserve(order: PaperOrder, stakeLimitCents: number, firstMaker: PaperOrder): string | undefined {
  if (order.venue !== 'kalshi') return 'Maker-miss taker fallback is implemented only for Kalshi.';
  const maximumPrice = makerMissTakerHardCeiling(terminalEntryLimit(firstMaker));
  if (!maximumPrice) return 'Final maker limit cannot produce a valid fallback ceiling.';
  const fill = estimatePaperFill(stakeLimitCents, maximumPrice, order.venue);
  if (!fill) return `${stakeLimitCents}c all-in cap cannot reserve the minimum quantity at the fallback ceiling.`;
  order.approvedMaximumPrice = maximumPrice;
  order.quantity = fill.quantity;
  order.requestedQuantity = fill.quantity;
  order.stakeCents = fill.stakeCents;
  order.feeCents = fill.feeCents;
  order.potentialPayoutCents = fill.potentialPayoutCents;
  return undefined;
}

export function applyTakerQuoteMovementReserve(order: PaperOrder, stakeLimitCents: number): string | undefined {
  if (order.venue !== 'kalshi') return 'Taker quote movement is implemented only for Kalshi.';
  const cap = takerQuoteCap(order.issuanceAskPrice ?? order.askPrice);
  if (!cap) return 'Issuance ask cannot produce a valid one-cent taker cap.';
  const fill = estimatePaperFill(stakeLimitCents, cap.maximumPrice, order.venue);
  if (!fill) return `${stakeLimitCents}c all-in cap cannot reserve the minimum quantity at the relaxed taker maximum.`;
  // Reserve and size at the worst price that may be submitted. The signed path uses the lower refreshed
  // ask when available and the ledger returns every unused whole cent after the authoritative fill.
  order.approvedMaximumPrice = cap.maximumPrice;
  order.quantity = fill.quantity;
  order.requestedQuantity = fill.quantity;
  order.stakeCents = fill.stakeCents;
  order.feeCents = fill.feeCents;
  order.potentialPayoutCents = fill.potentialPayoutCents;
  return undefined;
}

function contractId(prediction: Prediction, venue: 'polymarket' | 'kalshi'): string {
  if (venue === 'kalshi') return prediction.kalshi?.ticker ?? prediction.symbol;
  return prediction.market.url.split('/').filter(Boolean).at(-1) ?? prediction.symbol;
}

function venueQuote(prediction: Prediction, venue: 'polymarket' | 'kalshi', side: PositionSide): { ask: number; bid: number; closesAt: string } | null {
  if (venue === 'polymarket') {
    const ask = side === 'UP' ? prediction.market.askUp : prediction.market.askDown;
    const bid = side === 'UP' ? prediction.market.bidUp : prediction.market.bidDown;
    return ask !== undefined && bid !== undefined ? { ask, bid, closesAt: prediction.market.closesAt } : null;
  }
  if (!prediction.kalshi) return null;
  return side === 'UP'
    ? { ask: prediction.kalshi.askUp, bid: prediction.kalshi.bidUp, closesAt: prediction.kalshi.closesAt }
    : { ask: prediction.kalshi.askDown, bid: prediction.kalshi.bidDown, closesAt: prediction.kalshi.closesAt };
}

/**
 * Builds a candidate order for one mode, applying every deterministic risk check. Returns the reason
 * when it declines, because a silently skipped order is indistinguishable from a broken engine.
 */
function buildOrder(prediction: Prediction, side: PositionSide, status: TradingControlData, ledger: Ledger, calculationAt: string, modelVersion: string, mode: ExecutionMode, stakeLimitCents: number, venueFilter?: 'kalshi', eligibilityOverride?: SignalEligibility, paperExecutionPolicyVersion: string = PAPER_MANAGED_MAKER_EXECUTION_VERSION, minimumNetEdge = MIN_NET_EDGE): { order: PaperOrder } | { reason: string } {
  if (stakeLimitCents <= 0) return { reason: 'Stake sizing produces zero cents. Raise the budget or purchase percentage.' };
  const rejections: string[] = [];
  const candidates = status.venues.flatMap((readiness) => {
    if (!readiness.enabled || !readiness.tradeReady) return [];
    if (venueFilter && readiness.venue !== venueFilter) return [];
    const quote = venueQuote(prediction, readiness.venue, side);
    const entry = bestVenueEntry(prediction, readiness.venue, side);
    if (!entry || (minimumNetEdge > 0
      ? !qualifiesVenueBuyEdge(prediction, readiness.venue, side)
      : !(entry.netEdge > 1e-12))) return [];
    if (!quote || quote.ask > MAX_FILLABLE_ASK || quote.ask <= 0 || quote.bid <= 0 || quote.bid > quote.ask) return [];
    const spread = quote.ask - quote.bid;
    if (spread > MAX_SPREAD) { rejections.push(`${readiness.venue} spread ${(spread * 100).toFixed(1)}c exceeds the ${MAX_SPREAD * 100}c limit`); return []; }
    if (Date.parse(quote.closesAt) - Date.now() < MIN_TIME_TO_CLOSE_MS) { rejections.push(`${readiness.venue} contract is inside the final ${MIN_TIME_TO_CLOSE_MS / 1000}s`); return []; }
    const sizing = evaluateEntrySizing(stakeLimitCents, entry.netEdge);
    if (!sizing) { rejections.push('Entry sizing could not produce a valid whole-cent control amount.'); return []; }
    const fill = estimatePaperFill(sizing.stakeLimitCents, quote.ask, readiness.venue);
    if (!fill) {
      const priceCents = quote.ask * 100;
      const minimumQuantity = readiness.venue === 'kalshi' ? 0.01 : 1;
      const minimumCents = Math.ceil(minimumQuantity * priceCents - 1e-9) + venueFeeCents(readiness.venue, priceCents, minimumQuantity, 'taker');
      rejections.push(`${sizing.stakeLimitCents}c sized all-in cap is short of the ${minimumCents}c conservative reserve needed for ${minimumQuantity.toFixed(2)} ${readiness.venue} contract at ${priceCents.toFixed(1)}c`);
      return [];
    }
    // Signed venue cash already excludes principal committed to positions; subtracting open exposure
    // again would double-count it and incorrectly block funded orders.
    if (mode === 'live' && (readiness.balanceCents ?? 0) < fill.stakeCents) {
      rejections.push(`${readiness.venue} cash ${readiness.balanceCents ?? 0}c is below the ${fill.stakeCents}c stake`);
      return [];
    }
    return [{ venue: readiness.venue, quote, spread, fill, entry, sizing, score: -entry.netEdge }];
  }).sort((a, b) => a.score - b.score);
  const selected = candidates[0];
  if (!selected) return { reason: rejections[0] ?? 'No enabled venue had a usable quote' };
  const eligibility = eligibilityOverride ?? executionEligibility(prediction, side, ledger);
  return { order: {
    id: orderId(prediction, mode, side, ledger), logicalOrderId: orderId(prediction, mode, side, ledger), attemptNumber: 1,
    clientOrderId: orderId(prediction, mode, side, ledger), executionMode: mode,
    marketId: DEFAULT_MARKET_ID,
    // Explicit even with only one active strategy: retired long-shot rows remain in the shared ledger, so
    // relying on a default here would make a future construction-path mistake an accounting mistake.
    strategyId: EDGE_BINARY_BUY,
    // Stamped at creation so a later reconfiguration cannot reattribute this order's P&L.
    // Each track records the funding that actually bought the order. Stamping live's epoch onto a paper
    // order attributes a simulated result to a real funding that never paid for it, and survives forever
    // because records are never rewritten. See docs/paper-bankroll-fundings-design.md.
    ...(mode === 'live'
      ? { budgetEpochId: status.control.epochId }
      : { paperBankrollId: ledger.paperBudget.fundingId }),
    providerId: selected.venue,
    providerVariantId: status.tradingProviders?.find((provider) => provider.id === selected.venue)?.selectedVariantId,
    symbol: prediction.symbol, venue: selected.venue,
    contractId: contractId(prediction, selected.venue), side, status: 'pending_reservation',
    createdAt: new Date().toISOString(), calculationAt, closesAt: selected.quote.closesAt,
    modelProbabilityUp: prediction.modelProbabilityUp, confidence: prediction.confidence,
    entrySizingDecision: { ...selected.sizing },
    entryDecision: {
      version: 'entry-decision-v2',
      providerId: selected.venue,
      providerVariantId: status.tradingProviders?.find((provider) => provider.id === selected.venue)?.selectedVariantId,
      forecastModelVersion: modelVersion,
      executionPolicyVersion: mode === 'live' ? ENTRY_EXECUTION_POLICY_VERSION : paperExecutionPolicyVersion,
      policyVersion: BUY_POLICY_VERSION, calculationAt, side,
      probabilityUp: prediction.modelProbabilityUp, probabilityDown: 1 - prediction.modelProbabilityUp,
      selectedSideProbability: sideProbability(prediction, side), confidence: prediction.confidence,
      confidenceBreakdown: { ...prediction.confidenceBreakdown },
      actionableAsk: selected.quote.ask, actionableBid: selected.quote.bid,
      feeRate: selected.entry.feeRate, netEdge: selected.entry.netEdge, spread: selected.spread,
      secondsRemaining: Math.max(0, (Date.parse(selected.quote.closesAt) - Date.parse(calculationAt)) / 1000),
      qualifyingSnapshots: eligibility.qualifyingSnapshots, medianNetEdge: eligibility.medianNetEdge,
      // Recorded, never read by this path. `edgeSpike` is already computed for the (currently disarmed)
      // ceiling, and the numeric regime features are already computed for the regime label; both were
      // discarded at the order boundary, which is why no analysis could score them against realized money.
      edgeSpike: eligibility.edgeSpike,
      basis: prediction.basis ? { ...prediction.basis } : undefined,
      cycleRegime: prediction.cycleRegime ? { ...prediction.cycleRegime } : undefined,
      calibrationReplay: prediction.calibrationReplay ? {
        ...prediction.calibrationReplay,
        basisInput: prediction.calibrationReplay.basisInput ? { ...prediction.calibrationReplay.basisInput } : undefined,
        slowTerms: prediction.calibrationReplay.slowTerms.map((term) => ({ ...term })),
      } : undefined,
      settlementAverageEstimate: prediction.settlementAverageEstimate ? { ...prediction.settlementAverageEstimate } : undefined,
      factors: prediction.factors.map((factor) => ({ ...factor })),
    },
    // Top-level decision evidence is serialized with the order before any venue request or fill result.
    // Exact identity matching prevents a best-entry observation from leaking across providers/contracts.
    quoteTrajectorySpread: quoteTrajectoryForDecision(
      prediction.quoteTrajectorySpreads ?? prediction.quoteTrajectorySpread, {
      providerId: selected.venue, contractId: contractId(prediction, selected.venue),
      side, closesAt: selected.quote.closesAt,
    }),
    // Calibrated here rather than at forecast time: the estimate that predicts a fill is what
    // comparable attempts did, and only this path has the ledger to read them from.
    makerFillEstimate: (() => {
      const touch = prediction.makerFillEstimates?.[side] ?? prediction.makerFillEstimate ?? null;
      const cohort = makerCohortEvidence(ledger.orders, selected.fill.limitPriceCents / 100, selected.spread);
      return estimateMakerFill({
        touch, cohortLabel: cohort.label, cohortAttempts: cohort.accepted, cohortFills: cohort.fills,
      }) ?? undefined;
    })(),
    settlementAverageEstimate: prediction.settlementAverageEstimate,
    // Keep the legacy ask field issuance-denominated; submitted/repriced/fill terms have distinct fields.
    askPrice: selected.fill.limitPriceCents / 100, bidPrice: selected.quote.bid, spread: selected.spread,
    issuanceAskPrice: selected.quote.ask, issuanceBidPrice: selected.quote.bid, issuanceSpread: selected.spread,
    approvedMaximumPrice: selected.fill.limitPriceCents / 100,
    quantity: selected.fill.quantity, requestedQuantity: selected.fill.quantity,
    stakeCents: selected.fill.stakeCents, feeCents: selected.fill.feeCents,
    potentialPayoutCents: selected.fill.potentialPayoutCents,
  } };
}

const orderProbability = (order: Pick<PaperOrder, 'side' | 'modelProbabilityUp'>) => order.side === 'UP' ? order.modelProbabilityUp : 1 - order.modelProbabilityUp;
const entryFillPrice = (order: PaperOrder) => order.authoritativeFillPrice ?? order.initialSubmittedPrice ?? order.askPrice;
const expectedProfitCents = (order: PaperOrder) => order.potentialPayoutCents * orderProbability(order) - order.stakeCents;

interface PortfolioSelectionAudit {
  constraints: PortfolioConstraints;
  candidates: Array<{
    id: string; prediction: Prediction; decision: PortfolioDecisionView; builtOrder?: PaperOrder;
    cooldownRemainingMs: number; attempt?: LiveAttemptState;
    persistence?: SignalPersistenceState;
  }>;
}

function updatePortfolioDecisions(
  dashboard: DashboardData, status: TradingControlData, ledger: Ledger,
): { changed: boolean; audit: PortfolioSelectionAudit } {
  const now = new Date().toISOString();
  const next: Record<string, PortfolioDecisionView> = {};
  const built = new Map<string, PaperOrder>();
  const retryNumbers = new Map<string, number>();
  const cooldowns = new Map<string, number>();
  const attemptsByKey = new Map<string, LiveAttemptState>();
  const activeOrders = ledger.orders.filter((order) => order.executionMode === 'live'
    && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'));
  const exposures = activeOrders.map((order) => ({ symbol: order.symbol, closesAt: order.closesAt }));

  for (const prediction of dashboard.predictions.filter((item) => {
    if (!item.market.live) return false;
    const side = selectedSide(item);
    return qualifiesAsBuyEdge(item) || Boolean(side && liveAttemptState(item, side, ledger).takerFallback);
  })) {
    const entry = bestEntry(prediction);
    if (!entry) continue;
    const side = entry.side;
    const key = persistenceKey(prediction, side);
    const cooldownMs = reentryCooldownRemainingMs(ledger, prediction, 'live', side);
    cooldowns.set(key, cooldownMs);
    if (cooldownMs > 0) {
      next[key] = { state: 'blocked', reason: `Post-exit re-entry cooldown has ${Math.ceil(cooldownMs / 1000)}s remaining; fresh persistence is also required.`, updatedAt: now };
      continue;
    }
    const attempt = liveAttemptState(prediction, side, ledger);
    attemptsByKey.set(key, attempt);
    const { attempts, retry } = attempt;
    if (attempts.length && !retry.allowed) {
      const active = attempts.find((order) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain');
      next[key] = active
        ? { state: 'portfolio-selected', reason: `Existing live ${active.status.replace('_', ' ')} position occupies a constrained portfolio slot.`, expectedProfitCents: expectedProfitCents(active), updatedAt: now }
        : { state: 'blocked', reason: retry.reason, updatedAt: now };
      continue;
    }
    retryNumbers.set(key, retry.attemptNumber);
    const venueEntry = bestVenueEntry(prediction, 'kalshi', side);
    if (attempt.takerFallback ? !(venueEntry && venueEntry.netEdge > 1e-12) : !qualifiesVenueBuyEdge(prediction, 'kalshi', side)) {
      next[key] = { state: 'blocked', reason: `The Kalshi-specific ${side} quote does not clear this intent's edge and price gates.`, updatedAt: now };
      continue;
    }
    const maturity = attempt.eligibility;
    if (!maturity.eligible) {
      next[key] = { state: 'qualified', reason: `${attempt.takerFallback ? 'A zero-spend predecessor permits immediate fallback checks.' : 'Standalone expected-value policy passes; execution evidence is still collecting.'} ${maturity.reason}`, updatedAt: now };
      continue;
    }
    const candidate = buildOrder(prediction, side, status, ledger, dashboard.generatedAt, dashboard.modelVersion, 'live', Math.min(status.proposedStakeCents, maxLiveStakeCents()), 'kalshi', attempt.eligibility,
      PAPER_MANAGED_MAKER_EXECUTION_VERSION, attempt.takerFallback ? 0 : MIN_NET_EDGE);
    if ('reason' in candidate) {
      next[key] = { state: 'blocked', reason: candidate.reason, updatedAt: now };
      continue;
    }
    const decision = entryExecutionDecision(prediction, side, candidate.order, ledger, attempt);
    if (decision.executedStyle === 'taker') {
      const stakeLimit = candidate.order.entrySizingDecision?.stakeLimitCents ?? Math.min(status.proposedStakeCents, maxLiveStakeCents());
      const reserveFailure = decision.route === 'maker-miss-taker-fallback'
        ? applyMakerMissTakerReserve(candidate.order, stakeLimit, attempt.attempts[0]!)
        : applyTakerQuoteMovementReserve(candidate.order, stakeLimit);
      if (reserveFailure) {
        next[key] = { state: 'blocked', reason: reserveFailure, updatedAt: now };
        continue;
      }
    }
    built.set(key, candidate.order);
  }

  const constraints = portfolioConstraints();
  const selection = selectPortfolio([...built.entries()].map(([id, order]) => ({
    id, symbol: order.symbol, closesAt: order.closesAt, expectedProfitCents: expectedProfitCents(order),
  })), exposures, constraints);
  for (const item of selection) next[item.id] = {
    state: item.selected ? 'portfolio-selected' : 'blocked',
    reason: `${item.reason}${(retryNumbers.get(item.id) ?? 1) > 1 ? ` Fresh post-miss persistence authorizes entry episode ${retryNumbers.get(item.id)}/${MAX_ENTRY_EPISODES_PER_WINDOW}; its current edge selects maker or taker normally.` : ''}`,
    expectedProfitCents: item.expectedProfitCents, adjustedExpectedContributionCents: item.adjustedExpectedContributionCents,
    rank: item.rank ?? undefined, updatedAt: now,
  };
  const changed = JSON.stringify(ledger.portfolioDecisions) !== JSON.stringify(next);
  ledger.portfolioDecisions = next;
  const predictionsByKey = new Map(dashboard.predictions.flatMap((prediction) => {
    const side = selectedSide(prediction);
    return side ? [[persistenceKey(prediction, side), prediction] as const] : [];
  }));
  return {
    changed,
    audit: {
      constraints,
      candidates: Object.entries(next).flatMap(([id, decision]) => {
        const prediction = predictionsByKey.get(id);
        if (!prediction) return [];
        const side = selectedSide(prediction)!;
        const persistence = ledger.signalPersistence[persistenceKey(prediction, side)];
        return [{
          id, prediction, decision: { ...decision }, builtOrder: built.get(id) ? { ...built.get(id)! } : undefined,
          cooldownRemainingMs: cooldowns.get(id) ?? 0, attempt: attemptsByKey.get(id),
          persistence: persistence ? { ...persistence, observations: persistence.observations.map((observation) => ({ ...observation })) } : undefined,
        }];
      }),
    },
  };
}

async function resolveOutcome(order: PaperOrder): Promise<'UP' | 'DOWN' | 'INVALID' | null> {
  if (order.venue === 'kalshi') {
    const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(order.contractId)}`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { market?: { result?: string } };
    const result = body.market?.result?.toLowerCase();
    return result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : null;
  }
  const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(order.contractId)}`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) return null;
  const event = (await response.json() as Array<{ closed?: boolean; markets?: Array<{ closed?: boolean; outcomes?: string; outcomePrices?: string; umaResolutionStatus?: string }> }>)[0];
  const market = event?.markets?.[0];
  if (!event?.closed && !market?.closed) return null;
  const outcomes = JSON.parse(market?.outcomes ?? '["Up","Down"]') as string[];
  const prices = (JSON.parse(market?.outcomePrices ?? '[]') as string[]).map(Number);
  const winnerIndex = prices.findIndex((price) => price >= 0.999);
  if (winnerIndex < 0) return market?.umaResolutionStatus === 'resolved' ? 'INVALID' : null;
  const winner = outcomes[winnerIndex]?.toUpperCase();
  return winner === 'UP' || winner === 'DOWN' ? winner : 'INVALID';
}

async function settleDueOrders(ledger: Ledger): Promise<boolean> {
  let changed = false;
  for (const order of ledger.orders.filter((item) => item.status === 'open' && Date.parse(item.closesAt) <= Date.now())) {
    try {
      const outcome = await resolveOutcome(order);
      if (!outcome) continue;
      const payoutCents = outcome === 'INVALID' ? order.stakeCents : outcome === order.side ? order.potentialPayoutCents : 0;
      if (order.executionMode === 'live') await settleTradingBudget(order.stakeCents, payoutCents, order.venue, order.id);
      // Live cash is one real Kalshi balance and settles through the shared control whatever strategy
      // spent it. The paper bankroll is not: it is the edge policy's own counter, and crediting another
      // strategy's payout into it would inflate the edge policy's paper equity and its published track
      // record. Other strategies derive their paper equity from their own orders, so there is nothing to
      // credit here.
      else if (orderStrategyId(order) === EDGE_BINARY_BUY) {
        ledger.paperBudget.availableCents += payoutCents;
        ledger.paperBudget.realizedPnlCents += payoutCents - order.stakeCents;
      }
      order.status = outcome === 'INVALID' ? 'invalid' : outcome === order.side ? 'won' : 'lost';
      order.outcome = outcome === 'INVALID' ? undefined : outcome;
      order.payoutCents = payoutCents;
      order.pnlCents = payoutCents - order.stakeCents;
      order.actualPnlCents = payoutCents - (order.actualStakeCents ?? order.stakeCents);
      order.settledAt = new Date().toISOString();
      order.reason = outcome === 'INVALID' ? 'Venue resolved without a supported binary outcome; stake returned' : undefined;
      changed = true;
    } catch (error) {
      console.error(`Settlement failed for ${order.id}:`, error);
    }
  }
  return changed;
}

async function updateSoldCounterfactuals(ledger: Ledger): Promise<boolean> {
  let changed = false;
  // Every intentional full exit needs the same authoritative hold counterfactual as a switch. Without
  // it, profitable cash exits look successful even when they systematically surrender larger binary
  // payouts. Synthetic partial-fill children are excluded because their parent remains authoritative.
  for (const incumbent of ledger.orders.filter((order) => order.status === 'sold' && !order.id.includes(':exit:'))) {
    if (!incumbent.counterfactualHoldOutcome && Date.parse(incumbent.closesAt) <= Date.now()) {
      try {
        const outcome = await resolveOutcome(incumbent);
        if (outcome === 'UP' || outcome === 'DOWN') {
          incumbent.counterfactualHoldOutcome = outcome;
          const holdPayout = outcome === incumbent.side ? incumbent.potentialPayoutCents : 0;
          incumbent.counterfactualHoldPnlCents = holdPayout - (incumbent.actualStakeCents ?? incumbent.stakeCents);
          changed = true;
        }
      } catch { /* Venue resolution is retried on the next collector cycle. */ }
    }
    if (!incumbent.switchedToOrderId) continue;
    const replacement = ledger.orders.find((order) => order.id === incumbent.switchedToOrderId);
    const replacementTerminal = replacement && ['won', 'lost', 'invalid', 'sold', 'unfilled', 'rejected'].includes(replacement.status);
    if (incumbent.counterfactualHoldPnlCents !== undefined && replacementTerminal && incumbent.switchVsHoldCents === undefined) {
      incumbent.counterfactualSwitchPnlCents = (incumbent.actualPnlCents ?? incumbent.pnlCents ?? 0) + (replacement.actualPnlCents ?? replacement.pnlCents ?? 0);
      incumbent.switchVsHoldCents = incumbent.counterfactualSwitchPnlCents - incumbent.counterfactualHoldPnlCents;
      changed = true;
    }
  }
  return changed;
}

/**
 * Windows whose 15-second path the classifier could not characterise are refused entry.
 *
 * In-sample counterfactual over 321 settled live orders: trading only classified windows turns
 * -$14.98 into +$1.13, and the excluded `insufficient` cohort carried -$16.11 at -28.4% ROI. Every
 * live DOWN entry to date fell in that cohort. Clustered by settlement window neither side clears two
 * standard errors (+11.1% ±18.7 kept, -20.3% ±14.0 removed), so this is a restrictive bet on a
 * plausible mechanism rather than a proven filter — it can only remove trades, never add exposure.
 * MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME=false disables it.
 */
export function classifiedRegimeRequired(): boolean {
  return process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME !== 'false';
}

const regimeAdmits = (regime: string | undefined) => !classifiedRegimeRequired() || Boolean(regime && regime !== 'insufficient');

/**
 * Allocation headroom for one (provider, market) pair. Reservations are counted from this pair's own open
 * orders only: charging it the provider total would let one market's positions block a market that has
 * its own headroom, and charging it nothing would let two markets each spend the whole provider.
 */
function marketFundingFor(
  budgets: ProviderBudgetConfiguration,
  mode: ExecutionMode,
  providerId: TradingProviderId,
  marketId: MarketId,
  ledger: Ledger,
  modeEquityCents: number,
  availableCents: number,
): MarketFunding {
  const reservedCents = ledger.orders
    .filter((order) => order.executionMode === mode && orderProviderId(order) === providerId
      && orderMarketId(order) === marketId && (order.status === 'open' || order.status === 'pending_reservation'))
    .reduce((sum, order) => sum + order.stakeCents, 0);
  return marketFunding({
    providerId, marketId, mode, budget: providerBudget(budgets, providerId),
    modeEquityCents, availableCents, reservedCents,
  });
}

/** Paper trading is a continuous shadow: it keeps running while live automation is paused. */
/**
 * Crash recovery for a paper manager that never reached a terminal write. A dashboard ask touch is no
 * longer fill evidence: orphaned attempts expire and return their reservation conservatively.
 */
export function resolveRestingPaperOrders(_dashboard: DashboardData, ledger: Ledger): boolean {
  const now = Date.now();
  let changed = false;
  for (const order of ledger.orders) {
    if (order.executionMode !== 'paper' || order.status !== 'pending_reservation') continue;
    const expired = (order.restingUntil ? Date.parse(order.restingUntil) <= now : true)
      || Date.parse(order.closesAt) <= now;
    if (!expired) continue;
    const submittedPrice = order.initialSubmittedPrice ?? order.bidPrice;
    const submittedAtMs = Date.parse(order.entryExecutionObservations?.find((item) => item.event === 'paper_submitted')?.at ?? order.createdAt);
    order.status = 'unfilled';
    order.noFillReason = 'rested_no_fill';
    order.makerCompletedAt = new Date(now).toISOString();
    order.reason = 'Paper manager was interrupted; no complete public trade/queue evidence survived, so no fill was manufactured.';
    order.entryExecutionObservations = [...(order.entryExecutionObservations ?? []), {
      at: order.makerCompletedAt, event: 'paper_expired', limitPrice: submittedPrice,
      filledCount: 0, remainingCount: 0,
      restingDurationMs: Number.isFinite(submittedAtMs) ? Math.max(0, now - submittedAtMs) : undefined,
      reason: order.reason,
    }];
    ledger.paperBudget.availableCents += order.stakeCents;
    changed = true;
  }
  return changed;
}

export function applyPaperMakerSimulation(order: PaperOrder, result: PaperMakerSimulationResult, ledger: Ledger): void {
  const reservedCents = order.stakeCents;
  order.initialSubmittedPrice = result.initialPrice;
  order.restingUntil = result.restingUntil;
  order.makerCompletedAt = result.completedAt;
  order.entryExecutionObservations = result.observations;
  // Detached prospective observation at the maker's terminal moment, before settlement is known. It cannot
  // delay or influence execution, and production never reads its result.
  void recordMakerLifecycleOrder(order, result.completedAt)
    .catch((error) => console.error('Maker lifecycle sentinel decision write failed:', error));
  for (const observation of result.observations) {
    order.entryDirectionObservation = observeEntryDirection(
      order.entryDirectionObservation, order.issuanceAskPrice ?? order.askPrice, observation,
    );
  }
  order.liquidityRole = 'maker';
  if (result.filledCount <= 0) {
    ledger.paperBudget.availableCents += reservedCents;
    if (!result.evidenceComplete) {
      order.status = 'rejected';
      order.reason = 'Paper execution evidence was incomplete; the reservation was returned and the attempt was excluded rather than recorded as a maker miss.';
      return;
    }
    order.status = 'unfilled';
    order.noFillReason = 'rested_no_fill';
    order.reason = 'Exact-contract paper maker received no queue-qualified aggressive trade volume during live’s managed horizon.';
    return;
  }

  const purchaseCents = Math.ceil(result.purchaseCents - 1e-9);
  // The simulated fill is a managed maker fill, so it settles at the maker schedule and the unused
  // reserve is returned below — mirroring what live does with the venue's own `average_fee_paid`.
  const feeCents = venueFeeCents(order.venue, result.averagePrice * 100, result.filledCount, 'maker');
  const accountedStakeCents = purchaseCents + feeCents;
  if (accountedStakeCents > reservedCents) throw new Error(`Simulated paper fill cost ${accountedStakeCents}c exceeded its ${reservedCents}c reservation.`);
  order.status = 'open';
  order.filledCount = result.filledCount;
  order.quantity = result.filledCount;
  order.authoritativeFillPrice = result.averagePrice;
  order.feeCents = feeCents;
  order.stakeCents = accountedStakeCents;
  order.potentialPayoutCents = Math.round(result.filledCount * 100);
  order.reason = `${result.evidenceComplete ? 'Complete' : 'Partial'} public trade-print and displayed-queue evidence simulated the managed maker fill independently of live execution.`;
  ledger.paperBudget.availableCents += reservedCents - accountedStakeCents;
}

async function managePaperMakerOrder(order: PaperOrder, ledger: Ledger): Promise<void> {
  const managedRun = beginTaskCadenceRun('managed-maker');
  const quoteRun = beginTaskCadenceRun('exact-pre-submit-quote');
  try {
    // Use the complete calibration stamped before intent persistence. Rereading active state here could
    // apply a newly adopted fill assumption to an order carrying the preceding cohort identity.
    const calibration = order.paperFillCalibration;
    if (!isPaperFillCalibration(calibration)
      || calibration.appliedToPaperExecution !== order.entryDecision?.executionPolicyVersion) {
      throw new Error('Paper fill calibration provenance does not match the issued execution cohort.');
    }
    const result = await simulateManagedPaperMaker({
      side: order.side, requestedCount: order.quantity,
      maximumPrice: order.approvedMaximumPrice ?? order.askPrice,
      requestedStart: order.issuanceBidPrice ?? order.bidPrice,
    }, {
      quote: () => fetchKalshiManagedMakerQuote(order.contractId, order.side),
      tradesSince: (sinceMs) => fetchKalshiTradePrintsSince(order.contractId, sinceMs),
      onInitialQuoteSettled: (error) => error === undefined ? quoteRun.succeed() : quoteRun.fail(error),
      calibration,
    });
    managedRun.succeed();
    applyPaperMakerSimulation(order, result, ledger);
    // Detached and post-horizon: this can delay only its own evidence write, never paper accounting.
    void observePaperFinalEvidenceGrace(order, result)
      .catch((error) => console.error('Paper final-evidence grace observation failed:', error));
  } catch (error) {
    quoteRun.fail(error);
    managedRun.fail(error);
    const reservedCents = order.stakeCents;
    order.status = 'rejected';
    order.makerCompletedAt = new Date().toISOString();
    order.reason = `Independent paper maker simulation unavailable; reservation returned without classifying a fill miss. ${error instanceof Error ? error.message : 'Unknown simulation error'}`;
    order.entryExecutionObservations = [...(order.entryExecutionObservations ?? []), {
      at: order.makerCompletedAt, event: 'paper_expired', limitPrice: order.initialSubmittedPrice,
      filledCount: 0, remainingCount: 0, reason: order.reason,
    }];
    recordPaperFinalEvidenceUnavailable(order, order.reason);
    ledger.paperBudget.availableCents += reservedCents;
  }
}

/**
 * Simulates the taker branch as the IOC it is: refresh the exact contract, re-check the same gates live
 * re-checks, then cross whatever displayed depth the limit reaches.
 *
 * Live's taker path re-reads the quote before submitting and this mirror applies the same route-specific
 * structural ceiling, tick cushion, direction, and charged-fee edge checks. What it cannot mirror is a
 * signed transport race; paper uses the exact public quote and independently displayed depth.
 */
async function managePaperTakerOrder(order: PaperOrder, ledger: Ledger, authorize?: PaperTakerAuthorizer): Promise<void> {
  const quoteRun = beginTaskCadenceRun('exact-pre-submit-quote');
  const reservedCents = order.stakeCents;
  try {
    const quote = await fetchKalshiManagedMakerQuote(order.contractId, order.side);
    quoteRun.succeed();
    const refuse = (noFillReason: PaperOrder['noFillReason'], reason: string) => {
      order.status = 'unfilled';
      order.noFillReason = noFillReason;
      order.reason = reason;
      order.makerCompletedAt = new Date().toISOString();
      ledger.paperBudget.availableCents += reservedCents;
    };
    const fallback = order.entryExecutionDecision?.route === 'maker-miss-taker-fallback';
    const approvedMaximum = order.approvedMaximumPrice ?? order.askPrice;
    if (!fallback) {
      const cap = takerQuoteCap(order.issuanceAskPrice ?? order.askPrice);
      if (!cap) return refuse('pre_submit_quote_moved', 'Issuance ask cannot produce a valid one-cent taker cap.');
      if (!refreshedAskFitsTakerCap(quote.ask, cap)) {
        return refuse('pre_submit_quote_moved', `Refreshed ask ${(quote.ask * 100).toFixed(1)}c moved beyond the ${(cap.maximumPrice * 100).toFixed(1)}c taker cap.`);
      }
    }
    const terms = boundedTakerLimit({
      ask: quote.ask, maximumPrice: approvedMaximum,
      cushionTicks: fallback ? MAKER_MISS_TAKER_CUSHION_TICKS : 0, ranges: quote.ranges,
    });
    if (!terms) return refuse('pre_submit_quote_moved', 'Exact quote could not produce a valid venue-ladder limit.');
    const { limit, tickSize } = terms;
    if (limit + 1e-9 < quote.ask) return refuse('pre_submit_quote_moved', `Refreshed ask ${(quote.ask * 100).toFixed(1)}c exceeds the approved ${(approvedMaximum * 100).toFixed(1)}c cap.`);
    const refusal = authorize?.({ bid: quote.bid, ask: quote.ask, spread: quote.ask - quote.bid, limit, tickSize });
    if (refusal) return refuse('pre_submit_quote_moved', `Refreshed quote no longer authorizes taking: ${refusal}`);

    if (!quote.orderBook) {
      // `fetchKalshiManagedMakerQuote` swallows an order-book failure and returns the quote without one.
      // Sweeping an absent book would manufacture an `ioc_no_fill` out of a data outage and bias the very
      // fill rate this simulation exists to measure, so the attempt is excluded rather than classified.
      order.status = 'rejected';
      order.makerCompletedAt = new Date().toISOString();
      order.reason = 'Exact-contract order book was unavailable; the reservation was returned and the attempt was excluded rather than recorded as an IOC miss.';
      ledger.paperBudget.availableCents += reservedCents;
      return;
    }
    const fill = immediateBuyFill(quote.orderBook, order.side, limit, order.quantity);
    order.entryExecutionObservations = [...(order.entryExecutionObservations ?? []), {
      at: new Date().toISOString(), event: fill.filledCount > 0 ? 'paper_fill' : 'paper_expired',
      selectedBid: quote.bid, selectedAsk: quote.ask, spread: quote.ask - quote.bid,
      limitPrice: limit, filledCount: fill.filledCount,
      remainingCount: Number((order.quantity - fill.filledCount).toFixed(2)),
      displayedAtLimit: fill.displayedAtLimit,
    }];
    order.makerCompletedAt = new Date().toISOString();
    if (fill.filledCount <= 0) {
      return refuse('ioc_no_fill', 'Exact-contract paper IOC found no displayed depth at or inside the refreshed ask.');
    }
    // An IOC buy lifts a resting offer, so it pays the taker schedule. Costs round up, per AGENTS.md §1.
    const purchaseCents = Math.ceil(fill.cashCents - 1e-9);
    const feeCents = venueFeeCents(order.venue, fill.averagePrice * 100, fill.filledCount, 'taker');
    const accountedStakeCents = purchaseCents + feeCents;
    if (accountedStakeCents > reservedCents) throw new Error(`Simulated paper IOC cost ${accountedStakeCents}c exceeded its ${reservedCents}c reservation.`);
    order.status = 'open';
    order.liquidityRole = 'taker';
    order.filledCount = fill.filledCount;
    order.quantity = fill.filledCount;
    order.authoritativeFillPrice = fill.averagePrice;
    order.initialSubmittedPrice = quote.ask;
    order.feeCents = feeCents;
    order.stakeCents = accountedStakeCents;
    order.potentialPayoutCents = Math.round(fill.filledCount * 100);
    order.reason = `Exact-contract paper IOC crossed ${fill.levelsConsumed} displayed level(s) at or inside the refreshed ask.`;
    ledger.paperBudget.availableCents += reservedCents - accountedStakeCents;
  } catch (error) {
    quoteRun.fail(error);
    order.status = 'rejected';
    order.makerCompletedAt = new Date().toISOString();
    order.reason = `Independent paper taker simulation unavailable; reservation returned without classifying a fill miss. ${error instanceof Error ? error.message : 'Unknown simulation error'}`;
    ledger.paperBudget.availableCents += reservedCents;
  }
}

async function managePaperEntryOrders(orders: PaperOrder[], ledger: Ledger, authorizers?: Map<string, PaperTakerAuthorizer>): Promise<boolean> {
  if (!orders.length) return false;
  await Promise.all(orders.map((order) => order.paperEntryRoute === 'taker'
    ? managePaperTakerOrder(order, ledger, authorizers?.get(order.id))
    : managePaperMakerOrder(order, ledger)));
  return true;
}

type TakerAuthorizationQuote = { bid: number; ask: number; spread: number; limit: number; tickSize: number };
type PaperTakerAuthorizer = (quote: TakerAuthorizationQuote) => string | undefined;

async function runPaper(dashboard: DashboardData, status: TradingControlData, ledger: Ledger, regimeGate: RegimeGateStatus, budgets: ProviderBudgetConfiguration, startedOrders: PaperOrder[] = [], authorizers?: Map<string, PaperTakerAuthorizer>): Promise<boolean> {
  if (ledger.paperBudget.availableCents <= 0) return false;
  // The mirror obeys policy-level live entry rules, the adaptive regime gate included. It remains
  // independent from live operational switches so simulation continues while real-money trading is off.
  if (!regimeGate.allowsEntries) return false;
  const paperProviders = new Set(status.tradingProviders?.filter((provider) => provider.paperEnabled || provider.liveEnabled).map((provider) => provider.id) ?? status.control.enabledVenues);
  const open = ledger.orders.filter((order) => order.executionMode === 'paper' && (order.status === 'open' || order.status === 'pending_reservation'));
  if (open.length >= maximumOpenPositions()) return false;
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return false;
  const qualifiedPredictions = dashboard.predictions
    .filter((item) => item.market.live && assetAdmitted(item.symbol))
    .filter((item) => qualifiesAsBuyEdge(item) || (() => {
      const side = selectedSide(item);
      return Boolean(side && paperAttempts(ledger, item, side).length > 0);
    })());
  if (!qualifiedPredictions.length) return false;
  // Read once before intent construction. The generated execution identity and full provenance travel
  // together on the order, so an adoption between creation and management cannot blend cohorts. A bad
  // paper-only store withholds this lane without throwing across the shared orchestrator into funded live.
  let paperCalibration: PaperFillCalibration;
  try {
    paperCalibration = await getActivePaperFillCalibration();
  } catch (error) {
    console.error('Paper fill calibration unavailable; paper entry withheld.', error);
    return false;
  }
  const paperExecutionPolicyVersion = paperCalibration.appliedToPaperExecution;
  const equity = ledger.paperBudget.availableCents;
  const stakeLimit = Math.min(status.control.perTradeCents, maximumPaperStakeCents(), equity);
  let terminalizedFallback = false;
  const candidates = qualifiedPredictions
    .flatMap((prediction) => {
      const side = selectedSide(prediction);
      if (!side) return [];
      if (reentryCooldownRemainingMs(ledger, prediction, 'paper', side) > 0) return [];
      const logicalId = orderId(prediction, 'paper', side, ledger);
      const attempts = paperAttempts(ledger, prediction, side);
      const episode = adaptiveEntryEpisodeDecision(attempts, paperExecutionPolicyVersion);
      if (!episode.allowed) return [];
      const eligibility: SignalEligibility = episode.takerFallback
        ? { eligible: true, reason: 'Authoritative predecessor permits immediate fresh fallback checks.', cycleAgeMs: 0, remainingMs: 0, qualifyingSnapshots: 1, medianNetEdge: null, edgeSpike: null }
        : evaluateEntryEpisodePersistence(ledger.signalPersistence[persistenceKey(prediction, side)], Date.now());
      if (!eligibility.eligible) return [];
      const candidate = buildOrder(prediction, side, {
        ...status, venues: status.venues.map((readiness) => ({ ...readiness, enabled: paperProviders.has(readiness.venue) })),
      }, ledger, dashboard.generatedAt, dashboard.modelVersion, 'paper', stakeLimit, 'kalshi', eligibility,
      paperExecutionPolicyVersion, episode.takerFallback ? 0 : MIN_NET_EDGE);
      if ('reason' in candidate) {
        if (episode.takerFallback) {
          terminalizeAdaptiveContinuation(attempts, candidate.reason);
          terminalizedFallback = true;
        }
        return [];
      }
      candidate.order.paperFillCalibration = { ...paperCalibration };
      candidate.order.logicalOrderId = logicalId;
      candidate.order.attemptNumber = episode.attemptNumber;
      candidate.order.entryEpisode = episode.attemptNumber;
      candidate.order.retryOfOrderId = episode.retryOfOrderId;
      candidate.order.requalifiedAfterOrderId = episode.retryOfOrderId;
      candidate.order.id = entryEpisodeId(logicalId, episode.attemptNumber);
      candidate.order.clientOrderId = candidate.order.id;
      candidate.order.executionMirrorPair = executionMirrorPairStamp(candidate.order);
      return [{ prediction, order: candidate.order, portfolioKey: persistenceKey(prediction, side), eligibility, episode, attempts }];
    })
    // Funding is a feasibility filter applied after candidates exist, so a pair without allocation
    // headroom drops out while another provider's candidate for the same window survives.
    .filter(({ order, episode, attempts }) => {
      const funding = marketFundingFor(budgets, 'paper', orderProviderId(order),
        orderMarketId(order), ledger, equity, ledger.paperBudget.availableCents);
      if (order.stakeCents <= funding.spendableCents) return true;
      if (episode.takerFallback) {
        terminalizeAdaptiveContinuation(attempts, funding.reason);
        terminalizedFallback = true;
      }
      return false;
    });

  // Keep the same classified-path admission rule used by live candidate selection, while recording the
  // label on the simulated order so later cohorts can still be audited.
  const withRegime = await Promise.all(candidates.map(async (item) => ({
    ...item, regime: (await cycleRegimeFor(item.order.symbol, item.order.closesAt))?.regime,
  })));
  for (const item of withRegime) item.order.entryCycleRegime = item.regime;
  const eligible = withRegime.filter((item) => regimeAdmits(item.regime));
  const selected = selectPortfolio(eligible.map(({ order }) => ({
    id: order.id, symbol: order.symbol, closesAt: order.closesAt, expectedProfitCents: expectedProfitCents(order),
  })), open.map((order) => ({ symbol: order.symbol, closesAt: order.closesAt })), portfolioConstraints())
    .filter((item) => item.selected).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  let placed = 0;
  for (const choice of selected) {
    if (open.length + placed >= maximumOpenPositions()) break;
    const built = eligible.find(({ order }) => order.id === choice.id);
    if (!built || ledger.paperBudget.availableCents <= 0) continue;
    // Reserve the same issuance-sized quantity live would submit. The independent manager refreshes
    // the exact contract before choosing its first limit; unlike the old `restAtBid` path it does not
    // buy extra paper quantity merely because the passive limit is cheaper than the issuance ask.
    // SPEC 12.2: the mirror runs "the same versioned episode boundary and route decision". Paper used to
    // Route through the same decision function as live. The rule layer remains mode-free; paper owns
    // independent fill evidence and capital but not a different maker-to-taker sequence.
    const baselineRoute = entryExecutionDecision(built.prediction, built.order.side, built.order, ledger, {
      eligibility: built.eligibility, takerFallback: built.episode.takerFallback,
      requalifiedAfterOrderId: built.episode.retryOfOrderId,
    });
    const route = baselineRoute;
    const continuationRefusal = terminalizeRefusedAdaptiveContinuation(
      built.attempts, built.episode.attemptNumber > 1 || Boolean(built.episode.takerFallback), route,
    );
    if (continuationRefusal) {
      terminalizedFallback = true;
      continue;
    }
    const resting: PaperOrder = {
      ...built.order, status: 'pending_reservation',
      liquidityRole: route.executedStyle, entryExecutionDecision: route, paperEntryRoute: route.executedStyle,
    };
    if (route.executedStyle === 'taker') {
      // Fallback quantity is reserved conservatively at its structural ceiling; the exact public quote
      // chooses only the lower two-tick IOC limit and returns unused paper reserve.
      const stakeLimit = resting.entrySizingDecision?.stakeLimitCents ?? resting.stakeCents;
      const reserveFailure = route.route === 'maker-miss-taker-fallback'
        ? applyMakerMissTakerReserve(resting, stakeLimit, built.attempts[0]!)
        : applyTakerQuoteMovementReserve(resting, stakeLimit);
      if (reserveFailure) {
        if (built.episode.takerFallback) {
          terminalizeAdaptiveContinuation(built.attempts, reserveFailure);
          terminalizedFallback = true;
        }
        continue;
      }
    }
    const funding = marketFundingFor(budgets, 'paper', orderProviderId(resting), orderMarketId(resting), ledger,
      ledger.paperBudget.availableCents, ledger.paperBudget.availableCents);
    if (resting.stakeCents > funding.spendableCents) {
      if (built.episode.takerFallback) {
        terminalizeAdaptiveContinuation(built.attempts, funding.reason);
        terminalizedFallback = true;
      }
      continue;
    }
    ledger.paperBudget.availableCents -= resting.stakeCents;
    ledger.orders.push(resting);
    startedOrders.push(resting);
    authorizers?.set(resting.id, (quote) => {
      if (route.route === 'maker-miss-taker-fallback') {
        const probability = entrySideProbability(built.prediction.modelProbabilityUp, built.order.side);
        const refusal = makerMissTakerQuoteRefusal({
          probability, quantity: resting.quantity,
          referenceMidpoint: terminalEntryMidpoint(built.attempts.at(-1)!), quote,
        });
        if (!refusal) {
          resting.signedTakerLimit = quote.limit;
          resting.signedTakerNetEdge = makerMissTakerNetEdge({ probability, quantity: resting.quantity, limit: quote.limit });
          resting.signedTakerQuoteAt = new Date().toISOString();
        }
        return refusal;
      }
      const refreshed = entryExecutionDecision(built.prediction, built.order.side, resting, ledger, { eligibility: built.eligibility }, quote);
      return refreshed.executedStyle === 'taker' ? undefined : refreshed.reason;
    });
    placed += 1;
  }
  if (terminalizedFallback) await writeLedger(ledger);
  return placed > 0 || terminalizedFallback;
}

/**
 * Adds an authoritative matched-live overlay without changing the independent paper execution result.
 * Quantity is capped at both observed live fill and the paper intent's original requested quantity.
 */
export function attachMatchedLiveFillShadow(orders: PaperOrder[], liveOrder: PaperOrder, capturedAt = new Date().toISOString()): boolean {
  if (liveOrder.executionMode !== 'live' || (liveOrder.filledCount ?? 0) <= 0 || liveOrder.authoritativeFillPrice === undefined) return false;
  const prospectivePairId = liveOrder.executionMirrorPair?.id;
  const candidates = orders.filter((order) => order.executionMode === 'paper' && !order.id.includes(':exit:')
    && (prospectivePairId
      ? order.executionMirrorPair?.id === prospectivePairId
      : order.symbol === liveOrder.symbol && order.side === liveOrder.side && order.closesAt === liveOrder.closesAt
        && Math.abs(Date.parse(order.createdAt) - Date.parse(liveOrder.createdAt)) <= 60_000))
    .sort((a, b) => Math.abs(Date.parse(a.createdAt) - Date.parse(liveOrder.createdAt)) - Math.abs(Date.parse(b.createdAt) - Date.parse(liveOrder.createdAt)));
  const paperOrder = candidates[0];
  if (!paperOrder) return false;
  const quantity = Number(Math.min(liveOrder.filledCount ?? 0, paperOrder.requestedQuantity ?? paperOrder.quantity).toFixed(2));
  if (!(quantity > 0)) return false;
  const liveQuantity = liveOrder.filledCount ?? quantity;
  const feeCents = (liveOrder.actualFeeCents ?? liveOrder.feeCents) * quantity / liveQuantity;
  const purchaseCents = quantity * liveOrder.authoritativeFillPrice * 100;
  paperOrder.matchedLiveFill = {
    version: 'matched-live-fill-shadow-v1', liveOrderId: liveOrder.id,
    liveVenueOrderId: liveOrder.venueOrderId, capturedAt, quantity,
    fillPrice: liveOrder.authoritativeFillPrice, purchaseCents, feeCents,
    stakeCents: purchaseCents + feeCents,
  };
  liveOrder.matchedPaperOrderId = paperOrder.id;
  return true;
}

async function executePreparedLiveBuy(
  order: PaperOrder, status: TradingControlData, ledger: Ledger,
  authorizeTakerQuote?: (quote: TakerAuthorizationQuote) => string | undefined,
  choiceSet?: PortfolioChoiceSetRecord,
): Promise<void> {
  const executionStyle = order.entryExecutionDecision?.executedStyle ?? 'maker';
  beginLiveTransaction(`Managing live ${order.symbol} ${executionStyle} entry.`);
  try {
  ledger.orders.push(order);
  await writeLedger(ledger);
  // The authoritative intent is durable before either detached observation starts. Neither can delay
  // reserve, quote, placement, or cancellation, and production never reads their result.
  void recordMakerRestrictionOrder(order)
    .catch((error) => console.error('Maker restriction sentinel decision write failed:', error));
  if (choiceSet) void recordPortfolioChoiceSet(choiceSet)
    .catch((error) => console.error('Portfolio choice-set decision write failed:', error));
  try {
    await reserveTradingBudget(order.stakeCents, order.venue, order.id);
  } catch (error) {
    order.status = 'rejected';
    order.reason = error instanceof Error ? error.message : 'Budget reservation failed';
    return;
  }
  try {
    const onAccepted = async (venueOrderId: string, exchangeIndex: number) => {
      order.venueOrderId = venueOrderId;
      order.venueExchangeIndex = exchangeIndex;
      await writeLedger(ledger);
    };
    const onObservation = async (observation: NonNullable<PaperOrder['entryExecutionObservations']>[number]) => {
      order.entryExecutionObservations = [...(order.entryExecutionObservations ?? []), observation];
      if (executionStyle === 'maker') {
        order.entryDirectionObservation = observeEntryDirection(
          order.entryDirectionObservation, order.issuanceAskPrice ?? order.askPrice, observation,
        );
      }
      if (order.initialSubmittedPrice === undefined && observation.event === 'create_quote' && observation.limitPrice !== undefined) {
        order.initialSubmittedPrice = observation.limitPrice;
      }
      // No I/O here: telemetry must not alter the managed order's quote/amend/cancel timing. The
      // completed path is persisted with the terminal result; accepted venue identity remains the
      // separately awaited crash-recovery boundary.
    };
    const approvedMaximumPrice = order.approvedMaximumPrice ?? order.askPrice;
    const managedRun = executionStyle === 'maker' ? beginTaskCadenceRun('managed-maker') : undefined;
    let fill: Awaited<ReturnType<typeof placeKalshiBuy>>;
    try {
      fill = executionStyle === 'taker'
        ? await placeKalshiTakerBuy({
          ticker: order.contractId, positionSide: order.side, maximumPriceCents: approvedMaximumPrice * 100,
          count: order.quantity, clientOrderId: order.clientOrderId ?? order.id, onAccepted, onObservation,
          cushionTicks: order.entryExecutionDecision?.route === 'maker-miss-taker-fallback' ? MAKER_MISS_TAKER_CUSHION_TICKS : 0,
          authorizeQuote: authorizeTakerQuote,
        })
        : await placeKalshiBuy({
          ticker: order.contractId, positionSide: order.side, priceCents: approvedMaximumPrice * 100,
          startPriceCents: (order.issuanceBidPrice ?? order.bidPrice) * 100,
          count: order.quantity, clientOrderId: order.clientOrderId ?? order.id, onAccepted, onObservation,
        });
      managedRun?.succeed();
    } catch (error) {
      managedRun?.fail(error);
      throw error;
    }
    order.venueOrderId = fill.venueOrderId;
    order.venueExchangeIndex = fill.exchangeIndex;
    order.filledCount = fill.filledCount;
    order.liquidityRole = fill.liquidityRole;
    order.entryExecutionObservations = fill.executionObservations;
    // Live counterpart of the paper hook: recorded once the maker's observation series is terminal and
    // before settlement is known. Detached, and never read by execution.
    if (order.liquidityRole === 'maker') void recordMakerLifecycleOrder(order)
      .catch((error) => console.error('Maker lifecycle sentinel decision write failed:', error));
    const reservedCents = order.stakeCents;
    if (fill.filledCount > 0) {
      const actualPurchaseCents = fill.filledCount * fill.averagePriceCents;
      const exactStakeCents = actualPurchaseCents + fill.feeCents;
      const accountedStakeCents = Math.ceil(exactStakeCents - 1e-9);
      if (accountedStakeCents > reservedCents || exactStakeCents > status.proposedStakeCents + 1e-9) throw new Error(`Kalshi fill cost ${exactStakeCents.toFixed(4)}c exceeded the ${status.proposedStakeCents}c all-in purchase cap.`);
      order.quantity = fill.filledCount;
      order.authoritativeFillPrice = fill.averagePriceCents / 100;
      order.feeCents = fill.feeCents;
      order.actualPurchaseCents = actualPurchaseCents;
      order.actualFeeCents = fill.feeCents;
      order.actualStakeCents = exactStakeCents;
      order.stakeCents = accountedStakeCents;
      order.potentialPayoutCents = Math.round(fill.filledCount * 100);
      order.status = 'open';
      if (reservedCents > accountedStakeCents) await releaseTradingBudget(reservedCents - accountedStakeCents, order.venue, order.id);
      attachMatchedLiveFillShadow(ledger.orders, order);
    } else {
      order.status = 'unfilled';
      order.noFillReason = executionStyle === 'taker' ? 'ioc_no_fill' : 'rested_no_fill';
      order.makerCompletedAt = new Date().toISOString();
      order.reason = executionStyle === 'taker'
        ? 'Marketable IOC limit received no fill and left no resting remainder; no money was spent.'
        : 'Managed post-only maker limit rested for 12 seconds but received no fill before its remainder was canceled; no money was spent.';
      await releaseTradingBudget(reservedCents, order.venue, order.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live order placement failed';
    const definitivePostOnlyCross = message.toLowerCase().includes('post only cross');
    const definitiveTakerSkip = message.startsWith('Taker not submitted:');
    order.status = definitivePostOnlyCross || definitiveTakerSkip ? 'unfilled' : 'rejected';
    order.noFillReason = definitivePostOnlyCross ? 'post_only_race' : definitiveTakerSkip ? 'pre_submit_quote_moved' : undefined;
    order.reason = definitivePostOnlyCross
      ? 'Post-only acknowledgement race remained after three refreshed submissions with progressive tick backoff; Kalshi rejected it before placement and no money was spent.'
      : message;
    if (definitivePostOnlyCross || definitiveTakerSkip) {
      order.makerCompletedAt = new Date().toISOString();
      await releaseTradingBudget(order.stakeCents, order.venue, order.id).catch(() => undefined);
    } else {
      // A transport/schema/cancellation failure is not evidence that Kalshi rejected the request.
      // Keep the full reservation and durable client id until authoritative reconciliation proves
      // whether an order or fill exists.
      order.status = 'uncertain';
      order.reason = `Ambiguous live order state; reservation retained pending Kalshi reconciliation. ${message}`;
      if (order.boundedTakerExperiment?.execution === 'treatment-taker') {
        order.boundedTakerExperiment.safetyStoppedAt = new Date().toISOString();
        order.boundedTakerExperiment.safetyStopReason = `Treatment order ${order.id} became ambiguous: ${message}`;
      }
      automaticReconciliationRequested = true;
      await suspendTrading(`Live order uncertain: ${order.reason}`);
    }
  }
  } finally {
    endLiveTransaction();
  }
}

function exitUncertainty(confidence: number): number {
  return Math.max(0.03, Math.min(0.15, (1 - confidence) * 0.25));
}

interface ExitObservationTerms {
  quote: { bid: number; ask: number; closesAt: string };
  exitFeeCents: number;
  exactCostCents: number;
  ownedSideProbability: number;
}

function exitObservationTerms(order: PaperOrder, prediction: Prediction): ExitObservationTerms | null {
  const quote = venueQuote(prediction, order.venue, order.side);
  if (!quote || quote.bid <= 0 || quote.bid >= 1 || quote.ask <= 0 || quote.ask > 1 || quote.bid > quote.ask) return null;
  const exitFeeCents = venueFeeCents(order.venue, quote.bid * 100, order.quantity, 'taker');
  const exactCostCents = order.actualStakeCents ?? order.stakeCents;
  const ownedSideProbability = sideProbability(prediction, order.side);
  if (![exitFeeCents, exactCostCents, ownedSideProbability].every(Number.isFinite)
    || exitFeeCents < 0 || exactCostCents <= 0) return null;
  return { quote, exitFeeCents, exactCostCents, ownedSideProbability };
}

function lifecycleObservation(
  order: PaperOrder, prediction: Prediction, observedAt: string, terms: ExitObservationTerms,
  netLiquidationCents: number,
): PositionLifecycleObservation {
  const book = order.venue === 'kalshi' ? observeKalshiOrderBook(order.contractId) : undefined;
  const depth = selectedSideDepth(book, order.side, terms.quote.bid, terms.quote.ask);
  const fill = immediateSellFill(book, order.side, terms.quote.bid, order.quantity);
  const fillFeeCents = fill.filledCount > 0
    ? venueFeeCents(order.venue, fill.averagePrice * 100, fill.filledCount, 'taker') : 0;
  return {
    at: observedAt,
    exitIocSimulation: {
      version: 'exit-ioc-depth-v1', evidenceComplete: Boolean(book), filledCount: fill.filledCount,
      averagePrice: fill.averagePrice, grossProceedsCents: fill.cashCents, feeCents: fillFeeCents,
      netProceedsCents: fill.cashCents - fillFeeCents,
      remainingCount: Math.max(0, Math.round((order.quantity - fill.filledCount) * 100) / 100),
    },
    selectedBid: terms.quote.bid, selectedAsk: terms.quote.ask,
    spread: terms.quote.ask - terms.quote.bid,
    bestBidDepth: depth.bestBidDepth, bestAskDepth: depth.bestAskDepth, depthImbalance: depth.depthImbalance,
    netLiquidationCents, exitFeeCents: terms.exitFeeCents,
    exactCostCents: terms.exactCostCents,
    unrealizedPnlCents: netLiquidationCents - terms.exactCostCents,
    unrealizedReturn: (netLiquidationCents - terms.exactCostCents) / terms.exactCostCents,
    ownedSideProbability: terms.ownedSideProbability, confidence: prediction.confidence,
    basisPercent: prediction.basis?.basisPercent, cycleRegime: prediction.cycleRegime?.regime,
    secondsRemaining: Math.max(0, (Date.parse(order.closesAt) - Date.parse(observedAt)) / 1_000),
  };
}

/** Public-data-only continuation used after production has sold; it cannot reach an order function. */
function continuationExitObservation(
  order: PaperOrder, prediction: Prediction, observedAt: string,
): PositionLifecycleObservation | null {
  const terms = exitObservationTerms(order, prediction);
  if (!terms) return null;
  const netLiquidationCents = order.quantity * 100 * terms.quote.bid - terms.exitFeeCents;
  if (!Number.isFinite(netLiquidationCents)) return null;
  return lifecycleObservation(order, prediction, observedAt, terms, netLiquidationCents);
}

function applyExitObservation(order: PaperOrder, prediction: Prediction, observedAt: string): ReturnType<typeof evaluateExitPolicy> {
  const terms = exitObservationTerms(order, prediction);
  if (!terms) return null;
  const decision = evaluateExitPolicy({
    observedAt, side: order.side, quantity: order.quantity,
    exactCostCents: terms.exactCostCents,
    executableBid: terms.quote.bid, exitFeeCents: terms.exitFeeCents,
    ownedSideProbability: terms.ownedSideProbability,
    uncertainty: exitUncertainty(prediction.confidence),
    profitLockArmedAt: order.profitLockArmedAt,
    peakNetLiquidationCents: order.peakNetLiquidationCents,
    peakNetProfitPercent: order.peakNetProfitPercent,
    peakOwnedSideProbability: order.peakOwnedSideProbability,
    peakObservedAt: order.peakObservedAt,
  });
  if (!decision) return null;
  order.profitLockArmedAt = decision.profitLockArmedAt;
  order.peakNetLiquidationCents = decision.peakNetLiquidationCents;
  order.peakNetProfitPercent = decision.peakNetProfitPercent;
  order.peakOwnedSideProbability = decision.peakOwnedSideProbability;
  order.peakObservedAt = decision.peakObservedAt;
  order.latestNetLiquidationCents = decision.netLiquidationCents;
  order.latestNetProfitPercent = decision.netProfitPercent;
  order.latestOwnedSideProbability = terms.ownedSideProbability;
  order.latestExitObservationAt = observedAt;
  if (!order.positionObservations?.some((observation) => observation.at === observedAt)) {
    const observation = lifecycleObservation(order, prediction, observedAt, terms, decision.netLiquidationCents);
    order.positionObservations = [...(order.positionObservations ?? []), observation];
    void recordExitPolicySentinelObservation(order, observation)
      .catch((error) => console.error('Exit policy sentinel observation write failed:', error));
  }
  return decision;
}

function clearEntryPersistence(ledger: Ledger, order: PaperOrder): void {
  const key = `${order.symbol}:${order.side}:${order.closesAt}`;
  delete ledger.signalPersistence[key];
  delete ledger.portfolioDecisions[key];
}

/**
 * Durable identity for the paper exit fill simulation.
 *
 * Before v1 there was no simulation at all: the paper exit marked itself `sold` at the modelled net
 * liquidation value unconditionally, so every exit paper decided on completed. Live's reduce-only IOC
 * completed 57.5% of the time over the same period, which made `paper - live` uninterpretable in the one
 * place paper was claiming an outcome live could not have achieved.
 */
export const PAPER_EXIT_FILL_VERSION = 'paper-ioc-exit-depth-v1';

/**
 * Simulates the reduce-only exit as the immediate-or-cancel taker it actually is.
 *
 * `placeKalshiSell` sends `time_in_force: 'immediate_or_cancel'`, `post_only: false`, `reduce_only: true`
 * and comes back `liquidityRole: 'taker'`. It therefore crosses displayed bids at or above
 * `decision.executableBid` once and cancels the rest. This mirrors that, including the two outcomes the
 * old code could not express — a partial fill that retains the remainder, and a no-fill that keeps the
 * whole position — and it mirrors live's rule that neither one is automatically retried, which
 * `standaloneExitAttemptedAt` already enforces for both tracks.
 *
 * It is not a full mirror and must not be read as one. Live can also fail on a venue error, an ambiguous
 * response, or a reconciliation contradiction; paper has no analogue for any of those and does not invent
 * one. What it does now model is the depth question, which is what decides most real no-fills.
 */
export function executePaperStandaloneExit(
  order: PaperOrder, decision: NonNullable<ReturnType<typeof evaluateExitPolicy>>, ledger: Ledger,
  book: BinaryOrderBook | undefined = order.venue === 'kalshi' ? observeKalshiOrderBook(order.contractId) : undefined,
  nowMs: number = Date.now(),
): void {
  // Evidence before outcome. `observeKalshiOrderBook` can miss, and an absent book is not an empty book:
  // recording it as a no-fill would both understate paper's exit completion rate and — because
  // `standaloneExitAttemptedAt` permanently disables retry for both tracks — strand the position with
  // exits switched off. The managed maker simulation makes the same distinction via `evidenceComplete`.
  // Venue-agnostic on purpose. Scoping this to Kalshi would fail *open* on any future paper-capable
  // venue with no book source: the sweep would return zero, the exit would be stamped as a genuine
  // no-fill, and `standaloneExitAttemptedAt` would strand the position with retry disabled. New venues
  // fail closed (AGENTS.md §0), so no book means no classification, whoever the venue is.
  if (!book) {
    order.reason = `${decision.policy} exit deferred: no exact-contract order book was available to price the reduce-only IOC. The attempt is not recorded as a fill miss and will be re-evaluated.`;
    return;
  }
  const attemptedAt = new Date(nowMs).toISOString();
  order.standaloneExitPolicy = decision.policy;
  order.standaloneExitAttemptedAt = attemptedAt;
  order.standaloneExitHoldValueCents = decision.holdValueCents;
  order.standaloneExitOptimisticHoldValueCents = decision.optimisticHoldValueCents;
  order.paperExitFillVersion = PAPER_EXIT_FILL_VERSION;

  const fill = immediateSellFill(book, order.side, decision.executableBid, order.quantity);
  order.paperExitDisplayedAtLimit = fill.displayedAtLimit;

  if (fill.filledCount <= 0) {
    // Live's own wording, because the state is the same one: the position rides to settlement.
    order.reason = `${decision.policy} reduce-only exit received no fill; position retained and no automatic exit retry will occur.`;
    return;
  }

  const originalQuantity = order.quantity;
  // Taker schedule: an IOC sell lifts a resting bid, so it is never the maker on its own fill.
  const exitFeeCents = venueFeeCents(order.venue, fill.averagePrice * 100, fill.filledCount, 'taker');
  const netProceedsCents = fill.cashCents - exitFeeCents;

  if (fill.filledCount + 1e-8 < originalQuantity) {
    const soldRatio = fill.filledCount / originalQuantity;
    const soldActualStake = (order.actualStakeCents ?? order.stakeCents) * soldRatio;
    const remainingActualStake = (order.actualStakeCents ?? order.stakeCents) - soldActualStake;
    const remainingReserved = Math.ceil(remainingActualStake - 1e-9);
    const releasedStake = Math.max(0, order.stakeCents - remainingReserved);
    const payoutCents = Math.max(0, Math.floor(netProceedsCents + 1e-9));
    const partial: PaperOrder = {
      ...order, id: `${order.id}:exit:${attemptedAt}`, status: 'sold',
      quantity: fill.filledCount, filledCount: fill.filledCount, stakeCents: releasedStake,
      actualStakeCents: soldActualStake,
      actualPurchaseCents: (order.actualPurchaseCents ?? entryFillPrice(order) * originalQuantity * 100) * soldRatio,
      actualFeeCents: (order.actualFeeCents ?? order.feeCents) * soldRatio,
      potentialPayoutCents: Math.round(fill.filledCount * 100), exitPending: false,
      exitPrice: fill.averagePrice, exitFeeCents,
      saleProceedsCents: netProceedsCents, payoutCents: netProceedsCents,
      pnlCents: payoutCents - releasedStake,
      actualPnlCents: netProceedsCents - soldActualStake, settledAt: attemptedAt,
      reason: `${decision.policy} reduce-only exit filled partially; remainder retained and automatic exit retry disabled.`,
    };
    order.quantity = Number((originalQuantity - fill.filledCount).toFixed(2));
    order.filledCount = order.quantity;
    order.actualPurchaseCents = (order.actualPurchaseCents ?? entryFillPrice(order) * originalQuantity * 100) * (1 - soldRatio);
    order.actualFeeCents = (order.actualFeeCents ?? order.feeCents) * (1 - soldRatio);
    order.actualStakeCents = remainingActualStake;
    order.stakeCents = remainingReserved;
    order.potentialPayoutCents = Math.round(order.quantity * 100);
    order.reason = partial.reason;
    ledger.orders.push(partial);
    ledger.paperBudget.availableCents += payoutCents;
    ledger.paperBudget.realizedPnlCents += payoutCents - releasedStake;
    return;
  }

  const payoutCents = Math.max(0, Math.floor(netProceedsCents + 1e-9));
  order.status = 'sold';
  order.exitPrice = fill.averagePrice;
  order.exitFeeCents = exitFeeCents;
  order.saleProceedsCents = netProceedsCents;
  order.payoutCents = netProceedsCents;
  order.pnlCents = payoutCents - order.stakeCents;
  order.actualPnlCents = netProceedsCents - (order.actualStakeCents ?? order.stakeCents);
  order.settledAt = attemptedAt;
  order.reason = `${decision.policy}: ${decision.reason}`;
  ledger.paperBudget.availableCents += payoutCents;
  ledger.paperBudget.realizedPnlCents += payoutCents - order.stakeCents;
  clearEntryPersistence(ledger, order);
}

async function executeLiveStandaloneExit(order: PaperOrder, decision: NonNullable<ReturnType<typeof evaluateExitPolicy>>, ledger: Ledger): Promise<void> {
  beginLiveTransaction(`Managing ${order.symbol} ${order.side} standalone reduce-only exit.`);
  try {
    order.exitClientOrderId = `money-noodle-exit:${crypto.randomUUID()}`;
    order.exitRequestedAt = new Date().toISOString();
    order.exitPending = true;
    order.standaloneExitPolicy = decision.policy;
    order.standaloneExitAttemptedAt = order.exitRequestedAt;
    order.standaloneExitHoldValueCents = decision.holdValueCents;
    order.standaloneExitOptimisticHoldValueCents = decision.optimisticHoldValueCents;
    await writeLedger(ledger);
    try {
      const exit = await placeKalshiSell({
        ticker: order.contractId, positionSide: order.side,
        minimumPriceCents: decision.executableBid * 100,
        count: order.quantity, clientOrderId: order.exitClientOrderId,
        onAccepted: async (venueOrderId, exchangeIndex) => {
          order.exitVenueOrderId = venueOrderId;
          order.exitVenueExchangeIndex = exchangeIndex;
          await writeLedger(ledger);
        },
      });
      order.exitVenueExchangeIndex = exit.exchangeIndex;
      order.exitPending = false;
      if (exit.filledCount <= 0) {
        order.reason = `${decision.policy} reduce-only exit received no fill; position retained and no automatic exit retry will occur.`;
        return;
      }
      const originalQuantity = order.quantity;
      const grossProceedsCents = exit.filledCount * exit.averagePriceCents;
      const netProceedsCents = grossProceedsCents - exit.feeCents;
      if (exit.filledCount + 1e-8 < originalQuantity) {
        const soldRatio = exit.filledCount / originalQuantity;
        const soldActualStake = (order.actualStakeCents ?? order.stakeCents) * soldRatio;
        const remainingActualStake = (order.actualStakeCents ?? order.stakeCents) - soldActualStake;
        const remainingReserved = Math.ceil(remainingActualStake - 1e-9);
        const releasedStake = Math.max(0, order.stakeCents - remainingReserved);
        const partial: PaperOrder = {
          ...order, id: `${order.id}:exit:${exit.venueOrderId}`, status: 'sold',
          quantity: exit.filledCount, filledCount: exit.filledCount, stakeCents: releasedStake,
          actualStakeCents: soldActualStake,
          actualPurchaseCents: (order.actualPurchaseCents ?? entryFillPrice(order) * originalQuantity * 100) * soldRatio,
          actualFeeCents: (order.actualFeeCents ?? order.feeCents) * soldRatio,
          potentialPayoutCents: Math.round(exit.filledCount * 100), exitPending: false,
          exitVenueOrderId: exit.venueOrderId, exitPrice: exit.averagePriceCents / 100, exitFeeCents: exit.feeCents,
          saleProceedsCents: netProceedsCents, payoutCents: netProceedsCents,
          pnlCents: Math.floor(netProceedsCents + 1e-9) - releasedStake,
          actualPnlCents: netProceedsCents - soldActualStake, settledAt: new Date().toISOString(),
          reason: `${decision.policy} reduce-only exit filled partially; remainder retained and automatic exit retry disabled.`,
        };
        order.quantity = Number((originalQuantity - exit.filledCount).toFixed(2));
        order.filledCount = order.quantity;
        order.actualPurchaseCents = (order.actualPurchaseCents ?? entryFillPrice(order) * originalQuantity * 100) * (1 - soldRatio);
        order.actualFeeCents = (order.actualFeeCents ?? order.feeCents) * (1 - soldRatio);
        order.actualStakeCents = remainingActualStake;
        order.stakeCents = remainingReserved;
        order.potentialPayoutCents = Math.round(order.quantity * 100);
        order.reason = partial.reason;
        ledger.orders.push(partial);
        await writeLedger(ledger);
        if (releasedStake > 0) await settleTradingBudget(releasedStake, Math.max(0, Math.floor(netProceedsCents + 1e-9)), order.venue, `${partial.id}:standalone-exit`);
        return;
      }
      order.status = 'sold';
      order.exitVenueOrderId = exit.venueOrderId;
      order.exitPrice = exit.averagePriceCents / 100;
      order.exitFeeCents = exit.feeCents;
      order.saleProceedsCents = netProceedsCents;
      order.payoutCents = netProceedsCents;
      order.pnlCents = Math.floor(netProceedsCents + 1e-9) - order.stakeCents;
      order.actualPnlCents = netProceedsCents - (order.actualStakeCents ?? order.stakeCents);
      order.settledAt = new Date().toISOString();
      order.reason = `${decision.policy}: ${decision.reason}`;
      clearEntryPersistence(ledger, order);
      await writeLedger(ledger);
      await settleTradingBudget(order.stakeCents, Math.max(0, Math.floor(netProceedsCents + 1e-9)), order.venue, `${order.id}:standalone-exit`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Standalone exit failed';
      order.reason = `Standalone exit uncertain; position retained pending reconciliation: ${reason}`;
      automaticReconciliationRequested = true;
      await suspendTrading(`Live standalone exit uncertain: ${reason}`);
    }
  } finally {
    endLiveTransaction();
  }
}

async function observeAndExecuteStandaloneExits(dashboard: DashboardData, status: TradingControlData, ledger: Ledger): Promise<boolean> {
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return false;
  let changed = false;
  // Scoped to the edge policy's own positions. Its exit rules read a model probability and an optimistic
  // hold value; the long-shot policy produces neither, so applying them to its positions grades a bet
  // against a forecast that was never made. On 2026-08-15 this closed three long-shot positions at 48-76c
  // that the strategy was holding for its 90c mark, corrupting the round trip it exists to measure.
  for (const order of ledger.orders.filter((item) => item.status === 'open' && orderStrategyId(item) === EDGE_BINARY_BUY)) {
    const prediction = dashboard.predictions.find((item) => item.symbol === order.symbol
      && (order.venue === 'kalshi' ? item.kalshi?.closesAt === order.closesAt : item.market.closesAt === order.closesAt));
    if (!prediction) continue;
    const decision = applyExitObservation(order, prediction, dashboard.generatedAt);
    if (!decision) continue;
    changed = true;
    if (order.standaloneExitAttemptedAt || decision.action !== 'SELL') continue;
    if (order.executionMode === 'paper') executePaperStandaloneExit(order, decision, ledger);
    else if (status.control.state === 'active' && status.control.mode === 'live' && status.liveRisk.allowed
      && getKalshiReconciliationStatus().phase === 'ready'
      && countFilledLiveVenueOrders(ledger.orders, Date.now() - 3_600_000) < maxLiveOrdersPerHour()) {
      await executeLiveStandaloneExit(order, decision, ledger);
      return true;
    }
  }
  return changed;
}

interface SwitchPlan { incumbent: PaperOrder; replacement: PaperOrder; exitLimitPriceCents: number; holdValueCents: number; estimatedLiquidationCents: number; deltaCents: number; probabilityAdvantage: number; requiredProbabilityAdvantage: number }

function bestSwitch(dashboard: DashboardData, status: TradingControlData, ledger: Ledger, open: PaperOrder[], options: { oppositeSameAssetOnly?: boolean } = {}): SwitchPlan | null {
  const now = Date.now();
  const settings = switchPolicySettings();
  const requiredGain = settings.minimumGainCents + settings.uncertaintyMarginCents;
  const recentCompletedSwitch = ledger.orders.find((order) => order.status === 'sold' && order.switchedToOrderId && switchCooldownRemainingMs(order.settledAt, now, settings.cooldownSeconds * 1000) > 0);
  if (recentCompletedSwitch) { ledger.switchPersistence = {}; return null; }
  const existing = new Set(ledger.orders.map((order) => order.id));
  const replacements = dashboard.predictions.flatMap((prediction) => {
    const side = selectedSide(prediction);
    if (!side || !prediction.market.live || existing.has(orderId(prediction, 'live', side, ledger)) || reentryCooldownRemainingMs(ledger, prediction, 'live', side, now) > 0) return [];
    if (!qualifiesVenueBuyEdge(prediction, 'kalshi', side) || !executionEligibility(prediction, side, ledger, now).eligible) return [];
    const built = buildOrder(prediction, side, status, ledger, dashboard.generatedAt, dashboard.modelVersion, 'live', Math.min(status.proposedStakeCents, maxLiveStakeCents()), 'kalshi');
    return 'order' in built ? [built.order] : [];
  });
  let best: SwitchPlan | null = null;
  for (const replacement of replacements) {
    if (Date.parse(replacement.closesAt) - now < MIN_SWITCH_SECONDS * 1000) continue;
    if (ledger.orders.some((order) => order.executionMode === 'live' && order.status === 'sold' && order.closesAt === replacement.closesAt)) continue;
    const newExpectedProfit = replacement.quantity * 100 * orderProbability(replacement) - replacement.stakeCents;
    if (newExpectedProfit <= 0) continue;
    for (const incumbent of open.filter((order) => order.venue === 'kalshi' && order.status === 'open'
      && orderStrategyId(order) === EDGE_BINARY_BUY)) {
      if (options.oppositeSameAssetOnly && !(replacement.symbol === incumbent.symbol && replacement.side !== incumbent.side)) continue;
      const current = dashboard.predictions.find((item) => item.symbol === incumbent.symbol && item.kalshi?.closesAt === incumbent.closesAt);
      const quote = current ? venueQuote(current, 'kalshi', incumbent.side) : null;
      if (!current || !quote || quote.bid <= 0 || quote.bid > quote.ask) continue;
      if (replacement.symbol === incumbent.symbol && replacement.side === incumbent.side) continue;
      const incumbentProbability = sideProbability(current, incumbent.side);
      const replacementProbability = orderProbability(replacement);
      const probabilityGate = evaluateSwitchProbabilityGate({
        incumbentSymbol: incumbent.symbol, incumbentSide: incumbent.side, incumbentProbability,
        replacementSymbol: replacement.symbol, replacementSide: replacement.side, replacementProbability,
        minimumAdvantage: settings.minimumProbabilityAdvantage,
        minimumOppositeSideAdvantage: settings.minimumOppositeSideAdvantage,
      });
      if (!probabilityGate?.allowed) continue;
      const exitFee = venueFeeCents('kalshi', quote.bid * 100, incumbent.quantity, 'taker');
      const value = valueSwitch({
        incumbentQuantity: incumbent.quantity, incumbentProbability,
        exitBid: quote.bid, exitFeeCents: exitFee,
        replacementQuantity: replacement.quantity, replacementProbability,
        replacementAllInCostCents: replacement.stakeCents,
      });
      if (!value || value.replacementExpectedProfitCents <= 0) continue;
      // Original entry cost is sunk. This compares future wealth from holding with net cash from
      // selling plus the replacement's expected profit, so spread, exit loss and both fees bind.
      if (value.deltaCents >= requiredGain && (!best || value.deltaCents > best.deltaCents)) best = {
        incumbent, replacement, exitLimitPriceCents: quote.bid * 100,
        holdValueCents: value.holdValueCents, estimatedLiquidationCents: value.liquidationValueCents, deltaCents: value.deltaCents,
        probabilityAdvantage: probabilityGate.advantage, requiredProbabilityAdvantage: probabilityGate.requiredAdvantage,
      };
    }
  }
  if (!best) { ledger.switchPersistence = {}; return null; }
  const persistenceId = `${best.incumbent.id}->${best.replacement.id}`;
  const observedAt = dashboard.generatedAt;
  const previous = ledger.switchPersistence[persistenceId];
  const state = advanceSwitchPersistence(previous, {
    incumbentId: best.incumbent.id, replacementId: best.replacement.id,
    observedAt, deltaCents: best.deltaCents,
  });
  ledger.switchPersistence = { [persistenceId]: state };
  const spanMs = switchEvidenceSpanMs(state);
  const replacementKey = `${best.replacement.symbol}:${best.replacement.side}:${best.replacement.closesAt}`;
  ledger.portfolioDecisions[replacementKey] = {
    state: 'switch-candidate',
    reason: `Would replace ${best.incumbent.symbol} ${best.incumbent.side} with ${best.replacement.symbol} ${best.replacement.side}: ${best.deltaCents.toFixed(2)}c estimated gain and ${(best.probabilityAdvantage * 100).toFixed(1)}pp probability advantage (required ${(best.requiredProbabilityAdvantage * 100).toFixed(0)}pp); persistence ${state.observations}/${REQUIRED_SWITCH_SNAPSHOTS} over ${Math.max(0, Math.floor(spanMs / 1000))}/${REQUIRED_SWITCH_SPAN_MS / 1000}s; required gain ${requiredGain.toFixed(2)}c including uncertainty margin.`,
    expectedProfitCents: expectedProfitCents(best.replacement), adjustedExpectedContributionCents: best.deltaCents,
    updatedAt: new Date().toISOString(),
  };
  return switchEvidenceReady(state, { requiredObservations: REQUIRED_SWITCH_SNAPSHOTS, requiredSpanMs: REQUIRED_SWITCH_SPAN_MS, requiredGainCents: requiredGain }) ? best : null;
}

async function executeSwitch(plan: SwitchPlan, status: TradingControlData, ledger: Ledger): Promise<boolean> {
  const { incumbent, replacement } = plan;
  beginLiveTransaction(`Managing live switch from ${incumbent.symbol} to ${replacement.symbol}.`);
  try {
  try {
    // Persist intent before the request so a lost response can be matched by deterministic client id.
    incumbent.exitClientOrderId = `money-noodle-exit:${crypto.randomUUID()}`;
    incumbent.exitRequestedAt = new Date().toISOString();
    incumbent.exitPending = true;
    await writeLedger(ledger);
    // The IOC minimum is the actionable bid used by the switch calculation. It fills at that price
    // or better and leaves no resting remainder; partial fills are reconciled below.
    const exit = await placeKalshiSell({
      ticker: incumbent.contractId, positionSide: incumbent.side, minimumPriceCents: plan.exitLimitPriceCents, count: incumbent.quantity,
      clientOrderId: incumbent.exitClientOrderId,
      onAccepted: async (venueOrderId, exchangeIndex) => {
        incumbent.exitVenueOrderId = venueOrderId;
        incumbent.exitVenueExchangeIndex = exchangeIndex;
        await writeLedger(ledger);
      },
    });
    incumbent.exitVenueExchangeIndex = exit.exchangeIndex;
    incumbent.exitPending = false;
    if (exit.filledCount <= 0) {
      recordSwitchSkip('fill', `${incumbent.symbol} reduce-only switch exit did not fill; incumbent retained.`, incumbent, ledger);
      return true;
    }
    const originalQuantity = incumbent.quantity;
    const grossProceedsCents = exit.filledCount * exit.averagePriceCents;
    const netProceedsCents = grossProceedsCents - exit.feeCents;
    if (exit.filledCount + 1e-8 < originalQuantity) {
      // IOC may partially fill. Allocate entry cost proportionally, preserve the remaining position,
      // release only whole cents no longer needed, and never buy the replacement after a partial exit.
      const soldRatio = exit.filledCount / originalQuantity;
      const soldActualPurchase = (incumbent.actualPurchaseCents ?? entryFillPrice(incumbent) * originalQuantity * 100) * soldRatio;
      const soldActualFee = (incumbent.actualFeeCents ?? incumbent.feeCents) * soldRatio;
      const soldActualStake = soldActualPurchase + soldActualFee;
      const remainingQuantity = Number((originalQuantity - exit.filledCount).toFixed(2));
      const remainingActualPurchase = (incumbent.actualPurchaseCents ?? entryFillPrice(incumbent) * originalQuantity * 100) - soldActualPurchase;
      const remainingActualFee = (incumbent.actualFeeCents ?? incumbent.feeCents) - soldActualFee;
      const remainingActualStake = remainingActualPurchase + remainingActualFee;
      const remainingReservedCents = Math.ceil(remainingActualStake - 1e-9);
      const releasedStakeCents = Math.max(0, incumbent.stakeCents - remainingReservedCents);
      const partial: PaperOrder = {
        ...incumbent,
        id: `${incumbent.id}:exit:${exit.venueOrderId}`,
        status: 'sold', quantity: exit.filledCount, filledCount: exit.filledCount,
        stakeCents: releasedStakeCents,
        actualPurchaseCents: soldActualPurchase, actualFeeCents: soldActualFee, actualStakeCents: soldActualStake,
        feeCents: soldActualFee, potentialPayoutCents: Math.round(exit.filledCount * 100),
        exitVenueOrderId: exit.venueOrderId, exitPrice: exit.averagePriceCents / 100, exitFeeCents: exit.feeCents,
        saleProceedsCents: netProceedsCents, payoutCents: netProceedsCents,
        pnlCents: Math.floor(netProceedsCents + 1e-9) - releasedStakeCents,
        actualPnlCents: netProceedsCents - soldActualStake,
        switchDeltaCents: plan.deltaCents, switchedToOrderId: undefined,
        settledAt: new Date().toISOString(),
        reason: 'Reduce-only switch exit filled partially; replacement was not purchased.',
      };
      incumbent.quantity = remainingQuantity;
      incumbent.filledCount = remainingQuantity;
      incumbent.actualPurchaseCents = remainingActualPurchase;
      incumbent.actualFeeCents = remainingActualFee;
      incumbent.actualStakeCents = remainingActualStake;
      incumbent.feeCents = remainingActualFee;
      incumbent.stakeCents = remainingReservedCents;
      incumbent.potentialPayoutCents = Math.round(remainingQuantity * 100);
      ledger.orders.push(partial);
      await writeLedger(ledger);
      if (releasedStakeCents > 0) await settleTradingBudget(releasedStakeCents, Math.max(0, Math.floor(netProceedsCents + 1e-9)), incumbent.venue, `${partial.id}:partial-switch-exit`);
      recordSwitchSkip('fill', `${incumbent.symbol} switch exit filled ${exit.filledCount.toFixed(2)} of ${originalQuantity.toFixed(2)}; replacement withheld.`, incumbent, ledger);
      return true;
    }
    incumbent.status = 'sold';
    incumbent.switchDecisionAt = new Date().toISOString();
    incumbent.exitVenueOrderId = exit.venueOrderId;
    incumbent.exitPrice = exit.averagePriceCents / 100;
    incumbent.exitFeeCents = exit.feeCents;
    incumbent.saleProceedsCents = netProceedsCents;
    incumbent.actualPnlCents = netProceedsCents - (incumbent.actualStakeCents ?? incumbent.stakeCents);
    incumbent.pnlCents = Math.floor(netProceedsCents + 1e-9) - incumbent.stakeCents;
    incumbent.payoutCents = netProceedsCents;
    incumbent.settledAt = new Date().toISOString();
    incumbent.switchDeltaCents = plan.deltaCents;
    incumbent.switchedToOrderId = replacement.id;
    incumbent.reason = `Closed ${incumbent.side} reduce-only to switch into ${replacement.symbol} ${replacement.side}; estimated incremental gain ${plan.deltaCents.toFixed(2)}c after liquidation loss and fees with ${(plan.probabilityAdvantage * 100).toFixed(1)}pp probability advantage.`;
    replacement.replacedOrderId = incumbent.id;
    await writeLedger(ledger);
    await settleTradingBudget(incumbent.stakeCents, Math.max(0, Math.floor(netProceedsCents + 1e-9)), incumbent.venue, `${incumbent.id}:switch-exit`);
    await executePreparedLiveBuy(replacement, status, ledger);
    ledger.lastLiveSkip = { reason: `Switched ${incumbent.symbol} ${incumbent.side} to ${replacement.symbol} ${replacement.side}; estimated gain ${plan.deltaCents.toFixed(2)}c and ${(plan.probabilityAdvantage * 100).toFixed(1)}pp probability advantage.`, at: new Date().toISOString() };
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Live switch failed';
    recordSwitchSkip('reconciliation', `Switch outcome uncertain; incumbent reservation retained pending reconciliation: ${reason}`, incumbent, ledger);
    automaticReconciliationRequested = true;
    await suspendTrading(`Live switch uncertain: ${reason}`);
    return true;
  }
  } finally {
    endLiveTransaction();
  }
}

/** Live trading is gated by automation state, live mode, the environment switch, and rate limits. */
/** Live entries holding a slot. Recomputed on demand: each placement in the drain loop adds one. */
function openLiveEntries(ledger: Pick<Ledger, 'orders'>): PaperOrder[] {
  return ledger.orders.filter((order) => order.executionMode === 'live'
    && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'));
}

/**
 * Whether one more live entry may join the exposure already committed.
 *
 * `portfolioDecisions` is computed before the cycle places anything, so when the drain loop considers its
 * second and third order it cannot see the first two. Correlation limits were never load-bearing on live
 * while it placed one order per cycle; the moment it places three they are the only thing preventing
 * three copies of the same bet in one settlement window. The long-shot policy demonstrated exactly that
 * failure on 2026-08-18 — three DOWN positions on three assets in one window, all lost together —
 * because it has no correlation limit at all.
 */
export function portfolioAdmitsAdditional(ledger: Pick<Ledger, 'orders'>, prediction: Pick<Prediction, 'symbol' | 'market'>): boolean {
  const constraints = portfolioConstraints();
  const sameWindow = openLiveEntries(ledger).filter((order) => order.closesAt === prediction.market.closesAt);
  // Opposite-side exposure on an asset already held is a reduce-only switch, never an additive hedge.
  if (sameWindow.some((order) => order.symbol === prediction.symbol)) return false;
  if (sameWindow.length >= constraints.maximumSameWindow) return false;
  const group = cryptoExposureGroup(prediction.symbol);
  const sameGroup = sameWindow.filter((order) => cryptoExposureGroup(order.symbol) === group).length;
  return sameGroup < constraints.maximumSameGroupPerWindow;
}

function buildPortfolioChoiceSetRecord(input: {
  order: PaperOrder; candidateId: string; audit: PortfolioSelectionAudit; dashboard: DashboardData;
  status: TradingControlData; regimeGate: RegimeGateStatus; regimeByCandidate: Map<string, string | undefined>;
  regimeAllowedIds: Set<string>; initiallySelectedIds: Set<string>; executionReadyIds: Set<string>;
  priorDrainActions: Array<{ candidateId: string; action: 'issued' | 'skipped'; reason: string }>;
  currentExposures: PaperOrder[];
  drainSequence: number; maximumLiveStake: number; providerSpendableCents: number; effectiveStakeCeilingCents: number;
}): PortfolioChoiceSetRecord {
  const prior = new Map(input.priorDrainActions.map((action) => [action.candidateId, action]));
  return {
    id: `${PORTFOLIO_CHOICE_SET_VERSION}:${input.order.id}`,
    version: PORTFOLIO_CHOICE_SET_VERSION,
    recordedAt: input.order.createdAt,
    calculationAt: input.dashboard.generatedAt,
    drainSequence: input.drainSequence,
    strategyId: EDGE_BINARY_BUY,
    executionMode: 'live',
    marketId: orderMarketId(input.order),
    providerId: orderProviderId(input.order),
    providerVariantId: input.order.providerVariantId,
    forecastModelVersion: input.dashboard.modelVersion,
    buyPolicyVersion: BUY_POLICY_VERSION,
    executionPolicyVersion: input.order.entryDecision?.executionPolicyVersion,
    sizingPolicyVersion: input.order.entrySizingDecision?.policyVersion,
    issuedOrderId: input.order.id,
    issuedLogicalOrderId: input.order.logicalOrderId ?? input.order.id,
    issuedCandidateId: input.candidateId,
    issuedEntryDecision: { ...input.order.entryDecision!, factors: input.order.entryDecision!.factors.map((factor) => ({ ...factor })) },
    issuedReservedStakeCents: input.order.reservedStakeCents ?? input.order.stakeCents,
    proposedStakeCents: input.status.proposedStakeCents,
    maximumLiveStakeCents: input.maximumLiveStake,
    providerSpendableCents: input.providerSpendableCents,
    effectiveStakeCeilingCents: input.effectiveStakeCeilingCents,
    adaptiveRegimeGate: {
      phase: input.regimeGate.phase, allowsEntries: input.regimeGate.allowsEntries,
      policyVersion: input.regimeGate.policyVersion, reason: input.regimeGate.reason,
    },
    classifiedRegimeRequired: classifiedRegimeRequired(),
    liveControl: { revision: input.status.control.revision, state: input.status.control.state, mode: input.status.control.mode },
    liveOperationalReady: true,
    constraints: { ...input.audit.constraints },
    exposures: input.currentExposures.map((exposure) => ({
      orderId: exposure.id, strategyId: orderStrategyId(exposure), symbol: exposure.symbol,
      side: exposure.side, closesAt: exposure.closesAt, status: exposure.status,
    })),
    priorDrainActions: input.priorDrainActions.map((action) => ({ ...action })),
    candidates: input.audit.candidates.map((candidate) => {
      const side = selectedSide(candidate.prediction)!;
      const built = candidate.id === input.candidateId ? input.order : candidate.builtOrder;
      const entry = bestVenueEntry(candidate.prediction, 'kalshi', side);
      const quote = venueQuote(candidate.prediction, 'kalshi', side);
      const priorAction = prior.get(candidate.id);
      const initiallySelected = input.initiallySelectedIds.has(candidate.id);
      const executionReady = input.executionReadyIds.has(candidate.id);
      const drainDisposition = candidate.id === input.candidateId ? 'issued'
        : priorAction?.action === 'issued' ? 'issued-earlier'
        : priorAction?.action === 'skipped' ? 'skipped-earlier'
        : executionReady ? 'pending'
        : initiallySelected ? 'not-ready'
        : 'not-selected';
      return {
        id: candidate.id, symbol: candidate.prediction.symbol,
        contractId: built?.contractId ?? candidate.prediction.kalshi?.ticker,
        side, closesAt: built?.closesAt ?? candidate.prediction.kalshi?.closesAt ?? candidate.prediction.market.closesAt,
        selectedSideProbability: sideProbability(candidate.prediction, side), confidence: candidate.prediction.confidence,
        actionableAsk: built?.entryDecision?.actionableAsk ?? quote?.ask,
        actionableBid: built?.entryDecision?.actionableBid ?? quote?.bid,
        feeRate: built?.entryDecision?.feeRate ?? entry?.feeRate,
        netEdge: built?.entryDecision?.netEdge ?? entry?.netEdge,
        spread: built?.entryDecision?.spread ?? (quote ? quote.ask - quote.bid : undefined),
        persistenceObservations: candidate.persistence?.observations.map((observation) => ({ ...observation })),
        eligibility: candidate.attempt ? {
          eligible: candidate.attempt.eligibility.eligible, reason: candidate.attempt.eligibility.reason,
          qualifyingSnapshots: candidate.attempt.eligibility.qualifyingSnapshots,
          medianNetEdge: candidate.attempt.eligibility.medianNetEdge, edgeSpike: candidate.attempt.eligibility.edgeSpike,
        } : undefined,
        retry: candidate.attempt ? {
          allowed: candidate.attempt.retry.allowed, attemptNumber: candidate.attempt.retry.attemptNumber,
          reason: candidate.attempt.retry.reason, retryOfOrderId: candidate.attempt.retry.retryOfOrderId,
        } : undefined,
        cooldownRemainingMs: candidate.cooldownRemainingMs,
        assetAdmitted: assetAdmitted(candidate.prediction.symbol),
        cycleRegime: input.regimeByCandidate.get(candidate.id),
        regimeAdmitted: regimeAdmits(input.regimeByCandidate.get(candidate.id)),
        liveFiltersAdmitted: input.regimeAllowedIds.has(candidate.id),
        portfolioState: candidate.decision.state, portfolioReason: candidate.decision.reason,
        sizingPolicyVersion: built?.entrySizingDecision?.policyVersion,
        sizingMultiplier: built?.entrySizingDecision?.multiplier,
        quantity: built?.quantity, stakeCents: built?.stakeCents, feeCents: built?.feeCents,
        potentialPayoutCents: built?.potentialPayoutCents,
        expectedProfitCents: candidate.decision.expectedProfitCents,
        adjustedExpectedContributionCents: candidate.decision.adjustedExpectedContributionCents,
        rank: candidate.decision.rank,
        initiallySelected, executionReady, drainDisposition,
        drainReason: priorAction?.reason,
      };
    }),
  };
}

async function runLive(
  dashboard: DashboardData, status: TradingControlData, ledger: Ledger, regimeGate: RegimeGateStatus,
  budgets: ProviderBudgetConfiguration, portfolioAudit: PortfolioSelectionAudit,
  targetLogicalOrderId?: string, refreshDashboard?: () => Promise<DashboardData>,
): Promise<boolean> {
  // SPEC 12.8 step 2. `lastLiveSkip` remains the single-slot status the dashboard renders; the journal
  // beside it is the durable per-window record that makes `paper - live` decomposable instead of
  // reconstructable. Every gate names its own class: a classifier pattern-matching on these prose
  // reasons would mislabel the next gate someone adds, and AGENTS.md 5.7 asks that a gate be described
  // by what it actually does. Journal writes are fire-and-forget — a trading cycle must never fail or
  // stall because an observation could not be persisted.
  const openWindows = [...new Set(dashboard.predictions.map((item) => item.market.closesAt).filter(Boolean))];
  const targetedAttempts = targetLogicalOrderId
    ? entryAttemptsForLogicalOrder(ledger.orders, targetLogicalOrderId)
    : [];
  const targetedContinuation = targetLogicalOrderId
    ? adaptiveEntryEpisodeDecision(targetedAttempts, ENTRY_EXECUTION_POLICY_VERSION)
    : undefined;
  const skip = async (classification: LiveSkipClass, reason: string, scope?: { symbol?: string; side?: PositionSide }) => {
    ledger.lastLiveSkip = { reason, at: new Date().toISOString() };
    void recordLiveSkip({ classification, reason, windows: openWindows, ...scope })
      .catch((error) => console.error('Live skip journal write failed:', error));
    if (targetedContinuation?.allowed && targetedContinuation.takerFallback) {
      terminalizeAdaptiveContinuation(targetedAttempts, reason);
      // A fallback refusal must be durable before control returns to the outer managed-order lifecycle.
      await writeLedger(ledger);
    }
    return false;
  };
  if (!liveTradingEnabled()) return skip('environment', 'Live trading is off in the environment.');
  if (!status.tradingProviders?.find((provider) => provider.id === 'kalshi')?.liveEnabled) return skip('environment', 'Kalshi is disabled for live automated trading in the provider registry.');
  const reconciliation = getKalshiReconciliationStatus();
  if (reconciliation.phase !== 'ready') return skip('reconciliation', `Kalshi reconciliation ${reconciliation.phase}: ${reconciliation.reason}`);
  if (status.control.state !== 'active') {
    // A risk stop leaves operator intent active while the state is paused. That distinction is the one
    // SPEC 12.3 most needs recorded: it is the difference between "the desk chose not to trade" and
    // "the desk was stopped out", and reconstructing it from the control audit is what made the
    // 2026-08-20 divergence review expensive.
    const systemSuspension = status.control.operatorIntent === 'active';
    return skip(systemSuspension ? 'stop' : 'operator', `Automation is ${status.control.state}.`);
  }
  if (status.control.mode !== 'live') return skip('operator', 'Execution mode is paper.');
  if (!status.liveRisk.allowed) {
    const reason = `Live risk stop: ${status.liveRisk.reasons.join(' ')}`;
    await stopTradingForLiveRisk(reason);
    return skip('stop', reason);
  }
  if (!regimeGate.allowsEntries) return skip('regime', `Adaptive regime gate: ${regimeGate.reason}`);
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return skip('staleness', 'Calculation snapshot is older than 15 seconds.');
  const filledOrdersLastHour = countFilledLiveVenueOrders(ledger.orders, Date.now() - 3_600_000);
  if (filledOrdersLastHour >= maxLiveOrdersPerHour()) return skip('rate_limit', `Hourly live filled-order limit of ${maxLiveOrdersPerHour()} reached (${filledOrdersLastHour} orders with fills; unfilled/rejected excluded).`);
  const open = ledger.orders.filter((order) => order.executionMode === 'live' && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'));
  const maximumPositions = maximumOpenPositions();
  // A strongly superior opposite side of the same asset is a replacement, never an additive hedge.
  // Evaluate that protected reduce-only reversal even when portfolio capacity remains; both the
  // probability-advantage and net-future-wealth gates must persist before any incumbent is sold.
  if (!targetLogicalOrderId && open.length > 0 && open.length < maximumPositions && filledOrdersLastHour <= maxLiveOrdersPerHour() - 2) {
    const reversal = bestSwitch(dashboard, status, ledger, open, { oppositeSameAssetOnly: true });
    if (reversal) return executeSwitch(reversal, status, ledger);
  }
  if (open.length >= maximumPositions) {
    if (targetLogicalOrderId) return skip('portfolio', 'Fresh fallback checks found the maximum live-position ceiling occupied.');
    // A complete switch consumes two accepted venue orders: reduce-only exit, then replacement entry.
    // Never close a position if the hourly ceiling would then prevent its replacement.
    if (filledOrdersLastHour > maxLiveOrdersPerHour() - 2) return skip('rate_limit', `Switch needs two potential fill slots; ${filledOrdersLastHour}/${maxLiveOrdersPerHour()} filled orders in the last hour.`);
    const plan = bestSwitch(dashboard, status, ledger, open);
    if (plan) return executeSwitch(plan, status, ledger);
    const pending = Object.values(ledger.switchPersistence)[0];
    const settings = switchPolicySettings();
    return pending
      ? skip('persistence', `Switch candidate is collecting persistence ${pending.observations}/${REQUIRED_SWITCH_SNAPSHOTS}; minimum observed gain ${pending.minimumDeltaCents.toFixed(2)}c.`)
      : skip('portfolio', `Holding the constrained portfolio; no replacement clears liquidation costs plus ${(settings.minimumGainCents + settings.uncertaintyMarginCents).toFixed(2)}c required gain.`);
  }
  const allQualified = [...dashboard.predictions]
    .filter((item) => {
      const side = selectedSide(item);
      if (!side || !item.market.live) return false;
      const fallback = liveAttemptState(item, side, ledger).takerFallback;
      return qualifiesAsBuyEdge(item) || fallback;
    })
    .filter((item) => !targetLogicalOrderId || orderId(item, 'live', selectedSide(item)!, ledger) === targetLogicalOrderId)
    .sort((a, b) => edgeStrength(b) - edgeStrength(a));
  // Applied to the candidate list rather than the chosen order, so an unclassified top candidate steps
  // aside for the next one instead of skipping the cycle entirely.
  const regimeByCandidate = new Map(await Promise.all(allQualified.map(async (item) =>
    [item.symbol, (await cycleRegimeFor(item.symbol, item.market.closesAt))?.regime] as const)));
  const regimeAllowed = allQualified
    .filter((item) => assetAdmitted(item.symbol))
    .filter((item) => regimeAdmits(regimeByCandidate.get(item.symbol)));
  if (allQualified.length && !regimeAllowed.length) {
    return skip('regime', `No qualifying window has a characterised 15-second path yet (${allQualified.map((i) => `${i.symbol}:${regimeByCandidate.get(i.symbol) ?? 'unobserved'}`).join(', ')}).`);
  }
  const qualified = regimeAllowed.filter((item) => {
    const side = selectedSide(item)!;
    if (reentryCooldownRemainingMs(ledger, item, 'live', side) > 0) return false;
    return liveAttemptState(item, side, ledger).retry.allowed;
  });
  const selected = qualified.filter((item) => {
    if (targetLogicalOrderId) return true;
    const side = selectedSide(item)!;
    return ledger.portfolioDecisions[persistenceKey(item, side)]?.state === 'portfolio-selected';
  }).sort((a, b) => {
    const aSide = selectedSide(a)!, bSide = selectedSide(b)!;
    return (ledger.portfolioDecisions[persistenceKey(a, aSide)]?.rank ?? 99) - (ledger.portfolioDecisions[persistenceKey(b, bSide)]?.rank ?? 99);
  });
  const eligibleSelected = selected.filter((item) => liveAttemptState(item, selectedSide(item)!, ledger).eligibility.eligible);
  const regimeByChoiceId = new Map(allQualified.map((item) => {
    const side = selectedSide(item)!;
    return [persistenceKey(item, side), regimeByCandidate.get(item.symbol)] as const;
  }));
  const regimeAllowedIds = new Set(regimeAllowed.map((item) => persistenceKey(item, selectedSide(item)!)));
  const initiallySelectedIds = new Set(selected.map((item) => persistenceKey(item, selectedSide(item)!)));
  const executionReadyIds = new Set(eligibleSelected.map((item) => persistenceKey(item, selectedSide(item)!)));
  const prediction = eligibleSelected[0];
  if (!prediction) {
    const warming = qualified[0];
    if (warming) {
      const side = selectedSide(warming)!;
      const decision = ledger.portfolioDecisions[persistenceKey(warming, side)];
      return skip('persistence', `${warming.symbol} ${side}: ${decision?.reason ?? `qualified but not execution-ready — ${executionEligibility(warming, side, ledger).reason}`}`, { symbol: warming.symbol, side });
    }
    const blocked = allQualified.map((item) => ({ item, side: selectedSide(item)!, retry: liveAttemptState(item, selectedSide(item)!, ledger).retry })).filter(({ retry }) => !retry.allowed);
    if (blocked.length) return skip('persistence', blocked.map(({ item, retry }) => `${item.symbol}: ${retry.reason}`).join(' '));
    return skip('none', 'No new positive-edge binary buy qualifies right now.');
  }
  /**
   * Drain the ranked selection rather than taking only its head.
   *
   * Live placed exactly one order per cycle until 2026-08-18, which made the execution loop — not the
   * position cap and not the entry gate — the binding constraint on concurrency. Measured over the whole
   * ledger the desk held **no** live position 75% of the time and reached its three-position cap on 3 of
   * 348 orders, while the gate admitted a median of three simultaneous decisions. Candidates queued
   * behind a one-per-cycle door and their windows closed underneath them.
   *
   * Every ceiling is re-read **per placement** rather than once per cycle. That is the whole safety
   * argument for this loop: a cycle can now commit real money three times in the space one order used to
   * occupy, so the hourly rate limit, the funding headroom, the retry decision and the exposure the
   * earlier placements just created must each be recomputed before the next order is built.
   */
  let placed = 0;
  const priorDrainActions: Array<{ candidateId: string; action: 'issued' | 'skipped'; reason: string }> = [];
  for (const candidate of eligibleSelected) {
    const choiceId = persistenceKey(candidate, selectedSide(candidate)!);
    const openNow = openLiveEntries(ledger).length;
    if (openNow >= portfolioConstraints().maximumPositions) break;
    // Re-read per placement: the earlier orders in this same loop consumed slots and hourly budget.
    if (countFilledLiveVenueOrders(ledger.orders, Date.now() - 3_600_000) >= maxLiveOrdersPerHour()) break;
    const side = selectedSide(candidate)!;
    // Exposure created earlier in this cycle is invisible to `portfolioDecisions`, which was computed
    // before any of it existed. Without this the loop could place three correlated bets in one window.
    if (!portfolioAdmitsAdditional(ledger, candidate)) {
      priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason: 'Per-placement account exposure guard refused this initially selected candidate after earlier drain activity.' });
      continue;
    }
    // Allocation bounds the stake before the order is built, so a pair with partial headroom sizes down
    // rather than being rejected after the fact.
    const liveFunding = marketFundingFor(budgets, 'live', 'kalshi', DEFAULT_MARKET_ID, ledger,
      status.workingEquityCents, status.control.availableBudgetCents);
    const maximumLiveStake = maxLiveStakeCents();
    const liveStakeCeiling = Math.min(status.proposedStakeCents, maximumLiveStake, liveFunding.spendableCents);
    if (liveStakeCeiling <= 0) { if (!placed) return skip('funding', liveFunding.reason); break; }
    const logicalId = orderId(candidate, 'live', side, ledger);
    const attempt = liveAttemptState(candidate, side, ledger);
    const { retry } = attempt;
    if (!retry.allowed || !attempt.eligibility.eligible) {
      const reason = !retry.allowed ? retry.reason : attempt.eligibility.reason;
      priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason });
      if (!placed) return skip('persistence', `${candidate.symbol}: ${reason}`, { symbol: candidate.symbol, side });
      continue;
    }
    const built = buildOrder(candidate, side, status, ledger, dashboard.generatedAt, dashboard.modelVersion, 'live', liveStakeCeiling, 'kalshi', attempt.eligibility,
      PAPER_MANAGED_MAKER_EXECUTION_VERSION, attempt.takerFallback ? 0 : MIN_NET_EDGE);
    if ('reason' in built) {
      if (attempt.takerFallback) {
        terminalizeAdaptiveContinuation(attempt.attempts, built.reason);
        await writeLedger(ledger);
      }
      priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason: built.reason });
      if (!placed) return skip('budget', `${candidate.symbol} ${side}: ${built.reason}`, { symbol: candidate.symbol, side });
      continue;
    }
    // Defence in depth: sizing already respected the ceiling, so a stake above it means a rounding or
    // fee-reserve path put real money outside the operator's allocation.
    if (built.order.stakeCents > liveFunding.spendableCents) {
      if (attempt.takerFallback) {
        terminalizeAdaptiveContinuation(attempt.attempts, liveFunding.reason);
        await writeLedger(ledger);
      }
      priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason: liveFunding.reason });
      if (!placed) return skip('funding', liveFunding.reason, { symbol: candidate.symbol, side });
      continue;
    }
    built.order.logicalOrderId = logicalId;
    built.order.attemptNumber = retry.attemptNumber;
    built.order.entryEpisode = retry.attemptNumber;
    built.order.retryOfOrderId = retry.retryOfOrderId;
    built.order.requalifiedAfterOrderId = retry.retryOfOrderId;
    built.order.id = entryExecutionSettings().mode === 'adaptive'
      ? entryEpisodeId(logicalId, retry.attemptNumber)
      : makerAttemptId(logicalId, retry.attemptNumber);
    built.order.clientOrderId = liveEntryClientOrderId(built.order.id);
    built.order.executionMirrorPair = executionMirrorPairStamp(built.order);
    // A deterministic hash collision or accidental reuse is impossible to repair after submission. Stop
    // before reservation or any signed venue request rather than allowing two local intents to share it.
    try {
      assertUniqueLiveEntryClientOrderId(ledger.orders, built.order);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Live client order identity is ambiguous.';
      if (attempt.takerFallback) {
        terminalizeAdaptiveContinuation(attempt.attempts, reason);
        await writeLedger(ledger);
      }
      await suspendTrading(`Live client order identity blocked: ${reason}`);
      return skip('reconciliation', reason, { symbol: candidate.symbol, side });
    }
    const baselineRoute = entryExecutionDecision(candidate, side, built.order, ledger, attempt);
    const routeDecision = baselineRoute;
    built.order.entryExecutionDecision = routeDecision;
    const continuationRefusal = terminalizeRefusedAdaptiveContinuation(
      attempt.attempts,
      attempt.takerFallback || (routeDecision.configuredMode === 'adaptive' && retry.attemptNumber > 1),
      routeDecision,
    );
    if (continuationRefusal) {
      // No child intent, reservation, or venue call exists. Persist the exact refusal on its predecessor.
      await writeLedger(ledger);
      priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason: continuationRefusal });
      if (!placed) return skip('persistence', `${candidate.symbol}: ${continuationRefusal}`, { symbol: candidate.symbol, side });
      continue;
    }
    if (routeDecision.executedStyle === 'taker') {
      const stakeLimit = built.order.entrySizingDecision?.stakeLimitCents ?? liveStakeCeiling;
      const reserveFailure = routeDecision.route === 'maker-miss-taker-fallback'
        ? applyMakerMissTakerReserve(built.order, stakeLimit, attempt.attempts[0]!)
        : applyTakerQuoteMovementReserve(built.order, stakeLimit);
      if (reserveFailure) {
        if (attempt.takerFallback) {
          terminalizeAdaptiveContinuation(attempt.attempts, reserveFailure);
          await writeLedger(ledger);
        }
        priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason: reserveFailure });
        if (!placed) return skip('budget', `${candidate.symbol}: ${reserveFailure}`, { symbol: candidate.symbol, side });
        continue;
      }
      if (built.order.stakeCents > liveFunding.spendableCents) {
        if (attempt.takerFallback) {
          terminalizeAdaptiveContinuation(attempt.attempts, liveFunding.reason);
          await writeLedger(ledger);
        }
        priorDrainActions.push({ candidateId: choiceId, action: 'skipped', reason: liveFunding.reason });
        if (!placed) return skip('funding', liveFunding.reason, { symbol: candidate.symbol, side });
        continue;
      }
    }
    // Record the path label that admitted this live candidate so later cohorts can be audited.
    built.order.entryCycleRegime = (await cycleRegimeFor(candidate.symbol, candidate.market.closesAt))?.regime;
    // The authorization ceiling, captured before a fill can revise `stakeCents` down. Reconciliation
    // compares recovered venue cost against this; the shadow fields below are reporting only.
    built.order.reservedStakeCents = built.order.stakeCents;
    built.order.shadowTakerAllInCents = built.order.stakeCents;
    built.order.shadowTakerQuantity = built.order.quantity;
    const authorizeTakerQuote = routeDecision.executedStyle === 'taker'
      ? (quote: TakerAuthorizationQuote): string | undefined => {
        if (MAX_ENTRY_PRICE + 1e-9 < quote.ask) return `Refreshed ask ${(quote.ask * 100).toFixed(1)}c exceeds the ${MAX_ENTRY_PRICE * 100}c entry ceiling.`;
        if (routeDecision.route === 'maker-miss-taker-fallback') {
          const probability = entrySideProbability(candidate.modelProbabilityUp, side);
          const refusal = makerMissTakerQuoteRefusal({
            probability, quantity: built.order.quantity,
            referenceMidpoint: terminalEntryMidpoint(attempt.attempts.at(-1)!), quote,
          });
          if (!refusal) {
            built.order.signedTakerLimit = quote.limit;
            built.order.signedTakerNetEdge = makerMissTakerNetEdge({ probability, quantity: built.order.quantity, limit: quote.limit });
            built.order.signedTakerQuoteAt = new Date().toISOString();
          }
          return refusal;
        }
        const refreshed = entryExecutionDecision(candidate, side, built.order, ledger, attempt, quote);
        return refreshed.executedStyle === 'taker' ? undefined : refreshed.reason;
      }
      : undefined;
    let choiceSet: PortfolioChoiceSetRecord | undefined;
    try {
      choiceSet = buildPortfolioChoiceSetRecord({
        order: built.order, candidateId: choiceId, audit: portfolioAudit, dashboard, status, regimeGate,
        regimeByCandidate: regimeByChoiceId, regimeAllowedIds, initiallySelectedIds, executionReadyIds,
        priorDrainActions, currentExposures: openLiveEntries(ledger).map((exposure) => ({ ...exposure })),
        drainSequence: placed + 1, maximumLiveStake,
        providerSpendableCents: liveFunding.spendableCents, effectiveStakeCeilingCents: liveStakeCeiling,
      });
    } catch (error) {
      // Evaluation instrumentation may fail absent and log; it may never refuse or delay a funded order.
      console.error('Portfolio choice-set snapshot construction failed:', error);
    }
    ledger.lastLiveSkip = undefined;
    await executePreparedLiveBuy(built.order, status, ledger, authorizeTakerQuote, choiceSet);
    // Persist the terminal fill/no-fill result before optional fallback refresh work. A failed forecast
    // rebuild must never leave the durable row looking pending after the venue order is terminal.
    await writeLedger(ledger);
    priorDrainActions.push({ candidateId: choiceId, action: 'issued', reason: `Issued as drain sequence ${placed + 1}.` });
    placed += 1;
    // Do not wait for the collector cadence after an authoritative zero-spend result. A forced live-only
    // dashboard rebuild supplies a fresh model/venue snapshot; runLive then re-reads every account and
    // operational gate before creating the next distinct durable intent.
    const next = adaptiveEntryEpisodeDecision(liveAttempts(ledger, candidate, side), ENTRY_EXECUTION_POLICY_VERSION);
    if (entryExecutionSettings().mode === 'adaptive' && next.allowed && next.takerFallback && refreshDashboard) {
      try {
        const freshDashboard = await refreshDashboard();
        const freshStatus = await getTradingControl();
        const freshBudgets = await getProviderBudgets({ revision: freshStatus.control.revision });
        const freshPortfolio = updatePortfolioDecisions(freshDashboard, freshStatus, ledger);
        const freshRegimeGate = await getRegimeGateStatus();
        const continued = await runLive(freshDashboard, freshStatus, ledger, freshRegimeGate, freshBudgets, freshPortfolio.audit, logicalId, refreshDashboard);
        if (!continued && !built.order.fallbackSequenceEndedAt) {
          built.order.fallbackSequenceEndedAt = new Date().toISOString();
          built.order.fallbackSequenceEndReason = 'Fresh fallback checks produced no authorized intent; the detailed blocker is retained in the live-skip journal.';
          await writeLedger(ledger);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Fresh fallback snapshot failed.';
        ledger.lastLiveSkip = { at: new Date().toISOString(), reason: `Taker fallback withheld because its fresh snapshot failed: ${reason}` };
        built.order.fallbackSequenceEndedAt = new Date().toISOString();
        built.order.fallbackSequenceEndReason = ledger.lastLiveSkip.reason;
        await writeLedger(ledger);
      }
    }
  }
  return placed > 0;
}

async function processCycle(dashboard: DashboardData, refreshDashboard?: () => Promise<DashboardData>): Promise<void> {
  const ledger = await mutableLedger();
  let changed = updateSignalPersistence(dashboard, ledger);
  changed = await settleDueOrders(ledger) || changed;
  changed = await updateSoldCounterfactuals(ledger) || changed;
  if (changed) await writeLedger(ledger);
  recordTaskCadenceSuccess('edge-observation', dashboard.generatedAt);
  const regimeSentinel = regimeSentinelCandidate(dashboard, ledger);
  const regimeGate = await updateRegimeGate(regimeSentinel);
  // Evaluation collection is deliberately detached: storage or settlement failure cannot delay or
  // block paper/live execution, and neither evaluation module can place an order.
  void Promise.resolve()
    .then(() => updateCalendarEvaluationStore(calendarEvaluationCycle(dashboard, ledger)))
    .catch((error) => console.error('Calendar evaluation collection failed:', error));
  void updateEdgeSpikeSentinels(edgeSpikeSentinelCycle(dashboard, ledger))
    .catch((error) => console.error('Edge spike sentinel collection failed:', error));
  void maintainMakerLifecycleSentinels(dashboard.generatedAt)
    .catch((error) => console.error('Maker lifecycle sentinel maintenance failed:', error));
  void maintainMakerRestrictionSentinels(dashboard.generatedAt)
    .catch((error) => console.error('Maker restriction sentinel maintenance failed:', error));
  void maintainPortfolioChoiceSets(dashboard.generatedAt)
    .catch((error) => console.error('Portfolio choice-set maintenance failed:', error));
  const status = await getTradingControl();
  changed = await observeAndExecuteStandaloneExits(dashboard, status, ledger) || changed;
  // Record current open-position observations first. The store queue then appends continuation evidence,
  // classifies this evaluator cycle, and only afterward resolves due positions. This remains detached
  // from execution and uses no signed endpoint.
  void getExitPolicyContinuationOrderIds(dashboard.generatedAt)
    .then((orderIds) => {
      const continuationObservations = isFreshCalculationTimestamp(dashboard.generatedAt)
        ? orderIds.flatMap((orderId) => {
          const order = ledger.orders.find((item) => item.id === orderId);
          if (!order) return [];
          const prediction = dashboard.predictions.find((item) => item.symbol === order.symbol
            && (order.venue === 'kalshi' ? item.kalshi?.closesAt === order.closesAt : item.market.closesAt === order.closesAt));
          if (!prediction) return [];
          const observation = continuationExitObservation(order, prediction, dashboard.generatedAt);
          return observation ? [{ orderId, observation }] : [];
        }) : [];
      return maintainExitPolicySentinels({
        observedAt: dashboard.generatedAt, orders: ledger.orders, continuationObservations,
      });
    })
    .catch((error) => console.error('Exit policy sentinel maintenance failed:', error));
  const portfolioUpdate = updatePortfolioDecisions(dashboard, status, ledger);
  changed = portfolioUpdate.changed || changed;
  const previousSkip = ledger.lastLiveSkip?.reason;
  // Read once per cycle: a ceiling that changed mid-cycle would size one order against the old value.
  const budgets = await getProviderBudgets({ revision: status.control.revision });
  changed = resolveRestingPaperOrders(dashboard, ledger) || changed;
  const startedPaperOrders: PaperOrder[] = [];
  const paperTakerAuthorizers = new Map<string, PaperTakerAuthorizer>();
  changed = await runPaper(dashboard, status, ledger, regimeGate, budgets, startedPaperOrders, paperTakerAuthorizers) || changed;
  // Persist paper intent and its reservation before either manager starts. Paper then polls exact public
  // evidence concurrently with live's signed order lifecycle, so a twelve-second live order can no
  // longer starve a twelve-second paper order of every intermediate observation.
  if (startedPaperOrders.length) {
    await writeLedger(ledger);
    // Exact prospective intent is durable before optional public timing reads begin. The observer owns
    // a separate capped journal and cannot alter this order or its reservation.
    startPaperExecutionTimingObservers(startedPaperOrders);
    for (const order of startedPaperOrders) void recordMakerRestrictionOrder(order)
      .catch((error) => console.error('Paper maker restriction sentinel decision write failed:', error));
  }
  const paperManagement = managePaperEntryOrders(startedPaperOrders, ledger, paperTakerAuthorizers);
  const liveManagement = runLive(dashboard, status, ledger, regimeGate, budgets, portfolioUpdate.audit, undefined, refreshDashboard);
  const [paperChanged, liveChanged] = await Promise.all([paperManagement, liveManagement]);
  changed = paperChanged || liveChanged || changed;
  if (changed || ledger.lastLiveSkip?.reason !== previousSkip) await writeLedger(ledger);
}

export function processPaperTradingCycle(dashboard: DashboardData, refreshDashboard?: () => Promise<DashboardData>): Promise<void> {
  const operation = serializeLedgerMutation(() => processCycle(dashboard, refreshDashboard));
  return operation.then(() => {
    if (!automaticReconciliationRequested) return;
    automaticReconciliationRequested = false;
    // Recovery owns its own serialized background lane. The uncertain transaction already blocks new
    // live exposure; collection and paper settlement must not wait for venue account reads.
    void reconcileLiveExecution({ trigger: 'automatic' })
      .catch((error) => console.error('Automatic reconciliation failed:', error));
  });
}

/**
 * Withdraws operator intent first, then waits behind every already-queued execution operation. Only
 * authoritative reconciliation can mark the process restart-safe; filled positions may remain open,
 * but no request, amendment, cancellation, resting remainder, or uncertain transaction may remain.
 */
export async function pauseAndDrainLiveExecution(reason = 'Paused by user · paper shadow continues'): Promise<void> {
  await pauseTrading(reason);
  startExecutionDrain('Pause accepted; draining the serialized execution queue.');
  try {
    await waitForExecutionLedger();
    const beforeReconciliation = getExecutionDrainStatus();
    if (beforeReconciliation.workingTransactions > 0) throw new Error(`${beforeReconciliation.workingTransactions} live transaction(s) remained after the execution queue drained.`);
    const reconciliation = await reconcileLiveExecution({ trigger: 'manual' });
    if (reconciliation.phase !== 'ready') throw new Error(`Authoritative drain reconciliation blocked: ${reconciliation.reason}`);
    const unresolved = await readLedgerView((ledger) => ledger.orders.filter((order) => order.executionMode === 'live'
      && (order.status === 'pending_reservation' || order.status === 'uncertain' || order.exitPending)));
    const afterReconciliation = getExecutionDrainStatus();
    if (unresolved.length || afterReconciliation.workingTransactions > 0) {
      throw new Error(`Drain left ${unresolved.length} unresolved ledger intent(s) and ${afterReconciliation.workingTransactions} working transaction(s).`);
    }
    completeExecutionDrain('Execution queue drained and authoritative Kalshi reconciliation passed; process is restart-safe while automation remains paused.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution drain failed.';
    blockExecutionDrain(message);
    throw error;
  }
}

const RECONCILIATION_RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000, 15_000] as const;

/**
 * Authoritative account barrier. Venue reads run outside the shared ledger serializer, but reconciliation
 * `running` is itself a live-admission fence. A changed local live fingerprint discards the stale snapshot.
 */
export function reconcileLiveExecution(options: {
  trigger?: ReconciliationCheckpointTrigger;
  pauseOnFailure?: boolean;
} = {}): Promise<KalshiReconciliationStatus> {
  return serializedReconciliation(async () => {
    const taskRun = beginTaskCadenceRun('reconciliation');
    const trigger = options.trigger ?? 'manual';
    const startedAt = new Date().toISOString();
    const previousStatus = getKalshiReconciliationStatus();
    setKalshiReconciliationStatus({
      ...previousStatus, phase: 'running', trigger, startedAt, completedAt: undefined,
      reason: `Running ${trigger} Kalshi reconciliation.`,
    });
    try {
      let checkpoint: Awaited<ReturnType<typeof readKalshiReconciliationCheckpoint>>;
      try {
        checkpoint = await readKalshiReconciliationCheckpoint(DATA_DIR);
      } catch {
        // The owning full audit may replace a malformed discovery watermark only after current account
        // authority passes. Until then reconciliation remains running/blocked and no new live exposure enters.
        checkpoint = undefined;
      }
      let incremental = (trigger === 'periodic' || trigger === 'automatic') && Boolean(checkpoint);
      let successful: {
        snapshot: KalshiReconciliationSnapshot;
        result: ReturnType<typeof reconcileExecutionLedger>;
        completedThroughTs: number;
      } | undefined;

      for (const delayMs of RECONCILIATION_RETRY_DELAYS_MS) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const plan = await readLedgerView((ledger) => localReconciliationPlan(ledger.orders));
        const completedThroughTs = Math.floor(Date.now() / 1_000);
        let snapshot: KalshiReconciliationSnapshot;
        if (incremental && checkpoint) {
          const interval = incrementalReconciliationInterval(checkpoint, plan, completedThroughTs);
          try {
            snapshot = await fetchKalshiIncrementalReconciliationSnapshot({
              ...interval,
              trackedVenueOrderIds: plan.trackedVenueOrderIds,
            });
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('predates the live order/fill tier')) throw error;
            incremental = false;
            snapshot = await fetchKalshiReconciliationSnapshot(plan.trackedVenueOrderIds);
          }
        } else {
          snapshot = await fetchKalshiReconciliationSnapshot(plan.trackedVenueOrderIds);
        }

        const attempt = await serializeLedgerMutation(async () => {
          const ledger = await mutableLedger();
          if (liveReconciliationAuthorityFingerprint(ledger.orders) !== plan.authorityFingerprint) {
            return { kind: 'changed' as const };
          }
          const result = reconcileExecutionLedger(ledger.orders, snapshot);
          if (result.issues.length) {
            const onlyPropagationDelay = result.retryableIssues.length > 0
              && result.retryableIssues.length === result.issues.length;
            if (onlyPropagationDelay) return { kind: 'retryable' as const };
            throw new Error(result.issues.join(' '));
          }
          const previousEntryStatus = new Map(ledger.orders.map((order) => [order.id, order.status]));
          ledger.orders = result.orders;
          for (const recovered of ledger.orders.filter((order) => order.executionMode === 'live'
            && order.status === 'open' && previousEntryStatus.get(order.id) !== 'open')) {
            attachMatchedLiveFillShadow(ledger.orders, recovered);
          }
          await writeLedger(ledger);
          return { kind: 'committed' as const, result };
        });
        if (attempt.kind !== 'committed') continue;
        successful = { snapshot, result: attempt.result, completedThroughTs };
        break;
      }

      if (!successful) throw new Error('Kalshi reconciliation could not obtain a stable complete account snapshot within the bounded retry window.');
      const { snapshot, result, completedThroughTs } = successful;
      const reconciliationScope = incremental ? 'incremental' : 'full';
      // Recovered exits use deterministic settlement ids. These calls remain idempotent if a crash occurs
      // after the ledger commit but before the budget/checkpoint commit.
      for (const settlement of result.settlements) {
        if (settlement.stakeCents > 0) {
          await settleTradingBudget(settlement.stakeCents, settlement.payoutCents, 'kalshi', settlement.relatedId);
        }
      }
      await reconcileTradingBudget({
        targetReservedCents: result.targetReservedCents, venueBalanceCents: snapshot.balanceCents,
        reason: `Kalshi ${trigger} ${reconciliationScope} reconciliation passed: ${result.targetReservedCents}c reserved, ${result.recoveredFills} fill state(s) recovered, ${snapshot.restingOrdersCanceled} managed remainder(s) canceled.`,
        auditUnchanged: trigger !== 'periodic' || result.recoveredFills > 0 || snapshot.restingOrdersCanceled > 0,
      });
      await writeKalshiReconciliationCheckpoint({
        version: KALSHI_RECONCILIATION_CHECKPOINT_VERSION,
        completedThroughTs,
        completedAt: new Date().toISOString(),
        trigger,
      }, DATA_DIR);
      const status: KalshiReconciliationStatus = {
        ...previousStatus, phase: 'ready', trigger, startedAt, completedAt: new Date().toISOString(),
        reason: `Kalshi ${trigger} ${reconciliationScope} reconciliation passed; balances, positions, orders, fills, IDs, resting orders, and local reservations agree.`,
        venueBalanceCents: snapshot.balanceCents,
        localOpenPositions: result.orders.filter((order) => order.executionMode === 'live' && order.status === 'open').length,
        venueManagedPositions: result.venueManagedPositions,
        restingOrdersCanceled: snapshot.restingOrdersCanceled,
        recoveredFills: result.recoveredFills,
      };
      setKalshiReconciliationStatus(status);
      await autoResumeTradingAfterReconciliation()
        .catch((error) => console.error('Guarded auto-resume check failed:', error));
      taskRun.succeed();
      return status;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Kalshi reconciliation failure';
      if (options.pauseOnFailure !== false) {
        await recordTradingReconciliationFailure(reason)
          .catch((auditError) => console.error('Unable to persist reconciliation failure:', auditError));
      }
      const status: KalshiReconciliationStatus = {
        ...previousStatus, phase: 'blocked', trigger, startedAt, completedAt: new Date().toISOString(), reason,
      };
      setKalshiReconciliationStatus(status);
      taskRun.fail(error);
      return status;
    }
  });
}

/**
 * Restores the shadow bankroll so paper measurement can continue after a drawdown wipes it out.
 * Order history is deliberately preserved; only the spending account is reset, and the reset is
 * counted so a restored bankroll is never mistaken for an unbroken run.
 */
/** The bankroll funding currently backing the paper desk, for reports that group history by it. */
export async function getPaperBankrollFunding(): Promise<{ fundingId: string; fundingSequence: number; startedAt?: string; resets: number; correctionCents: number }> {
  return readLedgerView((ledger) => {
    const budget = ledger.paperBudget;
    const since = budget.startedAt;
    return {
      fundingId: budget.fundingId ?? LEGACY_PAPER_BANKROLL_ID,
      fundingSequence: budget.fundingSequence ?? 1,
      startedAt: since,
      resets: budget.resets ?? 0,
      // Scoped exactly as `correctedPaperPnlCents` scopes it, so a history row and the budget panel cannot
      // report different money for the same funding.
      correctionCents: (budget.makerFeeCorrections ?? [])
        .filter((entry) => !since || entry.at >= since)
        .reduce((sum, entry) => sum + entry.realizedPnlCents, 0),
    };
  });
}

export function resetPaperBudget(bankrollCents: number): Promise<ExecutionSummary> {
  return serializeLedgerMutation(async () => {
    if (!Number.isSafeInteger(bankrollCents) || bankrollCents <= 0) throw new Error('Paper bankroll must be a positive dollar amount.');
    if (bankrollCents > MAX_PAPER_BANKROLL_CENTS) throw new Error('Paper bankroll is capped at $10,000.');
    const ledger = await mutableLedger();
    if (ledger.orders.some((order) => order.executionMode === 'paper' && (order.status === 'open' || order.status === 'pending_reservation'))) {
      throw new Error('Wait for open paper positions to settle before resetting the bankroll.');
    }
    // A reset opens a new bankroll funding, exactly as reconfiguring the control opens a live epoch.
    // Without an identity the reset would zero the counter while every prior order still summed into the
    // figure beside it, and the panel would report the whole pre-reset P&L as an unreconciled residual.
    // Corrections are deliberately dropped: they adjusted a counter this reset has just zeroed.
    const funding = nextPaperBankrollFunding(ledger.paperBudget);
    ledger.paperBudget = {
      startingCents: bankrollCents, availableCents: bankrollCents, realizedPnlCents: 0,
      resets: (ledger.paperBudget.resets ?? 0) + 1, startedAt: funding.startedAt,
      fundingId: funding.fundingId, fundingSequence: funding.fundingSequence,
    };
    await writeLedger(ledger);
    // A freshly reset bankroll has nothing reserved, so the next stake is sized off the full amount.
    return summarize(ledger.orders, 'paper', true, bankrollCents, {
      startingCents: bankrollCents, availableCents: bankrollCents, reservedCents: 0,
      proposedStakeCents: Math.min(Math.floor(bankrollCents / 100), maximumPaperStakeCents(), bankrollCents),
    }, ledger.paperBudget);
  });
}

interface LedgerFigures { startingCents: number; availableCents: number; reservedCents: number; proposedStakeCents: number }

function inferredNoFillReason(order: PaperOrder): PaperOrder['noFillReason'] {
  const reason = order.reason?.toLowerCase() ?? '';
  // Historical taker skips were durably labelled `ioc_no_fill` even though no IOC reached the venue.
  // Correct the bounded read model from the immutable reason; never rewrite the execution ledger.
  if (order.status === 'unfilled' && reason.startsWith('taker not submitted:')) return 'pre_submit_quote_moved';
  if (order.noFillReason) return order.noFillReason;
  if (order.status === 'unfilled' && reason.includes('post-only') && (reason.includes('cross') || reason.includes('acknowledgement race'))) return 'post_only_race';
  if (order.status === 'unfilled' && order.venueOrderId
    && (order.entryExecutionDecision?.executedStyle === 'taker' || order.liquidityRole === 'taker')) return 'ioc_no_fill';
  if (order.status === 'unfilled' && order.venueOrderId) return 'rested_no_fill';
  return undefined;
}

/** API presentation groups durable attempts; the underlying audit/reconciliation ledger remains unchanged. */
export function groupedRecentOrders(orders: PaperOrder[]): PaperOrder[] {
  const groups = new Map<string, PaperOrder[]>();
  for (const order of orders) {
    const key = order.logicalOrderId && !order.id.includes(':exit:') ? order.logicalOrderId : order.id;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  return [...groups.values()].map((attempts) => {
    attempts.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const latest = attempts.at(-1)!;
    // Storage references are internal publication pointers, not order-history API fields.
    const { archivedEvidence: _archivedEvidence, ...presented } = latest;
    const history = attempts.map((attempt, index) => ({
      id: attempt.id, attemptNumber: attempt.attemptNumber ?? index + 1, status: attempt.status,
      noFillReason: inferredNoFillReason(attempt), filledCount: attempt.filledCount, createdAt: attempt.createdAt,
    }));
    const recoveredAfterRetry = history.length > 1
      && history.slice(0, -1).some((attempt) => attempt.status === 'unfilled')
      && ((latest.filledCount ?? 0) > 0 || latest.status === 'open' || latest.status === 'won' || latest.status === 'lost');
    return { ...presented, noFillReason: inferredNoFillReason(latest), attemptHistory: history, recoveredAfterRetry };
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Realized paper P&L summed from order records, plus the bankroll corrections those records still carry.
 *
 * The 137 maker fills corrected on 2026-08-17 were charged a taker fee the venue does not levy on a
 * resting order. The fee was returned to the bankroll, but the order records keep it — they are evidence
 * of what the desk actually did and are never rewritten — so a figure summed from them reads lower than
 * the bankroll by exactly the amount returned. Adding the recorded corrections back is what keeps the two
 * from contradicting each other on the same screen. See docs/paper-maker-fee-design.md.
 *
 * Only `makerFeeCorrections` applies here; see `BankrollCorrection` for why its sibling must not.
 */
/** Orders bought by the bankroll funding currently backing the desk. */
function currentFundingOrders(settled: PaperOrder[], budget?: PaperBudget): PaperOrder[] {
  const funding = budget?.fundingId ?? LEGACY_PAPER_BANKROLL_ID;
  return settled.filter((order) => orderEpochId(order) === funding);
}

export function correctedPaperPnlCents(settled: PaperOrder[], budget?: PaperBudget): number {
  // Whole-cent `pnlCents`, deliberately, not the exact `actualPnlCents`. This figure is displayed beside
  // starting, available and equity, and the bankroll counter accumulates `payoutCents - stakeCents` in
  // whole cents at each settlement and exit. `actualPnlCents` is the exact reporting view: on a sold exit
  // it is priced from the fractional net liquidation, so summing it here mixes the two views and makes
  // the budget panel disagree with itself by ~100c across 205 sold exits. §1 of the agent rules forbids
  // exactly that mix; the exact view belongs in performance reporting, not in a budget.
  //
  // Scoped to the bankroll funding now backing the desk, so a reset restarts this figure with the
  // counter it must equal. Corrections are scoped the same way: a reset zeroes the counter they adjusted,
  // so one made under an earlier bankroll is no longer reflected in it and must not be added back.
  const funding = currentFundingOrders(settled, budget);
  const since = budget?.startedAt;
  const raw = funding.reduce((sum, order) => sum + (order.pnlCents ?? 0), 0);
  return raw + (budget?.makerFeeCorrections ?? [])
    .filter((entry) => !since || entry.at >= since)
    .reduce((sum, entry) => sum + entry.realizedPnlCents, 0);
}

/**
 * Which funding epoch a track's reconciling P&L covers.
 *
 * Live's working budget was re-funded, so its counter counts from that moment and only orders stamped
 * with the current `budgetEpochId` belong in the figure that ties to equity. Paper's bankroll has never
 * been reset, so its epoch is its whole life and scoping it would silently drop the 856 orders that
 * predate epoch stamping. Passing the epoch explicitly keeps that difference visible rather than
 * hard-coding a rule that is only right for one track.
 */
interface PnlScope { epochId?: string; startedAt?: string }

export function summarize(orders: PaperOrder[], mode: ExecutionMode, running: boolean, equityCents: number, figures: LedgerFigures, budget?: PaperBudget, strategyId: StrategyId = EDGE_BINARY_BUY, scope: PnlScope = {}, orderDetail: 'recent' | 'open' = 'recent'): ExecutionSummary {
  // Scoped by strategy as well as mode. The two strategies share one ledger because reconciliation is an
  // account-wide concern and a split file would leave real resting orders unmatched, so every money figure
  // read out of it has to re-narrow.
  const mine = orders.filter((order) => order.executionMode === mode && orderStrategyId(order) === strategyId);
  const isSettled = (order: PaperOrder) => order.status === 'won' || order.status === 'lost' || order.status === 'invalid' || order.status === 'sold';
  const settled = mine.filter(isSettled);
  /** Every strategy on this track. Only the money figures that mirror an account-wide counter use it. */
  const accountWide = orders.filter((order) => order.executionMode === mode && isSettled(order));
  const open = mine.filter((order) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain');
  const openOrders = open.length;
  // Scoped exactly as the headline P&L is scoped, per track: paper by the bankroll funding backing the
  // desk, live by the current budget epoch. An anchor drawn from a wider cohort would date the figures
  // beside it to a funding that never paid for them.
  const funded = mode === 'paper'
    ? currentFundingOrders(mine, budget)
    : mine.filter((order) => !scope.epochId || order.budgetEpochId === scope.epochId);
  const fundingFirstOrderAt = funded.map((order) => order.createdAt).filter(Boolean).sort()[0];
  return {
    mode, running,
    depleted: equityCents <= 0 && openOrders === 0,
    startingCents: figures.startingCents,
    availableCents: figures.availableCents,
    reservedCents: figures.reservedCents,
    proposedStakeCents: figures.proposedStakeCents,
    // A bankroll that has never been reset reports 0, not silence: the panel distinguishes "the counter
    // has never moved" from "this track has no reset counter", which is live's case — its budget is
    // re-funded through the control. Normalized exactly as `getPaperBankrollFunding` normalizes it.
    bankrollResets: budget ? budget.resets ?? 0 : undefined,
    openOrders,
    settledOrders: settled.length,
    wins: mine.filter((order) => order.status === 'won').length,
    losses: mine.filter((order) => order.status === 'lost').length,
    /**
     * Both figures are whole-cent `pnlCents`, because they sit beside budget counters that move in
     * whole cents; the exact `actualPnlCents` belongs in performance reporting.
     *
     * Live is scored **account-wide**, deliberately not re-narrowed by strategy. §4 forbids strategies
     * sharing money, and they do not — but live cash is one real Kalshi balance and `settleDueOrders`
     * settles it through the shared control whatever strategy spent it, so the counter beside this
     * figure is account-wide by construction. Narrowing to the edge policy reads 183c against the
     * counter's 152c, the difference being the long-shot strategy's draw on the same balance, and the
     * panel would contradict itself. Paper is the opposite case: its bankroll is the edge policy's own,
     * which is why the leak correction existed at all, so it stays narrowed and corrected.
     */
    realizedPnlCents: mode === 'paper' && strategyId === EDGE_BINARY_BUY
      ? correctedPaperPnlCents(settled, budget)
      : accountWide.filter((order) => !scope.epochId || order.budgetEpochId === scope.epochId)
        .reduce((sum, order) => sum + (order.pnlCents ?? 0), 0),
    lifetimePnlCents: mode === 'paper' && strategyId === EDGE_BINARY_BUY
      ? correctedPaperPnlCents(settled, budget)
      : accountWide.reduce((sum, order) => sum + (order.pnlCents ?? 0), 0),
    pnlScope: scope.epochId ? 'budget-epoch' : 'lifetime',
    ...(scope.startedAt ? { epochStartedAt: scope.startedAt } : {}),
    /**
     * The earliest order the figures above cover. Paper's original bankroll predates funding stamping and
     * holds no opening timestamp, so this is the only anchor it has; it is reported as a first trade and
     * never as a funding moment, which is a different fact the record simply does not contain.
     */
    ...(fundingFirstOrderAt ? { fundingFirstOrderAt } : {}),
    equityCents,
    // Scheduled readers need current intents, not 30 terminal rows carrying large reporting evidence.
    // The control dialog opts into bounded recent history only when it is actually opened.
    recentOrders: groupedRecentOrders(orderDetail === 'recent' ? mine : open).slice(0, 30),
  };
}

/**
 * Detached order-ledger rows for reporting. Full historical evidence is explicit and on-demand; fixed
 * polling and funded control readers must pass `includeArchivedEvidence: false`.
 */
export async function getExecutionOrders(filter: {
  executionMode?: ExecutionMode;
  strategyId?: StrategyId;
  includeArchivedEvidence?: boolean;
} = {}): Promise<PaperOrder[]> {
  const orders = await readLedgerView((ledger) => ledger.orders.filter((order) =>
    (!filter.executionMode || order.executionMode === filter.executionMode)
    && (!filter.strategyId || orderStrategyId(order) === filter.strategyId)));
  return filter.includeArchivedEvidence === false ? orders : hydrateExecutionOrders(orders, DATA_DIR);
}

/** Funded paper bankroll. The paper track's strategy allocations are percentages of this, not of live cash. */
export async function getPaperBankrollStartingCents(): Promise<number> {
  return readLedgerView((ledger) => ledger.paperBudget.startingCents);
}

function publicPaperExecution(order: PaperOrder): PublicPaperExecutionRecord {
  return {
    symbol: order.symbol, venue: order.venue, side: order.side, status: order.status,
    createdAt: order.createdAt, closesAt: order.closesAt,
    askPrice: order.issuanceAskPrice ?? order.entryDecision?.actionableAsk ?? order.askPrice,
    quantity: order.quantity, stakeCents: order.actualStakeCents ?? order.stakeCents,
    feeCents: order.actualFeeCents ?? order.feeCents,
    pnlCents: order.actualPnlCents ?? order.pnlCents, outcome: order.outcome,
    noFillReason: inferredNoFillReason(order), liquidityRole: order.liquidityRole,
  };
}

/**
 * Bounded paper-only ledger view for the public research dashboard. It intentionally excludes live
 * records, client/venue identifiers, contracts, account state, decision snapshots, and mutations.
 */
function publicPaperBudgetFromLedger(ledger: Ledger): PublicPaperBudget {
  // The published track record is the edge policy's. A second strategy's results must not be blended into
  // it: the public figure would then describe neither strategy.
  const orders = ledger.orders.filter((order) => order.executionMode === 'paper' && orderStrategyId(order) === EDGE_BINARY_BUY);
  const openOrders = orders.filter((order) => order.status === 'open' || order.status === 'pending_reservation');
  const settledOrders = orders.filter((order) => order.status === 'won' || order.status === 'lost' || order.status === 'invalid' || order.status === 'sold');
  const reservedCents = openOrders.reduce((total, order) => total + order.stakeCents, 0);
  const availableCents = ledger.paperBudget.availableCents;
  return {
    durable: true,
    startingCents: ledger.paperBudget.startingCents,
    availableCents,
    equityCents: availableCents + reservedCents,
    reservedCents,
    proposedStakeCents: availableCents > 0 ? Math.min(availableCents, maximumPaperStakeCents()) : 0,
    running: availableCents > 0,
    depleted: availableCents <= 0 && openOrders.length === 0,
    openOrders: openOrders.length,
    settledOrders: settledOrders.length,
    realizedPnlCents: correctedPaperPnlCents(settledOrders, ledger.paperBudget),
    bankrollResets: ledger.paperBudget.resets ?? 0,
    recentExecutions: groupedRecentOrders(orders).slice(0, 30).map(publicPaperExecution),
  };
}

export async function syncCurrentPublicPaperBudgetProjection(): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  const payload = await readLedgerView(publicPaperBudgetFromLedger);
  await syncPublicPaperBudgetToPostgres(payload);
}

export async function getPublicPaperBudget(): Promise<PublicPaperBudget | null> {
  // A hosted dashboard reads the replicated projection; it never opens a local ledger. An unavailable
  // projection is not a zero bankroll: the route reports 503 so readers cannot mistake outage for loss.
  if (isStatelessDeployment()) return readPublicPaperBudgetFromPostgres();
  return readLedgerView(publicPaperBudgetFromLedger);
}

interface ExecutionSummaryControl {
  state: string;
  mode: string;
  startingBudgetCents: number;
  workingEquityCents: number;
  availableBudgetCents: number;
  reservedBudgetCents: number;
  proposedStakeCents: number;
  perTradeCents: number;
  epochId?: string;
  epochStartedAt?: string;
}

function deriveExecutionSummaries(ledger: Ledger, control: ExecutionSummaryControl, includeRecentOrders: boolean) {
  const now = Date.now();
  const persistenceRequirements = productionSignalPersistence();
  const openPaper = ledger.orders.filter((order) => order.executionMode === 'paper' && (order.status === 'open' || order.status === 'pending_reservation')).reduce((sum, order) => sum + order.stakeCents, 0);
  const paperAvailable = ledger.paperBudget.availableCents;
  // Paper has separate cash but uses the same explicit all-in purchase size for comparable shadow fills.
  const paperStake = Math.max(0, Math.min(control.perTradeCents, maximumPaperStakeCents(), paperAvailable));
  return {
    paper: summarize(ledger.orders, 'paper', paperAvailable > 0, paperAvailable + openPaper, {
      startingCents: ledger.paperBudget.startingCents, availableCents: paperAvailable,
      reservedCents: openPaper, proposedStakeCents: paperStake,
      // Dated, but not epoch-scoped. `correctedPaperPnlCents` already counts from the bankroll funding, so
      // the opening moment belongs on the panel; passing an `epochId` as well would relabel the scope and
      // publish a lifetime figure identical to the headline, which reads as a discrepancy.
    }, ledger.paperBudget, EDGE_BINARY_BUY, { startedAt: ledger.paperBudget.startedAt }, includeRecentOrders ? 'recent' : 'open'),
    live: {
      ...summarize(ledger.orders, 'live', control.state === 'active' && control.mode === 'live' && liveTradingEnabled(), control.workingEquityCents, {
        startingCents: control.startingBudgetCents,
        availableCents: control.availableBudgetCents, reservedCents: control.reservedBudgetCents,
        proposedStakeCents: Math.min(control.proposedStakeCents, maxLiveStakeCents()),
        // Live's counter was re-funded, so only this epoch's orders tie to the equity shown beside them.
      }, undefined, EDGE_BINARY_BUY, { epochId: control.epochId, startedAt: control.epochStartedAt }, includeRecentOrders ? 'recent' : 'open'),
      blockedReason: ledger.lastLiveSkip?.reason,
    },
    executionSignals: Object.values(ledger.signalPersistence)
      .filter((state) => Date.parse(state.closesAt) > now)
      .map((state) => {
        let result = evaluateSignalPersistence(state, now, MIN_NET_EDGE, MIN_ESTIMATE_QUALITY);
        const windowOrders = ledger.orders.filter((order) => order.executionMode === 'live' && order.symbol === state.symbol
          && order.side === state.side && order.closesAt === state.closesAt && !order.id.includes(':exit:'))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const latestSold = windowOrders.filter((order) => order.status === 'sold' && order.settledAt).at(-1);
        const currentOrders = latestSold ? windowOrders.filter((order) => Date.parse(order.createdAt) > Date.parse(latestSold.settledAt!)) : windowOrders;
        const logicalId = currentOrders.at(-1)?.logicalOrderId;
        const attempts = logicalId ? entryAttemptsForLogicalOrder(ledger.orders, logicalId) : [];
        const liveOrder = attempts.at(-1);
        const adaptive = entryExecutionSettings().mode === 'adaptive';
        const retry = adaptive
          ? adaptiveEntryEpisodeDecision(attempts, ENTRY_EXECUTION_POLICY_VERSION)
          : makerRetryDecision(attempts, now, state.closesAt, maximumLiveMakerAttempts());
        const portfolio = ledger.portfolioDecisions[`${state.symbol}:${state.side}:${state.closesAt}`];
        const fallbackOpen = adaptive && retry.allowed && Boolean(retry.takerFallback) && Boolean(liveOrder?.makerCompletedAt);
        if (fallbackOpen) {
          result = { eligible: true, reason: retry.reason, cycleAgeMs: 0, remainingMs: 0, qualifyingSnapshots: 1, medianNetEdge: null, edgeSpike: null };
        }
        const requalificationState = liveOrder?.status === 'unfilled'
          ? fallbackOpen ? 'checks_pending' as const : 'ended' as const
          : undefined;
        return {
          symbol: state.symbol, side: state.side, closesAt: state.closesAt, eligible: result.eligible,
          reason: result.reason, qualifyingSnapshots: result.qualifyingSnapshots,
          requiredSnapshots: persistenceRequirements.requiredSnapshots,
          requiredSpanMs: persistenceRequirements.requiredSpanMs,
          medianNetEdge: result.medianNetEdge, portfolio,
          liveAttempt: liveOrder ? {
            status: liveOrder.status, createdAt: liveOrder.createdAt, filledCount: liveOrder.filledCount,
            quantity: liveOrder.quantity, reason: liveOrder.reason, noFillReason: inferredNoFillReason(liveOrder),
            attemptNumber: liveOrder.entryEpisode ?? liveOrder.attemptNumber ?? attempts.length,
            maximumAttempts: adaptive ? MAX_ENTRY_EPISODES_PER_WINDOW : maximumLiveMakerAttempts(),
            retryEligible: fallbackOpen, executedStyle: liveOrder.entryExecutionDecision?.executedStyle,
            requalificationState,
          } : undefined,
        };
      }),
    liveAvailable: liveTradingEnabled(),
    liveBlockers: liveBlockers(),
    maximumLiveEntryEpisodes: entryExecutionSettings().mode === 'adaptive' ? MAX_ENTRY_EPISODES_PER_WINDOW : maximumLiveMakerAttempts(),
    portfolioConstraints: (() => {
      const constraints = portfolioConstraints();
      return {
        maximumPositions: constraints.maximumPositions,
        maximumSameWindow: constraints.maximumSameWindow,
        maximumSameGroupPerWindow: constraints.maximumSameGroupPerWindow,
      };
    })(),
  };
}

export async function getExecutionSummaries(
  control: ExecutionSummaryControl,
  options: { includeRecentOrders?: boolean } = {},
): Promise<{ paper: ExecutionSummary; live: ExecutionSummary; executionSignals: ExecutionSignalReadiness[]; liveAvailable: boolean; liveBlockers: string[]; maximumLiveEntryEpisodes: number; portfolioConstraints: Pick<PortfolioConstraints, 'maximumPositions' | 'maximumSameWindow' | 'maximumSameGroupPerWindow'>; regimeGate: RegimeGateStatus }> {
  const [execution, regimeGate] = await Promise.all([
    // Derive while holding the committed ledger view; clone only this bounded result, never the 35 MB ledger.
    readLedgerView((ledger) => deriveExecutionSummaries(ledger, control, options.includeRecentOrders === true)),
    getRegimeGateStatus(),
  ]);
  return { ...execution, regimeGate };
}
