import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beginLiveTransaction, blockExecutionDrain, completeExecutionDrain, endLiveTransaction, getExecutionDrainStatus, startExecutionDrain } from './execution-drain-state';
import { CALENDAR_EVALUATION_VERSION, calendarFixedSnapshotDue, updateCalendarEvaluationStore, type CalendarEvaluationCycle } from './calendar-evaluation-store';
import { reconcileExecutionLedger } from './execution-reconciliation';
import { ENTRY_EXECUTION_POLICY_VERSION, entrySideProbability, evaluateEntryExecutionPolicy, makerCohortEvidence, parseEntryExecutionMode, type EntryExecutionDecision } from './entry-execution-policy';
import { POST_EXIT_REENTRY_COOLDOWN_MS, evaluateExitPolicy } from './exit-policy';
import { estimateMakerFill } from './maker-fill-model';
import { fetchKalshiManagedMakerQuote, fetchKalshiQuote, fetchKalshiTradePrintsSince } from './kalshi-market-data';
import { observeKalshiOrderBook } from './kalshi-depth';
import { simulateManagedPaperMaker, type PaperMakerSimulationResult } from './paper-maker-simulation';
import { isFreshCalculationTimestamp } from './freshness';
import { observationBucket } from './observation-window';
import { selectedSideDepth } from './order-book-depth';
import { selectedManagedMakerQuote } from './managed-maker';
import { orderMarketId, orderProviderId, orderStrategyId } from './execution-report';
import { EDGE_BINARY_BUY } from './strategy-registry';
import { recordContractPaths } from './contract-path-store';
import { getHoldSentinels, updateHoldSentinelStore } from './hold-sentinel-store';
import { collectLongShotEvidence, longShotAllocationCents } from './long-shot-execution';
import { evaluateLongShotEntry, longShotSettings } from './long-shot-policy';
import { LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import {
  buildLongShotOrder, longShotDailyNetLossCents, longShotFunding, openLongShotPositions,
} from './long-shot-engine';
import {
  TARGET_EXIT_POLL_MS, evaluateTargetExit, observePeakBid, targetExitPosition, targetExitSettlement,
} from './target-exit-policy';
import { cachedKalshiRead } from './kalshi-quote-cache';
import {
  TRAILING_ENTRY_POLL_MS, beginTrailingEntry, evaluateTrailingEntry, observeTrailingEntry,
  trailingGainCents, type TrailingEntryState,
} from './trailing-entry';

/**
 * Entry cadence while nothing is being trailed, and the quote max-age at that cadence.
 *
 * Once a side qualifies, `TRAILING_ENTRY_POLL_MS` takes over for that contract: the pass looks four times
 * a second while a price is still falling, and buys when it stalls. The quote max-age is set just below
 * the poll interval so the timer governs the cadence rather than the cache occasionally serving the
 * previous tick's value.
 */
const LONG_SHOT_ENTRY_POLL_MS = 1_000;
const TRAILING_QUOTE_MAX_AGE_MS = TRAILING_ENTRY_POLL_MS - 50;

/** Live trailing state per asset/window/side. Cleared when the entry resolves, abandons, or expires. */
const trailing = new Map<string, TrailingEntryState>();
import { assetAdmitted } from './asset-exclusion';
import { cycleRegimeFor } from './cycle-path-store';
import { DEFAULT_MARKET_ID } from './market-registry';
import { marketFunding } from './provider-budget-policy';
import { getProviderBudgets, providerBudget } from './provider-budget-store';
import { isStatelessDeployment } from './runtime-environment';
import { postgresPaperProjectionSyncEnabled, readPublicPaperBudgetFromPostgres, syncPublicPaperBudgetToPostgres } from './postgres-paper-projection';
import { fetchKalshiReconciliationSnapshot } from './kalshi-reconciliation';
import { entryAttemptsForLogicalOrder, makerAttemptId, makerRetryDecision, maximumLiveMakerAttempts, maximumPaperMakerAttempts } from './maker-retry-policy';
import { evaluateLiveRisk } from './live-risk-policy';
import { liveBlockers, liveTradingEnabled, maxLiveOrdersPerHour, maxLiveStakeCents, placeKalshiBuy, placeKalshiSell, placeKalshiTakerBuy } from './live-orders';
import { countFilledLiveVenueOrders } from './order-rate-limit';
import { selectPortfolio, DEFAULT_PORTFOLIO_CONSTRAINTS, parseMaximumOpenPositions, type PortfolioConstraints } from './portfolio-policy';
import { bestEntry, bestVenueEntry, BUY_POLICY_VERSION, edgeStrength, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, qualifiesAsBuyEdge, qualifiesVenueBuyEdge, sideProbability, venueFeeRate } from './prediction-policy';
import { getKalshiReconciliationStatus, serializedReconciliation, setKalshiReconciliationStatus, type KalshiReconciliationStatus } from './reconciliation-state';
import { getRegimeGateStatus, updateRegimeGate, type RegimeGateStatus, type RegimeSentinelCandidate } from './regime-gate-store';
import { TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION, updatePersistenceCandidateStore, type PersistenceCandidateCycle } from './persistence-candidate-store';
import { advanceSignalPersistence, evaluateSignalPersistence, evaluateSignalPersistenceWithRequirements, type SignalEligibility, type SignalPersistenceState } from './signal-persistence';
import { REQUIRED_SWITCH_SNAPSHOTS, REQUIRED_SWITCH_SPAN_MS, advanceSwitchPersistence, switchCooldownRemainingMs, switchEvidenceReady, switchEvidenceSpanMs, type SwitchPersistenceState } from './switch-hysteresis';
import { evaluateSwitchProbabilityGate, switchPolicySettings, valueSwitch } from './switch-policy';
import { autoResumeTradingAfterReconciliation, getTradingControl, pauseTrading, reconcileTradingBudget, recordTradingReconciliationFailure, releaseTradingBudget, reserveTradingBudget, settleTradingBudget, stopTradingForLiveRisk, suspendTrading } from './trading-control';
import type { DashboardData, ExecutionMode, ExecutionSignalReadiness, ExecutionSummary, MarketFunding, MarketId, PaperOrder, PortfolioDecisionView, PositionSide, Prediction, ProviderBudgetConfiguration, PublicPaperBudget, PublicPaperExecutionRecord, StrategyId, TradingControlData, TradingProviderId } from './types';

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
let engineQueue: Promise<void> = Promise.resolve();
let automaticReconciliationRequested = false;

interface PaperBudget { startingCents: number; availableCents: number; realizedPnlCents: number; resets?: number; startedAt?: string }
export const MAX_PAPER_BANKROLL_CENTS = 1_000_000;
interface Ledger { version: 6; paperBudget: PaperBudget; orders: PaperOrder[]; signalPersistence: Record<string, SignalPersistenceState>; portfolioDecisions: Record<string, PortfolioDecisionView>; switchPersistence: Record<string, SwitchPersistenceState>; lastLiveSkip?: { reason: string; at: string } }

async function readLedger(): Promise<Ledger> {
  try {
    const raw = JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as Partial<Ledger> & { orders?: PaperOrder[] };
    return {
      version: 6,
      paperBudget: raw.paperBudget ?? { startingCents: DEFAULT_PAPER_BANKROLL_CENTS, availableCents: DEFAULT_PAPER_BANKROLL_CENTS, realizedPnlCents: 0 },
      orders: (raw.orders ?? []).map((order) => ({ ...order, executionMode: order.executionMode ?? 'paper' })),
      // Persistence is side-specific. Legacy UP-only streaks are discarded rather than reused
      // for a potentially opposite-side order after deployment.
      signalPersistence: Object.fromEntries(Object.entries(raw.signalPersistence ?? {}).filter(([, state]) => state.side === 'UP' || state.side === 'DOWN')),
      portfolioDecisions: raw.portfolioDecisions ?? {},
      switchPersistence: raw.switchPersistence ?? {},
      lastLiveSkip: raw.lastLiveSkip,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 6, paperBudget: { startingCents: DEFAULT_PAPER_BANKROLL_CENTS, availableCents: DEFAULT_PAPER_BANKROLL_CENTS, realizedPnlCents: 0 }, orders: [], signalPersistence: {}, portfolioDecisions: {}, switchPersistence: {} };
    }
    throw error;
  }
}

async function writeLedger(ledger: Ledger): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${LEDGER_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2));
  await rename(temporary, LEDGER_FILE);
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
    minimumTakerNetEdge: bounded('MONEY_NOODLE_MIN_TAKER_NET_EDGE', 0.15, 0.5),
    minimumMedianNetEdge: bounded('MONEY_NOODLE_MIN_TAKER_MEDIAN_EDGE', 0.10, 0.5),
    minimumConfidence: bounded('MONEY_NOODLE_MIN_TAKER_QUALITY', 0.65, 1),
    maximumSpread: bounded('MONEY_NOODLE_MAX_TAKER_SPREAD', 0.02, 0.25),
    minimumMakerSamples: Math.max(1, Math.floor(bounded('MONEY_NOODLE_MIN_TAKER_MAKER_SAMPLES', 30, 10_000))),
    minimumTakerAdvantage: bounded('MONEY_NOODLE_MIN_TAKER_ADVANTAGE', 0.02, 0.5),
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
import type { PaperFill } from './venue-fill';
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

function executionEligibility(prediction: Prediction, side: PositionSide, ledger: Ledger, nowMs = Date.now()): SignalEligibility {
  return evaluateSignalPersistence(ledger.signalPersistence[persistenceKey(prediction, side)], nowMs, MIN_NET_EDGE, MIN_ESTIMATE_QUALITY);
}

/**
 * Builds a prospective two-snapshot policy observation without consulting automation, cash, or current
 * positions. Those are operational constraints rather than properties of the signal being compared.
 * Every ordinary prediction, quote, timing, asset, and classified-regime gate remains unchanged.
 */
async function persistenceCandidateCycle(dashboard: DashboardData, ledger: Ledger, regimeAllowsEntries: boolean): Promise<PersistenceCandidateCycle> {
  const nowMs = Date.now();
  const observedAt = dashboard.generatedAt;
  const intents: PersistenceCandidateCycle['intents'] = [];
  const productionEligibleIds: string[] = [];

  for (const prediction of dashboard.predictions) {
    const side = selectedSide(prediction);
    if (!regimeAllowsEntries || !side || !prediction.market.live || !prediction.kalshi?.live || !assetAdmitted(prediction.symbol)) continue;
    if (!qualifiesAsBuyEdge(prediction) || !qualifiesVenueBuyEdge(prediction, 'kalshi', side)) continue;
    const regime = (await cycleRegimeFor(prediction.symbol, prediction.market.closesAt))?.regime;
    if (!regimeAdmits(regime)) continue;
    const quote = venueQuote(prediction, 'kalshi', side);
    const entry = bestVenueEntry(prediction, 'kalshi', side);
    if (!quote || !entry || !(quote.bid > 0) || quote.bid > quote.ask || quote.ask - quote.bid > MAX_SPREAD) continue;

    const state = ledger.signalPersistence[persistenceKey(prediction, side)];
    const candidate = evaluateSignalPersistenceWithRequirements(state, nowMs, MIN_NET_EDGE, MIN_ESTIMATE_QUALITY, {
      requiredSnapshots: 2, requiredSpanMs: 15_000,
    });
    const production = executionEligibility(prediction, side, ledger, nowMs);
    const id = `${TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION}:${BUY_POLICY_VERSION}:${prediction.symbol}:${side}:${prediction.kalshi.closesAt}`;
    if (production.eligible) productionEligibleIds.push(id);
    if (!candidate.eligible || !isFreshCalculationTimestamp(observedAt, nowMs)) continue;
    const observations = state?.observations.slice(-2) ?? [];
    const spanMs = observations.length < 2 ? 0
      : observationBucket(Date.parse(observations.at(-1)!.at)) - observationBucket(Date.parse(observations[0].at));
    const touch = prediction.makerFillEstimates?.[side] ?? prediction.makerFillEstimate ?? null;
    const cohort = makerCohortEvidence(ledger.orders, quote.ask, quote.ask - quote.bid);
    const makerEstimate = estimateMakerFill({
      touch, cohortLabel: cohort.label, cohortAttempts: cohort.accepted, cohortFills: cohort.fills,
    });
    intents.push({
      id, candidateVersion: TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION,
      productionPolicyVersion: BUY_POLICY_VERSION,
      symbol: prediction.symbol, contractId: prediction.kalshi.ticker, side,
      closesAt: prediction.kalshi.closesAt, createdAt: observedAt, calculationAt: observedAt,
      selectedSideProbability: sideProbability(prediction, side), confidence: prediction.confidence,
      askPrice: quote.ask, bidPrice: quote.bid, spread: quote.ask - quote.bid,
      estimatedAskFeeRate: entry.feeRate, estimatedMakerFeeRate: venueFeeRate('kalshi', quote.bid),
      predictedNetEdge: entry.netEdge, qualifyingSnapshots: candidate.qualifyingSnapshots,
      observationSpanMs: spanMs, productionEligibleAtCandidate: production.eligible,
      ...(production.eligible ? { productionEligibleAt: observedAt, productionDelayMs: 0 } : {}),
      makerFillProbability: makerEstimate?.probability ?? null,
      makerFillModel: makerEstimate?.model,
    });
  }
  return { productionPolicyVersion: BUY_POLICY_VERSION, observedAt, intents, productionEligibleIds };
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
      estimatedFeeUp: venueFeeRate('kalshi', prediction.kalshi.askUp),
      estimatedFeeDown: venueFeeRate('kalshi', prediction.kalshi.askDown),
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
      estimatedFeeRate: entry.feeRate, estimatedMakerFeeRate: venueFeeRate('kalshi', quote.bid),
      predictedNetEdge: entry.netEdge,
      makerFillProbability: makerEstimate?.probability ?? null, makerFillModel: makerEstimate?.model,
    };
  }
  return { productionPolicyVersion: BUY_POLICY_VERSION, observedAt: dashboard.generatedAt, forecasts, windows: [...windows.values()] };
}

function entryExecutionDecision(prediction: Prediction, side: PositionSide, order: PaperOrder, ledger: Ledger): EntryExecutionDecision {
  const settings = entryExecutionSettings();
  const entry = bestVenueEntry(prediction, 'kalshi', side);
  const eligibility = executionEligibility(prediction, side, ledger);
  const evidence = makerCohortEvidence(ledger.orders, order.askPrice, order.spread);
  return evaluateEntryExecutionPolicy({
    ...settings,
    currentNetEdge: entry?.netEdge ?? Number.NEGATIVE_INFINITY,
    medianNetEdge: eligibility.medianNetEdge ?? Number.NEGATIVE_INFINITY,
    confidence: prediction.confidence,
    spread: order.spread,
    makerNetEdge: entrySideProbability(prediction.modelProbabilityUp, side) - order.bidPrice,
    makerEvidence: evidence,
  });
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
function buildOrder(prediction: Prediction, side: PositionSide, status: TradingControlData, ledger: Ledger, calculationAt: string, modelVersion: string, mode: ExecutionMode, stakeLimitCents: number, venueFilter?: 'kalshi'): { order: PaperOrder } | { reason: string } {
  if (stakeLimitCents <= 0) return { reason: 'Stake sizing produces zero cents. Raise the budget or purchase percentage.' };
  const rejections: string[] = [];
  const candidates = status.venues.flatMap((readiness) => {
    if (!readiness.enabled || !readiness.tradeReady) return [];
    if (venueFilter && readiness.venue !== venueFilter) return [];
    const quote = venueQuote(prediction, readiness.venue, side);
    const entry = bestVenueEntry(prediction, readiness.venue, side);
    if (!entry || !qualifiesVenueBuyEdge(prediction, readiness.venue, side)) return [];
    if (!quote || quote.ask > MAX_FILLABLE_ASK || quote.ask <= 0 || quote.bid <= 0 || quote.bid > quote.ask) return [];
    const spread = quote.ask - quote.bid;
    if (spread > MAX_SPREAD) { rejections.push(`${readiness.venue} spread ${(spread * 100).toFixed(1)}c exceeds the ${MAX_SPREAD * 100}c limit`); return []; }
    if (Date.parse(quote.closesAt) - Date.now() < MIN_TIME_TO_CLOSE_MS) { rejections.push(`${readiness.venue} contract is inside the final ${MIN_TIME_TO_CLOSE_MS / 1000}s`); return []; }
    const fill = estimatePaperFill(stakeLimitCents, quote.ask, readiness.venue);
    if (!fill) {
      const priceCents = quote.ask * 100;
      const minimumQuantity = readiness.venue === 'kalshi' ? 0.01 : 1;
      const minimumCents = Math.ceil(minimumQuantity * priceCents - 1e-9) + venueFeeCents(readiness.venue, priceCents, minimumQuantity);
      rejections.push(`${stakeLimitCents}c all-in cap is short of the ${minimumCents}c conservative reserve needed for ${minimumQuantity.toFixed(2)} ${readiness.venue} contract at ${priceCents.toFixed(1)}c`);
      return [];
    }
    // Signed venue cash already excludes principal committed to positions; subtracting open exposure
    // again would double-count it and incorrectly block funded orders.
    if (mode === 'live' && (readiness.balanceCents ?? 0) < fill.stakeCents) {
      rejections.push(`${readiness.venue} cash ${readiness.balanceCents ?? 0}c is below the ${fill.stakeCents}c stake`);
      return [];
    }
    return [{ venue: readiness.venue, quote, spread, fill, entry, score: -entry.netEdge }];
  }).sort((a, b) => a.score - b.score);
  const selected = candidates[0];
  if (!selected) return { reason: rejections[0] ?? 'No enabled venue had a usable quote' };
  const eligibility = executionEligibility(prediction, side, ledger);
  return { order: {
    id: orderId(prediction, mode, side, ledger), logicalOrderId: orderId(prediction, mode, side, ledger), attemptNumber: 1,
    clientOrderId: orderId(prediction, mode, side, ledger), executionMode: mode,
    marketId: DEFAULT_MARKET_ID,
    // `buildOrder` is the edge policy's construction path; the long-shot policy builds its own orders and
    // stamps its own id. Explicit on both sides so neither can fall through to a default.
    strategyId: EDGE_BINARY_BUY,
    // Stamped at creation so a later reconfiguration cannot reattribute this order's P&L.
    budgetEpochId: status.control.epochId,
    providerId: selected.venue,
    providerVariantId: status.tradingProviders?.find((provider) => provider.id === selected.venue)?.selectedVariantId,
    symbol: prediction.symbol, venue: selected.venue,
    contractId: contractId(prediction, selected.venue), side, status: 'pending_reservation',
    createdAt: new Date().toISOString(), calculationAt, closesAt: selected.quote.closesAt,
    modelProbabilityUp: prediction.modelProbabilityUp, confidence: prediction.confidence,
    entryDecision: {
      version: 'entry-decision-v1',
      providerId: selected.venue,
      providerVariantId: status.tradingProviders?.find((provider) => provider.id === selected.venue)?.selectedVariantId,
      forecastModelVersion: modelVersion,
      executionPolicyVersion: mode === 'live' ? ENTRY_EXECUTION_POLICY_VERSION : 'paper-managed-maker-trade-queue-v2',
      policyVersion: BUY_POLICY_VERSION, calculationAt, side,
      probabilityUp: prediction.modelProbabilityUp, probabilityDown: 1 - prediction.modelProbabilityUp,
      selectedSideProbability: sideProbability(prediction, side), confidence: prediction.confidence,
      confidenceBreakdown: { ...prediction.confidenceBreakdown },
      actionableAsk: selected.quote.ask, actionableBid: selected.quote.bid,
      feeRate: selected.entry.feeRate, netEdge: selected.entry.netEdge, spread: selected.spread,
      secondsRemaining: Math.max(0, (Date.parse(selected.quote.closesAt) - Date.parse(calculationAt)) / 1000),
      qualifyingSnapshots: eligibility.qualifyingSnapshots, medianNetEdge: eligibility.medianNetEdge,
      basis: prediction.basis ? { ...prediction.basis } : undefined,
      calibrationReplay: prediction.calibrationReplay ? {
        ...prediction.calibrationReplay,
        basisInput: prediction.calibrationReplay.basisInput ? { ...prediction.calibrationReplay.basisInput } : undefined,
        slowTerms: prediction.calibrationReplay.slowTerms.map((term) => ({ ...term })),
      } : undefined,
      settlementAverageEstimate: prediction.settlementAverageEstimate ? { ...prediction.settlementAverageEstimate } : undefined,
      factors: prediction.factors.map((factor) => ({ ...factor })),
    },
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

function updatePortfolioDecisions(dashboard: DashboardData, status: TradingControlData, ledger: Ledger): boolean {
  const now = new Date().toISOString();
  const next: Record<string, PortfolioDecisionView> = {};
  const built = new Map<string, PaperOrder>();
  const retryNumbers = new Map<string, number>();
  const exposures = ledger.orders.filter((order) => order.executionMode === 'live' && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'))
    .map((order) => ({ symbol: order.symbol, closesAt: order.closesAt }));

  for (const prediction of dashboard.predictions.filter((item) => item.market.live && qualifiesAsBuyEdge(item))) {
    const entry = bestEntry(prediction);
    if (!entry) continue;
    const side = entry.side;
    const key = persistenceKey(prediction, side);
    const cooldownMs = reentryCooldownRemainingMs(ledger, prediction, 'live', side);
    if (cooldownMs > 0) {
      next[key] = { state: 'blocked', reason: `Post-exit re-entry cooldown has ${Math.ceil(cooldownMs / 1000)}s remaining; fresh persistence is also required.`, updatedAt: now };
      continue;
    }
    const attempts = liveAttempts(ledger, prediction, side);
    const retry = makerRetryDecision(attempts, Date.now(), prediction.market.closesAt, maximumLiveMakerAttempts());
    if (attempts.length && !retry.allowed) {
      const active = attempts.find((order) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain');
      next[key] = active
        ? { state: 'portfolio-selected', reason: `Existing live ${active.status.replace('_', ' ')} position occupies a constrained portfolio slot.`, expectedProfitCents: expectedProfitCents(active), updatedAt: now }
        : { state: 'blocked', reason: retry.reason, updatedAt: now };
      continue;
    }
    retryNumbers.set(key, retry.attemptNumber);
    if (!qualifiesVenueBuyEdge(prediction, 'kalshi', side)) {
      next[key] = { state: 'blocked', reason: `Standalone ${side} signal qualifies, but the Kalshi-specific ${side} quote does not clear the live net-edge and price gates.`, updatedAt: now };
      continue;
    }
    const maturity = executionEligibility(prediction, side, ledger);
    if (!maturity.eligible) {
      next[key] = { state: 'qualified', reason: `Standalone expected-value policy passes; execution evidence is still collecting. ${maturity.reason}`, updatedAt: now };
      continue;
    }
    const candidate = buildOrder(prediction, side, status, ledger, dashboard.generatedAt, dashboard.modelVersion, 'live', Math.min(status.proposedStakeCents, maxLiveStakeCents()), 'kalshi');
    if ('reason' in candidate) {
      next[key] = { state: 'blocked', reason: candidate.reason, updatedAt: now };
      continue;
    }
    built.set(key, candidate.order);
  }

  const selection = selectPortfolio([...built.entries()].map(([id, order]) => ({
    id, symbol: order.symbol, closesAt: order.closesAt, expectedProfitCents: expectedProfitCents(order),
  })), exposures, portfolioConstraints());
  for (const item of selection) next[item.id] = {
    state: item.selected ? 'portfolio-selected' : 'blocked',
    reason: `${item.reason}${(retryNumbers.get(item.id) ?? 1) > 1 ? ` Bounded maker retry attempt ${retryNumbers.get(item.id)}/${maximumLiveMakerAttempts()}; all current gates were revalidated.` : ''}`,
    expectedProfitCents: item.expectedProfitCents, adjustedExpectedContributionCents: item.adjustedExpectedContributionCents,
    rank: item.rank ?? undefined, updatedAt: now,
  };
  const changed = JSON.stringify(ledger.portfolioDecisions) !== JSON.stringify(next);
  ledger.portfolioDecisions = next;
  return changed;
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
  const feeCents = venueFeeCents(order.venue, result.averagePrice * 100, result.filledCount);
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
  try {
    const result = await simulateManagedPaperMaker({
      side: order.side, requestedCount: order.quantity,
      maximumPrice: order.approvedMaximumPrice ?? order.askPrice,
      requestedStart: order.issuanceBidPrice ?? order.bidPrice,
    }, {
      quote: () => fetchKalshiManagedMakerQuote(order.contractId, order.side),
      tradesSince: (sinceMs) => fetchKalshiTradePrintsSince(order.contractId, sinceMs),
    });
    applyPaperMakerSimulation(order, result, ledger);
  } catch (error) {
    const reservedCents = order.stakeCents;
    order.status = 'rejected';
    order.makerCompletedAt = new Date().toISOString();
    order.reason = `Independent paper maker simulation unavailable; reservation returned without classifying a fill miss. ${error instanceof Error ? error.message : 'Unknown simulation error'}`;
    order.entryExecutionObservations = [...(order.entryExecutionObservations ?? []), {
      at: order.makerCompletedAt, event: 'paper_expired', limitPrice: order.initialSubmittedPrice,
      filledCount: 0, remainingCount: 0, reason: order.reason,
    }];
    ledger.paperBudget.availableCents += reservedCents;
  }
}

async function managePaperMakerOrders(orders: PaperOrder[], ledger: Ledger): Promise<boolean> {
  if (!orders.length) return false;
  await Promise.all(orders.map((order) => managePaperMakerOrder(order, ledger)));
  return true;
}

async function runPaper(dashboard: DashboardData, status: TradingControlData, ledger: Ledger, regimeGate: RegimeGateStatus, budgets: ProviderBudgetConfiguration, startedOrders: PaperOrder[] = []): Promise<boolean> {
  if (ledger.paperBudget.availableCents <= 0) return false;
  // The mirror obeys policy-level live entry rules, the adaptive regime gate included. It remains
  // independent from live operational switches so simulation continues while real-money trading is off.
  if (!regimeGate.allowsEntries) return false;
  const paperProviders = new Set(status.tradingProviders?.filter((provider) => provider.paperEnabled || provider.liveEnabled).map((provider) => provider.id) ?? status.control.enabledVenues);
  const open = ledger.orders.filter((order) => order.executionMode === 'paper' && (order.status === 'open' || order.status === 'pending_reservation'));
  if (open.length >= maximumOpenPositions()) return false;
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return false;
  const equity = ledger.paperBudget.availableCents;
  const stakeLimit = Math.min(status.control.perTradeCents, maximumPaperStakeCents(), equity);
  const candidates = dashboard.predictions
    .filter((item) => qualifiesAsBuyEdge(item) && item.market.live && assetAdmitted(item.symbol))
    .flatMap((prediction) => {
      const side = selectedSide(prediction);
      if (!side || !executionEligibility(prediction, side, ledger).eligible) return [];
      if (reentryCooldownRemainingMs(ledger, prediction, 'paper', side) > 0) return [];
      // The mirror uses the same bounded-attempt policy as live. Before this check, each paper miss
      // could be submitted again every collector tick under the same id, overstating its fill rate.
      const logicalId = orderId(prediction, 'paper', side, ledger);
      const retry = makerRetryDecision(paperAttempts(ledger, prediction, side), Date.now(), prediction.market.closesAt, maximumPaperMakerAttempts());
      if (!retry.allowed) return [];
      const candidate = buildOrder(prediction, side, {
        ...status, venues: status.venues.map((readiness) => ({ ...readiness, enabled: paperProviders.has(readiness.venue) })),
      }, ledger, dashboard.generatedAt, dashboard.modelVersion, 'paper', stakeLimit, 'kalshi');
      if ('reason' in candidate) return [];
      candidate.order.logicalOrderId = logicalId;
      candidate.order.attemptNumber = retry.attemptNumber;
      candidate.order.retryOfOrderId = retry.retryOfOrderId;
      candidate.order.id = makerAttemptId(logicalId, retry.attemptNumber);
      candidate.order.clientOrderId = candidate.order.id;
      return [{ prediction, order: candidate.order, portfolioKey: persistenceKey(prediction, side) }];
    })
    // Funding is a feasibility filter applied after candidates exist, so a pair without allocation
    // headroom drops out while another provider's candidate for the same window survives.
    .filter(({ order }) => order.stakeCents <= marketFundingFor(budgets, 'paper', orderProviderId(order),
      orderMarketId(order), ledger, equity, ledger.paperBudget.availableCents).spendableCents);

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
    const resting: PaperOrder = { ...built.order, status: 'pending_reservation', liquidityRole: 'maker' };
    const funding = marketFundingFor(budgets, 'paper', orderProviderId(resting), orderMarketId(resting), ledger,
      ledger.paperBudget.availableCents, ledger.paperBudget.availableCents);
    if (resting.stakeCents > funding.spendableCents) continue;
    ledger.paperBudget.availableCents -= resting.stakeCents;
    ledger.orders.push(resting);
    startedOrders.push(resting);
    placed += 1;
  }
  return placed > 0;
}

/**
 * Adds an authoritative matched-live overlay without changing the independent paper execution result.
 * Quantity is capped at both observed live fill and the paper intent's original requested quantity.
 */
export function attachMatchedLiveFillShadow(orders: PaperOrder[], liveOrder: PaperOrder, capturedAt = new Date().toISOString()): boolean {
  if (liveOrder.executionMode !== 'live' || (liveOrder.filledCount ?? 0) <= 0 || liveOrder.authoritativeFillPrice === undefined) return false;
  const candidates = orders.filter((order) => order.executionMode === 'paper' && !order.id.includes(':exit:')
    && order.symbol === liveOrder.symbol && order.side === liveOrder.side && order.closesAt === liveOrder.closesAt
    && Math.abs(Date.parse(order.createdAt) - Date.parse(liveOrder.createdAt)) <= 60_000)
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

async function executePreparedLiveBuy(order: PaperOrder, status: TradingControlData, ledger: Ledger): Promise<void> {
  const executionStyle = order.entryExecutionDecision?.executedStyle ?? 'maker';
  beginLiveTransaction(`Managing live ${order.symbol} ${executionStyle} entry.`);
  try {
  ledger.orders.push(order);
  await writeLedger(ledger);
  try {
    await reserveTradingBudget(order.stakeCents, order.venue, order.id);
  } catch (error) {
    order.status = 'rejected';
    order.reason = error instanceof Error ? error.message : 'Budget reservation failed';
    return;
  }
  try {
    const onAccepted = async (venueOrderId: string) => { order.venueOrderId = venueOrderId; await writeLedger(ledger); };
    const onObservation = async (observation: NonNullable<PaperOrder['entryExecutionObservations']>[number]) => {
      order.entryExecutionObservations = [...(order.entryExecutionObservations ?? []), observation];
      if (order.initialSubmittedPrice === undefined && observation.event === 'create_quote' && observation.limitPrice !== undefined) {
        order.initialSubmittedPrice = observation.limitPrice;
      }
      // No I/O here: telemetry must not alter the managed order's quote/amend/cancel timing. The
      // completed path is persisted with the terminal result; accepted venue identity remains the
      // separately awaited crash-recovery boundary.
    };
    const approvedMaximumPrice = order.approvedMaximumPrice ?? order.askPrice;
    const fill = executionStyle === 'taker'
      ? await placeKalshiTakerBuy({
        ticker: order.contractId, positionSide: order.side, maximumPriceCents: approvedMaximumPrice * 100,
        count: order.quantity, clientOrderId: order.clientOrderId ?? order.id, onAccepted, onObservation,
      })
      : await placeKalshiBuy({
        ticker: order.contractId, positionSide: order.side, priceCents: approvedMaximumPrice * 100,
        startPriceCents: (order.issuanceBidPrice ?? order.bidPrice) * 100,
        count: order.quantity, clientOrderId: order.clientOrderId ?? order.id, onAccepted, onObservation,
      });
    order.venueOrderId = fill.venueOrderId;
    order.filledCount = fill.filledCount;
    order.liquidityRole = fill.liquidityRole;
    order.entryExecutionObservations = fill.executionObservations;
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
    order.noFillReason = definitivePostOnlyCross ? 'post_only_race' : definitiveTakerSkip ? 'ioc_no_fill' : undefined;
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

function applyExitObservation(order: PaperOrder, prediction: Prediction, observedAt: string): ReturnType<typeof evaluateExitPolicy> {
  const quote = venueQuote(prediction, order.venue, order.side);
  if (!quote || quote.bid <= 0 || quote.bid >= 1) return null;
  const exitFee = venueFeeCents(order.venue, quote.bid * 100, order.quantity);
  const decision = evaluateExitPolicy({
    observedAt, side: order.side, quantity: order.quantity,
    exactCostCents: order.actualStakeCents ?? order.stakeCents,
    executableBid: quote.bid, exitFeeCents: exitFee,
    ownedSideProbability: sideProbability(prediction, order.side),
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
  const ownedSideProbability = sideProbability(prediction, order.side);
  order.latestOwnedSideProbability = ownedSideProbability;
  order.latestExitObservationAt = observedAt;
  const depth = order.venue === 'kalshi'
    ? selectedSideDepth(observeKalshiOrderBook(order.contractId), order.side, quote.bid, quote.ask) : {};
  const exactCostCents = order.actualStakeCents ?? order.stakeCents;
  if (!order.positionObservations?.some((observation) => observation.at === observedAt)) {
    order.positionObservations = [...(order.positionObservations ?? []), {
      at: observedAt, selectedBid: quote.bid, selectedAsk: quote.ask, spread: quote.ask - quote.bid,
      bestBidDepth: depth.bestBidDepth, bestAskDepth: depth.bestAskDepth, depthImbalance: depth.depthImbalance,
      netLiquidationCents: decision.netLiquidationCents, exitFeeCents: decision.exitFeeCents,
      exactCostCents, unrealizedPnlCents: decision.netLiquidationCents - exactCostCents,
      unrealizedReturn: exactCostCents > 0 ? (decision.netLiquidationCents - exactCostCents) / exactCostCents : 0,
      ownedSideProbability, confidence: prediction.confidence,
      basisPercent: prediction.basis?.basisPercent, cycleRegime: prediction.cycleRegime?.regime,
      secondsRemaining: Math.max(0, (Date.parse(order.closesAt) - Date.parse(observedAt)) / 1_000),
    }];
  }
  return decision;
}

function clearEntryPersistence(ledger: Ledger, order: PaperOrder): void {
  const key = `${order.symbol}:${order.side}:${order.closesAt}`;
  delete ledger.signalPersistence[key];
  delete ledger.portfolioDecisions[key];
}

function executePaperStandaloneExit(order: PaperOrder, decision: NonNullable<ReturnType<typeof evaluateExitPolicy>>, ledger: Ledger): void {
  const payoutCents = Math.max(0, Math.floor(decision.netLiquidationCents + 1e-9));
  order.status = 'sold';
  order.standaloneExitPolicy = decision.policy;
  order.standaloneExitAttemptedAt = new Date().toISOString();
  order.standaloneExitHoldValueCents = decision.holdValueCents;
  order.standaloneExitOptimisticHoldValueCents = decision.optimisticHoldValueCents;
  order.saleProceedsCents = decision.netLiquidationCents;
  order.payoutCents = decision.netLiquidationCents;
  order.pnlCents = payoutCents - order.stakeCents;
  order.actualPnlCents = decision.netLiquidationCents - (order.actualStakeCents ?? order.stakeCents);
  order.settledAt = new Date().toISOString();
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
        onAccepted: async (venueOrderId) => { order.exitVenueOrderId = venueOrderId; await writeLedger(ledger); },
      });
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
      const exitFee = venueFeeCents('kalshi', quote.bid * 100, incumbent.quantity);
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
      onAccepted: async (venueOrderId) => { incumbent.exitVenueOrderId = venueOrderId; await writeLedger(ledger); },
    });
    incumbent.exitPending = false;
    if (exit.filledCount <= 0) {
      ledger.lastLiveSkip = { reason: `${incumbent.symbol} reduce-only switch exit did not fill; incumbent retained.`, at: new Date().toISOString() };
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
      ledger.lastLiveSkip = { reason: `${incumbent.symbol} switch exit filled ${exit.filledCount.toFixed(2)} of ${originalQuantity.toFixed(2)}; replacement withheld.`, at: new Date().toISOString() };
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
    ledger.lastLiveSkip = { reason: `Switch outcome uncertain; incumbent reservation retained pending reconciliation: ${reason}`, at: new Date().toISOString() };
    automaticReconciliationRequested = true;
    await suspendTrading(`Live switch uncertain: ${reason}`);
    return true;
  }
  } finally {
    endLiveTransaction();
  }
}

/** Live trading is gated by automation state, live mode, the environment switch, and rate limits. */
async function runLive(dashboard: DashboardData, status: TradingControlData, ledger: Ledger, regimeGate: RegimeGateStatus, budgets: ProviderBudgetConfiguration): Promise<boolean> {
  const skip = (reason: string) => { ledger.lastLiveSkip = { reason, at: new Date().toISOString() }; return false; };
  if (!liveTradingEnabled()) return skip('Live trading is off in the environment.');
  if (!status.tradingProviders?.find((provider) => provider.id === 'kalshi')?.liveEnabled) return skip('Kalshi is disabled for live automated trading in the provider registry.');
  const reconciliation = getKalshiReconciliationStatus();
  if (reconciliation.phase !== 'ready') return skip(`Kalshi reconciliation ${reconciliation.phase}: ${reconciliation.reason}`);
  if (status.control.state !== 'active') return skip(`Automation is ${status.control.state}.`);
  if (status.control.mode !== 'live') return skip('Execution mode is paper.');
  if (!status.liveRisk.allowed) {
    const reason = `Live risk stop: ${status.liveRisk.reasons.join(' ')}`;
    await stopTradingForLiveRisk(reason);
    return skip(reason);
  }
  if (!regimeGate.allowsEntries) return skip(`Adaptive regime gate: ${regimeGate.reason}`);
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return skip('Calculation snapshot is older than 15 seconds.');
  const filledOrdersLastHour = countFilledLiveVenueOrders(ledger.orders, Date.now() - 3_600_000);
  if (filledOrdersLastHour >= maxLiveOrdersPerHour()) return skip(`Hourly live filled-order limit of ${maxLiveOrdersPerHour()} reached (${filledOrdersLastHour} orders with fills; unfilled/rejected excluded).`);
  const open = ledger.orders.filter((order) => order.executionMode === 'live' && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'));
  const maximumPositions = maximumOpenPositions();
  // A strongly superior opposite side of the same asset is a replacement, never an additive hedge.
  // Evaluate that protected reduce-only reversal even when portfolio capacity remains; both the
  // probability-advantage and net-future-wealth gates must persist before any incumbent is sold.
  if (open.length > 0 && open.length < maximumPositions && filledOrdersLastHour <= maxLiveOrdersPerHour() - 2) {
    const reversal = bestSwitch(dashboard, status, ledger, open, { oppositeSameAssetOnly: true });
    if (reversal) return executeSwitch(reversal, status, ledger);
  }
  if (open.length >= maximumPositions) {
    // A complete switch consumes two accepted venue orders: reduce-only exit, then replacement entry.
    // Never close a position if the hourly ceiling would then prevent its replacement.
    if (filledOrdersLastHour > maxLiveOrdersPerHour() - 2) return skip(`Switch needs two potential fill slots; ${filledOrdersLastHour}/${maxLiveOrdersPerHour()} filled orders in the last hour.`);
    const plan = bestSwitch(dashboard, status, ledger, open);
    if (plan) return executeSwitch(plan, status, ledger);
    const pending = Object.values(ledger.switchPersistence)[0];
    const settings = switchPolicySettings();
    return pending
      ? skip(`Switch candidate is collecting persistence ${pending.observations}/${REQUIRED_SWITCH_SNAPSHOTS}; minimum observed gain ${pending.minimumDeltaCents.toFixed(2)}c.`)
      : skip(`Holding the constrained portfolio; no replacement clears liquidation costs plus ${(settings.minimumGainCents + settings.uncertaintyMarginCents).toFixed(2)}c required gain.`);
  }
  const allQualified = [...dashboard.predictions]
    .filter((item) => qualifiesAsBuyEdge(item) && item.market.live && Boolean(selectedSide(item)))
    .sort((a, b) => edgeStrength(b) - edgeStrength(a));
  // Applied to the candidate list rather than the chosen order, so an unclassified top candidate steps
  // aside for the next one instead of skipping the cycle entirely.
  const regimeByCandidate = new Map(await Promise.all(allQualified.map(async (item) =>
    [item.symbol, (await cycleRegimeFor(item.symbol, item.market.closesAt))?.regime] as const)));
  const regimeAllowed = allQualified
    .filter((item) => assetAdmitted(item.symbol))
    .filter((item) => regimeAdmits(regimeByCandidate.get(item.symbol)));
  if (allQualified.length && !regimeAllowed.length) {
    return skip(`No qualifying window has a characterised 15-second path yet (${allQualified.map((i) => `${i.symbol}:${regimeByCandidate.get(i.symbol) ?? 'unobserved'}`).join(', ')}).`);
  }
  const qualified = regimeAllowed.filter((item) => {
    const side = selectedSide(item)!;
    if (reentryCooldownRemainingMs(ledger, item, 'live', side) > 0) return false;
    return makerRetryDecision(liveAttempts(ledger, item, side), Date.now(), item.market.closesAt, maximumLiveMakerAttempts()).allowed;
  });
  const selected = qualified.filter((item) => {
    const side = selectedSide(item)!;
    return ledger.portfolioDecisions[persistenceKey(item, side)]?.state === 'portfolio-selected';
  }).sort((a, b) => {
    const aSide = selectedSide(a)!, bSide = selectedSide(b)!;
    return (ledger.portfolioDecisions[persistenceKey(a, aSide)]?.rank ?? 99) - (ledger.portfolioDecisions[persistenceKey(b, bSide)]?.rank ?? 99);
  });
  const prediction = selected.find((item) => executionEligibility(item, selectedSide(item)!, ledger).eligible);
  if (!prediction) {
    const warming = qualified[0];
    if (warming) {
      const side = selectedSide(warming)!;
      const decision = ledger.portfolioDecisions[persistenceKey(warming, side)];
      return skip(`${warming.symbol} ${side}: ${decision?.reason ?? `qualified but not execution-ready — ${executionEligibility(warming, side, ledger).reason}`}`);
    }
    const blocked = allQualified.map((item) => ({ item, side: selectedSide(item)!, retry: makerRetryDecision(liveAttempts(ledger, item, selectedSide(item)!), Date.now(), item.market.closesAt, maximumLiveMakerAttempts()) })).filter(({ retry }) => !retry.allowed);
    if (blocked.length) return skip(blocked.map(({ item, retry }) => `${item.symbol}: ${retry.reason}`).join(' '));
    return skip('No new positive-edge binary buy qualifies right now.');
  }
  const side = selectedSide(prediction)!;
  // Allocation bounds the stake before the order is built, so a pair with partial headroom sizes down
  // rather than being rejected after the fact.
  const liveFunding = marketFundingFor(budgets, 'live', 'kalshi', DEFAULT_MARKET_ID, ledger,
    status.workingEquityCents, status.control.availableBudgetCents);
  const liveStakeCeiling = Math.min(status.proposedStakeCents, maxLiveStakeCents(), liveFunding.spendableCents);
  if (liveStakeCeiling <= 0) return skip(liveFunding.reason);
  const built = buildOrder(prediction, side, status, ledger, dashboard.generatedAt, dashboard.modelVersion, 'live', liveStakeCeiling, 'kalshi');
  if ('reason' in built) return skip(`${prediction.symbol} ${side}: ${built.reason}`);
  // Defence in depth: sizing already respected the ceiling, so a stake above it means a rounding or
  // fee-reserve path put real money outside the operator's allocation.
  if (built.order.stakeCents > liveFunding.spendableCents) return skip(liveFunding.reason);
  const logicalId = orderId(prediction, 'live', side, ledger);
  const retry = makerRetryDecision(liveAttempts(ledger, prediction, side), Date.now(), prediction.market.closesAt, maximumLiveMakerAttempts());
  if (!retry.allowed) return skip(`${prediction.symbol}: ${retry.reason}`);
  built.order.logicalOrderId = logicalId;
  built.order.attemptNumber = retry.attemptNumber;
  built.order.retryOfOrderId = retry.retryOfOrderId;
  built.order.id = makerAttemptId(logicalId, retry.attemptNumber);
  built.order.clientOrderId = built.order.id;
  built.order.entryExecutionDecision = entryExecutionDecision(prediction, side, built.order, ledger);
  // Record the path label that admitted this live candidate so later cohorts can be audited.
  built.order.entryCycleRegime = (await cycleRegimeFor(prediction.symbol, prediction.market.closesAt))?.regime;
  // The authorization ceiling, captured before a fill can revise `stakeCents` down. Reconciliation
  // compares recovered venue cost against this; the shadow fields below are reporting only.
  built.order.reservedStakeCents = built.order.stakeCents;
  built.order.shadowTakerAllInCents = built.order.stakeCents;
  built.order.shadowTakerQuantity = built.order.quantity;
  ledger.lastLiveSkip = undefined;
  await executePreparedLiveBuy(built.order, status, ledger);
  return true;
}

async function processCycle(dashboard: DashboardData): Promise<void> {
  const ledger = await readLedger();
  let changed = updateSignalPersistence(dashboard, ledger);
  changed = await settleDueOrders(ledger) || changed;
  changed = await updateSoldCounterfactuals(ledger) || changed;
  if (changed) await writeLedger(ledger);
  const regimeSentinel = regimeSentinelCandidate(dashboard, ledger);
  const regimeGate = await updateRegimeGate(regimeSentinel);
  // Evaluation collection is deliberately detached: storage or settlement failure cannot delay or
  // block paper/live execution, and neither evaluation module can place an order.
  void Promise.resolve()
    .then(() => updateCalendarEvaluationStore(calendarEvaluationCycle(dashboard, ledger)))
    .catch((error) => console.error('Calendar evaluation collection failed:', error));
  void persistenceCandidateCycle(dashboard, ledger, regimeGate.allowsEntries)
    .then((cycle) => updatePersistenceCandidateStore(cycle))
    .catch((error) => console.error('Two-snapshot persistence candidate collection failed:', error));
  void recordContractPaths(dashboard.predictions ?? [])
    .catch((error) => console.error('Contract path collection failed:', error));
  const status = await getTradingControl();
  // Long-shot collection only: this records triggers and outcomes and places no order. It runs detached
  // and unconditionally, because the evidence is what decides whether to enable the policy, so gating
  // collection on it being enabled would be circular. See lib/long-shot-execution.ts.
  void getHoldSentinels()
    .then((existingSentinels) => collectLongShotEvidence({
      dashboard, orders: ledger.orders, existingSentinels,
      startingCents: longShotAllocationCents(status.control.startingBudgetCents),
    }))
    .then((cycle) => updateHoldSentinelStore(cycle))
    .catch((error) => console.error('Long-shot evidence collection failed:', error));
  changed = await observeAndExecuteStandaloneExits(dashboard, status, ledger) || changed;
  changed = updatePortfolioDecisions(dashboard, status, ledger) || changed;
  const previousSkip = ledger.lastLiveSkip?.reason;
  // Read once per cycle: a ceiling that changed mid-cycle would size one order against the old value.
  const budgets = await getProviderBudgets({ revision: status.control.revision });
  changed = resolveRestingPaperOrders(dashboard, ledger) || changed;
  const startedPaperOrders: PaperOrder[] = [];
  changed = await runPaper(dashboard, status, ledger, regimeGate, budgets, startedPaperOrders) || changed;
  // Persist paper intent and its reservation before either manager starts. Paper then polls exact public
  // evidence concurrently with live's signed order lifecycle, so a twelve-second live order can no
  // longer starve a twelve-second paper order of every intermediate observation.
  if (startedPaperOrders.length) await writeLedger(ledger);
  const paperManagement = managePaperMakerOrders(startedPaperOrders, ledger);
  const liveManagement = runLive(dashboard, status, ledger, regimeGate, budgets);
  const [paperChanged, liveChanged] = await Promise.all([paperManagement, liveManagement]);
  changed = paperChanged || liveChanged || changed;
  // Exits before entries, so a position that reached its mark this tick frees its slot for a re-entry in
  // the same cycle rather than waiting fifteen seconds. Both run inside the serialized engine queue.
  changed = await runLongShotExits(dashboardBid(dashboard), ledger) || changed;
  changed = await runLongShot(dashboard, status, ledger, 'paper') || changed;
  changed = await runLongShot(dashboard, status, ledger, 'live') || changed;
  if (changed || ledger.lastLiveSkip?.reason !== previousSkip) await writeLedger(ledger);
}

/**
 * Long-shot entries for one track.
 *
 * Deliberately separate from `runPaper`/`runLive` rather than threaded through them: the edge policy's
 * selection, persistence, maker retry, portfolio ranking, and regime gate are all specific to it, and
 * forcing a second policy through that path would change behaviour the mirror invariant depends on.
 *
 * Every account-wide protection still applies, because those are properties of the venue and the account
 * rather than of a policy: the kill switch and live arming through `liveBlockers`, the reconciliation
 * barrier, the drain, and the shared hourly filled-order ceiling.
 */
async function runLongShot(
  dashboard: DashboardData, status: TradingControlData, ledger: Ledger, mode: ExecutionMode,
): Promise<boolean> {
  const settings = longShotSettings();
  if (!settings.enabled) return false;
  if (!isFreshCalculationTimestamp(dashboard.generatedAt)) return false;
  if (getExecutionDrainStatus().phase === 'draining') return false;

  const allocation = (await getProviderBudgets({ revision: status.control.revision })).providers
    .find((provider) => provider.providerId === 'kalshi')?.allocations
    .find((item) => item.marketId === DEFAULT_MARKET_ID)?.strategies
    ?.find((strategy) => strategy.strategyId === LONG_SHOT_ROUND_TRIP);
  const startingCents = longShotAllocationCents(status.control.startingBudgetCents, allocation?.startingCents);
  // Equity counts only what this strategy earned since it was last funded. Re-funding sets a new starting
  // amount, so carrying a prior period's losses across would report equity the operator never committed.
  const funding = longShotFunding(ledger.orders, mode, startingCents, settings, Date.parse(allocation?.fundedAt ?? '') || 0);
  if (funding.sizing.halted) return false;

  if (mode === 'live') {
    // Per-strategy arming, checked before the account-wide controls. Those say whether the desk is armed;
    // this says whether this strategy is, and conflating them is what put three unintended live orders on
    // the venue on 2026-08-15.
    if (!settings.liveEnabled) return false;
    if (liveBlockers().length || status.control.mode !== 'live' || status.control.state !== 'active') return false;
    if (getKalshiReconciliationStatus().phase !== 'ready') return false;
    if (evaluateLiveRisk(status.control, ledger.orders, process.env, LONG_SHOT_ROUND_TRIP).allowed === false) return false;
    if (countFilledLiveVenueOrders(ledger.orders, Date.now() - 3_600_000) >= maxLiveOrdersPerHour()) return false;
  }

  const dailyNetLossCents = longShotDailyNetLossCents(ledger.orders, mode);
  const open = openLongShotPositions(ledger.orders, mode);
  let changed = false;

  for (const prediction of dashboard.predictions) {
    const quote = prediction.kalshi;
    if (!quote?.live || !quote.ticker) continue;
    for (const side of ['UP', 'DOWN'] as const) {
      const ask = side === 'UP' ? quote.askUp : quote.askDown;
      const oppositeAsk = side === 'UP' ? quote.askDown : quote.askUp;
      if (!(ask > 0) || !(oppositeAsk > 0)) continue;

      const generation = ledger.orders.filter((order) => orderStrategyId(order) === LONG_SHOT_ROUND_TRIP
        && order.executionMode === mode && order.symbol === prediction.symbol
        && order.closesAt === quote.closesAt && !order.id.includes(':exit:')).length + 1;

      const decision = evaluateLongShotEntry({
        symbol: prediction.symbol, side, askPrice: ask,
        secondsRemaining: (Date.parse(quote.closesAt) - Date.now()) / 1000,
        openSameAssetWindow: open.filter((order) => order.symbol === prediction.symbol && order.closesAt === quote.closesAt).length,
        openSameSettlementWindow: open.filter((order) => order.closesAt === quote.closesAt).length,
        entriesThisAssetWindow: generation - 1,
        dailyNetLossCents,
      }, funding.sizing, settings);
      if (!decision.qualifies) continue;

      const fill = estimatePaperFill(funding.sizing.ticketCents, ask, 'kalshi');
      // The strategy's own headroom binds before any shared cash does; the shared budget is charged only
      // for live, where the cash is real.
      if (!fill || fill.stakeCents > funding.headroomCents) continue;

      const trail = trailing.get(`${quote.ticker}:${side}`);
      const order = buildLongShotOrder({
        mode, symbol: prediction.symbol, side, contractId: quote.ticker, closesAt: quote.closesAt,
        calculationAt: dashboard.generatedAt, entryAsk: ask, oppositeAsk,
        entryGeneration: generation, exitMarkCents: settings.exitMarkCents, settings,
        budgetEpochId: status.control.epochId, fill,
        firstTouchAskCents: trail?.firstTouchAskCents, trailingLooks: trail?.looks,
      });
      if (trail) {
        order.reason = `Trailed ${trail.looks} look(s) from ${trail.firstTouchAskCents.toFixed(1)}¢; bought at ${(ask * 100).toFixed(1)}¢ for ${trailingGainCents(trail, ask * 100).toFixed(2)}¢.`;
        // Cleared on the buy so a re-entry in the same window trails afresh rather than inheriting a
        // best price from a position that has already been taken.
        trailing.delete(`${quote.ticker}:${side}`);
      }
      order.entryCycleRegime = (await cycleRegimeFor(order.symbol, order.closesAt))?.regime;

      if (mode === 'paper') {
        // Taking a displayed ask is the entry, so a fill at that ask is the honest simulation. There is no
        // maker queue to model here, which is precisely why this policy does not reuse the maker mirror.
        Object.assign(order, {
          status: 'open', filledCount: fill.quantity, liquidityRole: 'taker',
          actualStakeCents: fill.stakeCents, actualPurchaseCents: fill.purchaseCents,
          actualFeeCents: fill.feeCents, authoritativeFillPrice: ask,
        } satisfies Partial<PaperOrder>);
        ledger.orders.push(order);
        changed = true;
        continue;
      }

      // Durable intent and reservation before submission, so a lost response leaves a record to reconcile
      // rather than an untracked venue order.
      ledger.orders.push(order);
      await writeLedger(ledger);
      await reserveTradingBudget(order.stakeCents, 'kalshi', order.id);
      changed = true;
      try {
        const live = await placeKalshiTakerBuy({
          ticker: order.contractId, positionSide: side,
          maximumPriceCents: settings.entryMarkCents, count: fill.quantity,
          clientOrderId: order.clientOrderId!,
          onAccepted: async (venueOrderId) => { order.venueOrderId = venueOrderId; await writeLedger(ledger); },
        });
        if (live.filledCount > 0) {
          Object.assign(order, {
            status: 'open', filledCount: live.filledCount, quantity: live.filledCount,
            liquidityRole: live.liquidityRole, authoritativeFillPrice: live.averagePriceCents / 100,
            actualPurchaseCents: live.filledCount * live.averagePriceCents,
            actualFeeCents: live.feeCents,
            actualStakeCents: live.filledCount * live.averagePriceCents + live.feeCents,
            potentialPayoutCents: Math.round(live.filledCount * 100),
          } satisfies Partial<PaperOrder>);
        } else {
          order.status = 'unfilled';
          order.noFillReason = 'ioc_no_fill';
          await releaseTradingBudget(order.stakeCents, 'kalshi', order.id);
        }
      } catch (error) {
        // A definitively refused cap is a clean no-op. Anything else is ambiguous: retain the reservation,
        // mark uncertain, and let authoritative reconciliation decide what actually happened.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Taker not submitted')) {
          order.status = 'unfilled';
          order.noFillReason = 'ioc_no_fill';
          await releaseTradingBudget(order.stakeCents, 'kalshi', order.id);
        } else {
          order.status = 'uncertain';
          order.reason = `Long-shot entry outcome is uncertain: ${message}`;
          automaticReconciliationRequested = true;
          await suspendTrading(`Long-shot entry outcome uncertain for ${order.id}.`);
        }
      }
      await writeLedger(ledger);
      return changed;
    }
  }
  return changed;
}

/**
 * One pass of the long-shot exit poll. Sells at the mark, never below it.
 *
 * Kalshi refuses `reduce_only` with `good_till_canceled`, so this cannot be a resting order (SPEC decision
 * 2026-08-15). The submitted limit is the mark rather than the observed bid, so a quote that retreats
 * between observation and submission produces no fill instead of a worse one.
 */
type OwnedSideBid = (order: PaperOrder) => number | undefined;

/** Owned-side bid from the 15-second dashboard snapshot: bid(side) = 100 - ask(other side). */
const dashboardBid = (dashboard: DashboardData): OwnedSideBid => (order) => {
  const quote = dashboard.predictions.find((item) => item.kalshi?.ticker === order.contractId)?.kalshi;
  if (!quote?.live) return undefined;
  return (1 - (order.side === 'UP' ? quote.askDown : quote.askUp)) * 100;
};

async function runLongShotExits(bidFor: OwnedSideBid, ledger: Ledger): Promise<boolean> {
  const settings = longShotSettings();
  if (!settings.enabled) return false;
  const draining = getExecutionDrainStatus().phase === 'draining';
  let changed = false;

  for (const mode of ['paper', 'live'] as const) {
    for (const order of openLongShotPositions(ledger.orders, mode)) {
      const bidCents = bidFor(order);
      if (bidCents === undefined || !Number.isFinite(bidCents)) continue;
      const peak = observePeakBid(order.peakOwnedSideBidCents, bidCents);
      if (peak !== order.peakOwnedSideBidCents) { order.peakOwnedSideBidCents = peak; changed = true; }

      const decision = evaluateTargetExit(targetExitPosition(order), {
        exitMarkCents: order.exitTargetCents ?? settings.exitMarkCents,
        ownedSideBidCents: bidCents, nowMs: Date.now(), draining,
      });
      if (decision.action !== 'sell') continue;

      if (mode === 'paper') {
        const feeCents = venueFeeCents('kalshi', decision.limitPriceCents, decision.count);
        const settlement = targetExitSettlement({
          filledCount: decision.count, averagePriceCents: decision.limitPriceCents, feeCents,
          entryQuantity: order.quantity, entryStakeCents: order.actualStakeCents ?? order.stakeCents,
        });
        Object.assign(order, {
          status: 'sold', exitPrice: decision.limitPriceCents / 100, exitFeeCents: feeCents,
          saleProceedsCents: settlement.proceedsCents, payoutCents: settlement.proceedsCents,
          actualPnlCents: settlement.realizedPnlCents,
          pnlCents: Math.floor(settlement.proceedsCents) - order.stakeCents,
          settledAt: new Date().toISOString(),
          reason: `Long-shot exit filled at the ${decision.limitPriceCents}¢ mark.`,
        } satisfies Partial<PaperOrder>);
        changed = true;
        continue;
      }

      order.exitPending = true;
      order.exitClientOrderId = `exit-${order.id}`;
      order.exitRequestedAt = new Date().toISOString();
      await writeLedger(ledger);
      try {
        const exit = await placeKalshiSell({
          ticker: order.contractId, positionSide: order.side,
          minimumPriceCents: decision.limitPriceCents, count: decision.count,
          clientOrderId: order.exitClientOrderId,
          onAccepted: async (venueOrderId) => { order.exitVenueOrderId = venueOrderId; await writeLedger(ledger); },
        });
        order.exitPending = false;
        if (exit.filledCount <= 0) continue;
        const settlement = targetExitSettlement({
          filledCount: exit.filledCount, averagePriceCents: exit.averagePriceCents, feeCents: exit.feeCents,
          entryQuantity: order.quantity, entryStakeCents: order.actualStakeCents ?? order.stakeCents,
        });
        // A partial fill is an ordinary outcome: the remainder keeps its own basis and stays open.
        if (settlement.remainingQuantity > 0) {
          order.quantity = settlement.remainingQuantity;
          order.filledCount = settlement.remainingQuantity;
          order.potentialPayoutCents = Math.round(settlement.remainingQuantity * 100);
          order.actualStakeCents = (order.actualStakeCents ?? order.stakeCents) - settlement.costBasisCents;
        } else {
          Object.assign(order, {
            status: 'sold', exitPrice: exit.averagePriceCents / 100, exitFeeCents: exit.feeCents,
            saleProceedsCents: settlement.proceedsCents, payoutCents: settlement.proceedsCents,
            actualPnlCents: settlement.realizedPnlCents,
            pnlCents: Math.floor(settlement.proceedsCents) - order.stakeCents,
            settledAt: new Date().toISOString(),
          } satisfies Partial<PaperOrder>);
        }
        await settleTradingBudget(order.stakeCents, Math.max(0, Math.floor(settlement.proceedsCents)), 'kalshi', `${order.id}:long-shot-exit`);
        changed = true;
      } catch (error) {
        order.exitPending = false;
        order.status = 'uncertain';
        order.reason = `Long-shot exit outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`;
        automaticReconciliationRequested = true;
        await suspendTrading(`Long-shot exit outcome uncertain for ${order.id}.`);
        changed = true;
      }
      await writeLedger(ledger);
    }
  }
  return changed;
}

let longShotPollTimer: NodeJS.Timeout | undefined;
let longShotPollRunning = false;
let longShotEntryTimer: NodeJS.Timeout | undefined;
let longShotEntryRunning = false;
let latestDashboard: DashboardData | undefined;

/**
 * Fresh both-sides quote for one contract, through the shared cache.
 *
 * One request rather than the two a managed-maker quote costs: the entry trigger reads only the asks and
 * has no use for a twenty-level book. `maxAgeMs` is the entry cadence, so a value fetched for the exit
 * poller or the cycle in the same second is reused instead of refetched.
 */
async function longShotEntryQuote(ticker: string, maxAgeMs = LONG_SHOT_ENTRY_POLL_MS): Promise<{ askUp: number; askDown: number } | undefined> {
  const quote = await cachedKalshiRead(`quote:${ticker}`, () => fetchKalshiQuote(ticker), { maxAgeMs });
  // ask(DOWN) = 1 - bid(UP) on Kalshi's shared book.
  return quote ? { askUp: quote.yesAsk, askDown: 1 - quote.yesBid } : undefined;
}

/**
 * One-second entry pass.
 *
 * The fifteen-second collector cycle reads quotes that are themselves on a fifteen-second cadence, so a
 * side that dips to the mark between two samples is invisible to it. Measured on 586 recorded episodes,
 * 87% persist beyond one sample and half beyond ninety seconds, so this is not expected to change the
 * entry count much on its own — the entry-window gate excludes 98% of cheap sides regardless. It earns its
 * place by removing duplicate fetching and by making a wider entry window affordable.
 *
 * Skipped entirely when no window is inside the entry gate, so the quiet majority of a cycle costs nothing.
 */
async function longShotEntryTick(): Promise<void> {
  if (longShotEntryRunning) return;
  longShotEntryRunning = true;
  try {
    const settings = longShotSettings();
    if (!settings.enabled) return;
    const dashboard = latestDashboard;
    if (!dashboard || getExecutionDrainStatus().phase === 'draining') return;

    // Only windows that could still qualify are worth a quote at all.
    const eligible = (dashboard.predictions ?? []).filter((prediction) => {
      const quote = prediction.kalshi;
      if (!quote?.live || !quote.ticker) return false;
      const remaining = (Date.parse(quote.closesAt) - Date.now()) / 1000;
      return remaining >= settings.minimumSecondsRemaining;
    });
    if (!eligible.length) return;

    // Quotes are refreshed outside the write queue; only the ledger mutation is queued, matching the exit
    // poller and the 2026-08-14 decision that upstream waits must not sit inside the queue they serve.
    // A contract already being trailed is read at the trailing cadence; the rest at the ordinary one.
    const anyTrailing = trailing.size > 0;
    const refreshed = new Map<string, { askUp: number; askDown: number }>();
    await Promise.all(eligible.map(async (prediction) => {
      const ticker = prediction.kalshi!.ticker;
      const watched = [...trailing.keys()].some((key) => key.startsWith(`${ticker}:`));
      const quote = await longShotEntryQuote(ticker, watched ? TRAILING_QUOTE_MAX_AGE_MS : LONG_SHOT_ENTRY_POLL_MS);
      if (quote) refreshed.set(ticker, quote);
    }));
    if (!refreshed.size) return;

    // Trailing decides which of the qualifying sides may be bought this look. A side still getting
    // cheaper is held back: a continuing fall is a trend, and this strategy needs a reversal.
    const settingsNow = settings;
    const buyable = new Set<string>();
    for (const prediction of eligible) {
      const ticker = prediction.kalshi!.ticker;
      const quote = refreshed.get(ticker);
      if (!quote) continue;
      for (const side of ['UP', 'DOWN'] as const) {
        const askCents = (side === 'UP' ? quote.askUp : quote.askDown) * 100;
        const key = `${ticker}:${side}`;
        const closed = Date.parse(prediction.kalshi!.closesAt);
        const remaining = (closed - Date.now()) / 1000;
        // Outside the window the candidate is gone; drop any trail rather than carrying it into a
        // window it can no longer be bought in.
        if (remaining < settingsNow.minimumSecondsRemaining) { trailing.delete(key); continue; }
        if (!(askCents > 0) || askCents > settingsNow.entryMarkCents) { trailing.delete(key); continue; }

        const existing = trailing.get(key);
        if (!existing) { trailing.set(key, beginTrailingEntry(askCents, Date.now())); continue; }
        const decision = evaluateTrailingEntry(existing, askCents, { entryMarkCents: settingsNow.entryMarkCents });
        if (decision.action === 'buy') buyable.add(key);
        else if (decision.action === 'abandon') trailing.delete(key);
        else trailing.set(key, observeTrailingEntry(existing, askCents, Date.now()));
      }
    }
    if (!buyable.size) return;

    const priced: DashboardData = {
      ...dashboard,
      predictions: eligible
        .filter((prediction) => (['UP', 'DOWN'] as const).some((side) => buyable.has(`${prediction.kalshi!.ticker}:${side}`)))
        .map((prediction) => {
          const quote = refreshed.get(prediction.kalshi!.ticker);
          return quote ? { ...prediction, kalshi: { ...prediction.kalshi!, ...quote } } : prediction;
        }),
      // The entry rule requires a fresh calculation; these quotes were fetched a moment ago.
      generatedAt: new Date().toISOString(),
    };

    const status = await getTradingControl();
    const operation = engineQueue.then(async () => {
      const ledger = await readLedger();
      let changed = await runLongShot(priced, status, ledger, 'paper');
      changed = await runLongShot(priced, status, ledger, 'live') || changed;
      if (changed) await writeLedger(ledger);
    });
    engineQueue = operation.then(() => undefined, () => undefined);
    await operation;
  } catch (error) {
    console.error('Long-shot entry poll failed:', error);
  } finally {
    longShotEntryRunning = false;
    // A trail that started or ended this tick changes the cadence the next one should run at.
    startLongShotEntryPoller();
  }
}

/**
 * Runs at one second while nothing is being trailed and at the trailing cadence once something is.
 *
 * Rescheduled rather than always fast: watching four times a second costs four times the requests, and
 * only a contract that has actually reached the mark is worth that. A trail is usually seconds long,
 * so the fast cadence is rare and brief.
 */
let longShotEntryIntervalMs = LONG_SHOT_ENTRY_POLL_MS;
function startLongShotEntryPoller(): void {
  if (!longShotSettings().enabled) return;
  const wanted = trailing.size > 0 ? TRAILING_ENTRY_POLL_MS : LONG_SHOT_ENTRY_POLL_MS;
  if (longShotEntryTimer && longShotEntryIntervalMs === wanted) return;
  if (longShotEntryTimer) clearInterval(longShotEntryTimer);
  longShotEntryIntervalMs = wanted;
  longShotEntryTimer = setInterval(() => { void longShotEntryTick(); }, wanted);
  longShotEntryTimer.unref?.();
}

/**
 * One-second exit poll for open long-shot positions.
 *
 * The fifteen-second collector cycle is too slow for this strategy: the whole premise is transient
 * excursions, and a round trip inside ninety seconds would be sampled six times rather than ninety.
 * A resting order would have removed the need to watch at all, but Kalshi refuses `reduce_only` with
 * `good_till_canceled` (SPEC decision 2026-08-15), so the watching has to be ours.
 *
 * Two properties keep this from destabilising the engine:
 *
 * - **Quotes are fetched outside the write queue.** Only the ledger mutation is queued, following the
 *   2026-08-14 decision that upstream waits must not sit inside the queue they serve — a slow venue read
 *   would otherwise delay every fifteen-second calculation behind it.
 * - **A tick never queues behind itself.** If a pass is still running the next one is dropped rather than
 *   accumulating, so a slow venue produces fewer polls instead of an unbounded backlog.
 */
async function longShotExitTick(): Promise<void> {
  if (longShotPollRunning) return;
  longShotPollRunning = true;
  try {
    if (getExecutionDrainStatus().phase === 'draining') return;
    const ledger = await readLedger();
    const open = [...openLongShotPositions(ledger.orders, 'paper'), ...openLongShotPositions(ledger.orders, 'live')];
    if (!open.length) return;

    // One read per distinct contract and side, not per position: paper and live hold the same contract.
    const wanted = new Map(open.map((order) => [`${order.contractId}:${order.side}`, order]));
    const bids = new Map<string, number>();
    await Promise.all([...wanted].map(async ([key, order]) => {
      try {
        // One request, sharing the entry pass's cache key. The exit compares a bid against the mark, and
        // the owned-side bid is derived from the two YES prices — a managed-maker quote also fetches a
        // twenty-level book, which this has no use for and which would double the cost of every tick.
        const quote = await cachedKalshiRead(`quote:${order.contractId}`,
          () => fetchKalshiQuote(order.contractId), { maxAgeMs: TARGET_EXIT_POLL_MS });
        // Through the shared helper rather than re-derived here, so both sides stay on one tested rule.
        if (quote) bids.set(key, selectedManagedMakerQuote({ ...quote, side: order.side }).bid * 100);
      } catch {
        // A transient quote failure is not a reason to sell or to stop; the next tick retries.
      }
    }));
    if (!bids.size) return;

    const operation = engineQueue.then(async () => {
      const current = await readLedger();
      if (await runLongShotExits((order) => bids.get(`${order.contractId}:${order.side}`), current)) {
        await writeLedger(current);
      }
    });
    engineQueue = operation.then(() => undefined, () => undefined);
    await operation;
  } catch (error) {
    console.error('Long-shot exit poll failed:', error);
  } finally {
    longShotPollRunning = false;
  }
}

/** Started lazily from the collector cycle, so it exists exactly where the collector does. */
function startLongShotExitPoller(): void {
  if (longShotPollTimer || !longShotSettings().enabled) return;
  longShotPollTimer = setInterval(() => { void longShotExitTick(); }, TARGET_EXIT_POLL_MS);
  // Never hold the process open on its own account.
  longShotPollTimer.unref?.();
}

export function processPaperTradingCycle(dashboard: DashboardData): Promise<void> {
  // The entry pass needs contract identities and the clock, not prices: it refreshes those itself.
  latestDashboard = dashboard;
  startLongShotExitPoller();
  startLongShotEntryPoller();
  const operation = engineQueue.then(() => processCycle(dashboard));
  engineQueue = operation.then(() => undefined, () => undefined);
  return operation.then(async () => {
    if (!automaticReconciliationRequested) return;
    automaticReconciliationRequested = false;
    await reconcileLiveExecution({ trigger: 'automatic' });
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
  const barrier = engineQueue.then(() => undefined);
  engineQueue = barrier.then(() => undefined, () => undefined);
  try {
    await barrier;
    const beforeReconciliation = getExecutionDrainStatus();
    if (beforeReconciliation.workingTransactions > 0) throw new Error(`${beforeReconciliation.workingTransactions} live transaction(s) remained after the execution queue drained.`);
    const reconciliation = await reconcileLiveExecution({ trigger: 'manual' });
    if (reconciliation.phase !== 'ready') throw new Error(`Authoritative drain reconciliation blocked: ${reconciliation.reason}`);
    const ledger = await readLedger();
    const unresolved = ledger.orders.filter((order) => order.executionMode === 'live'
      && (order.status === 'pending_reservation' || order.status === 'uncertain' || order.exitPending));
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

/** Authoritative startup/manual barrier. Live orders remain blocked until this returns ready. */
export function reconcileLiveExecution(options: { trigger?: 'startup' | 'manual' | 'automatic' | 'periodic'; pauseOnFailure?: boolean } = {}): Promise<KalshiReconciliationStatus> {
  return serializedReconciliation(async () => {
    const trigger = options.trigger ?? 'manual';
    const startedAt = new Date().toISOString();
    const previousStatus = getKalshiReconciliationStatus();
    setKalshiReconciliationStatus({ ...previousStatus, phase: 'running', trigger, startedAt, completedAt: undefined, reason: `Running ${trigger} Kalshi reconciliation.` });
    const operation = engineQueue.then(async () => {
      try {
        const ledger = await readLedger();
        const trackedIds = ledger.orders.flatMap((order) => [order.venueOrderId, order.exitVenueOrderId]).filter((id): id is string => Boolean(id));
        const retryDelaysMs = [0, 2_000, 5_000, 10_000, 15_000];
        let snapshot: Awaited<ReturnType<typeof fetchKalshiReconciliationSnapshot>> | undefined;
        let result: ReturnType<typeof reconcileExecutionLedger> | undefined;
        for (const delayMs of retryDelaysMs) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          snapshot = await fetchKalshiReconciliationSnapshot(trackedIds);
          result = reconcileExecutionLedger(ledger.orders, snapshot);
          if (!result.issues.length) break;
          const onlyPropagationDelay = result.retryableIssues.length > 0 && result.retryableIssues.length === result.issues.length;
          if (!onlyPropagationDelay) throw new Error(result.issues.join(' '));
        }
        if (!snapshot || !result) throw new Error('Kalshi reconciliation did not produce an authoritative snapshot.');
        if (result.issues.length) throw new Error(result.issues.join(' '));
        const previousEntryStatus = new Map(ledger.orders.map((order) => [order.id, order.status]));
        ledger.orders = result.orders;
        for (const recovered of ledger.orders.filter((order) => order.executionMode === 'live' && order.status === 'open'
          && previousEntryStatus.get(order.id) !== 'open')) attachMatchedLiveFillShadow(ledger.orders, recovered);
        await writeLedger(ledger);
        // Recovered exits use the same deterministic settlement ids as normal execution. Calls are
        // idempotent against the control audit, including a crash between ledger and budget writes.
        for (const settlement of result.settlements) {
          if (settlement.stakeCents > 0) await settleTradingBudget(settlement.stakeCents, settlement.payoutCents, 'kalshi', settlement.relatedId);
        }
        await reconcileTradingBudget({
          targetReservedCents: result.targetReservedCents, venueBalanceCents: snapshot.balanceCents,
          reason: `Kalshi ${trigger} reconciliation passed: ${result.targetReservedCents}c reserved, ${result.recoveredFills} fill state(s) recovered, ${snapshot.restingOrdersCanceled} managed remainder(s) canceled.`,
          auditUnchanged: trigger !== 'periodic' || result.recoveredFills > 0 || snapshot.restingOrdersCanceled > 0,
        });
        const status: KalshiReconciliationStatus = {
          ...previousStatus, phase: 'ready', trigger, startedAt, completedAt: new Date().toISOString(),
          reason: `Kalshi ${trigger} reconciliation passed; balances, positions, orders, fills, IDs, resting orders, and local reservations agree.`,
          venueBalanceCents: snapshot.balanceCents,
          localOpenPositions: result.orders.filter((order) => order.executionMode === 'live' && order.status === 'open').length,
          venueManagedPositions: result.venueManagedPositions,
          restingOrdersCanceled: snapshot.restingOrdersCanceled, recoveredFills: result.recoveredFills,
        };
        setKalshiReconciliationStatus(status);
        await autoResumeTradingAfterReconciliation().catch((error) => console.error('Guarded auto-resume check failed:', error));
        return status;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Kalshi reconciliation failure';
        if (options.pauseOnFailure !== false) await recordTradingReconciliationFailure(reason).catch((auditError) => console.error('Unable to persist reconciliation failure:', auditError));
        const status: KalshiReconciliationStatus = { ...previousStatus, phase: 'blocked', trigger, startedAt, completedAt: new Date().toISOString(), reason };
        setKalshiReconciliationStatus(status);
        return status;
      }
    });
    engineQueue = operation.then(() => undefined, () => undefined);
    return operation;
  });
}

/**
 * Restores the shadow bankroll so paper measurement can continue after a drawdown wipes it out.
 * Order history is deliberately preserved; only the spending account is reset, and the reset is
 * counted so a restored bankroll is never mistaken for an unbroken run.
 */
export function resetPaperBudget(bankrollCents: number): Promise<ExecutionSummary> {
  const operation = engineQueue.then(async () => {
    if (!Number.isSafeInteger(bankrollCents) || bankrollCents <= 0) throw new Error('Paper bankroll must be a positive dollar amount.');
    if (bankrollCents > MAX_PAPER_BANKROLL_CENTS) throw new Error('Paper bankroll is capped at $10,000.');
    const ledger = await readLedger();
    if (ledger.orders.some((order) => order.executionMode === 'paper' && (order.status === 'open' || order.status === 'pending_reservation'))) {
      throw new Error('Wait for open paper positions to settle before resetting the bankroll.');
    }
    ledger.paperBudget = {
      startingCents: bankrollCents, availableCents: bankrollCents, realizedPnlCents: 0,
      resets: (ledger.paperBudget.resets ?? 0) + 1, startedAt: new Date().toISOString(),
    };
    await writeLedger(ledger);
    // A freshly reset bankroll has nothing reserved, so the next stake is sized off the full amount.
    return summarize(ledger.orders, 'paper', true, bankrollCents, {
      startingCents: bankrollCents, availableCents: bankrollCents, reservedCents: 0,
      proposedStakeCents: Math.min(Math.floor(bankrollCents / 100), maximumPaperStakeCents(), bankrollCents),
    }, ledger.paperBudget);
  });
  engineQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

interface LedgerFigures { startingCents: number; availableCents: number; reservedCents: number; proposedStakeCents: number }

function inferredNoFillReason(order: PaperOrder): PaperOrder['noFillReason'] {
  if (order.noFillReason) return order.noFillReason;
  const reason = order.reason?.toLowerCase() ?? '';
  if (order.status === 'unfilled' && reason.includes('post-only') && (reason.includes('cross') || reason.includes('acknowledgement race'))) return 'post_only_race';
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
    const history = attempts.map((attempt, index) => ({
      id: attempt.id, attemptNumber: attempt.attemptNumber ?? index + 1, status: attempt.status,
      noFillReason: inferredNoFillReason(attempt), filledCount: attempt.filledCount, createdAt: attempt.createdAt,
    }));
    const recoveredAfterRetry = history.length > 1
      && history.slice(0, -1).some((attempt) => attempt.status === 'unfilled')
      && ((latest.filledCount ?? 0) > 0 || latest.status === 'open' || latest.status === 'won' || latest.status === 'lost');
    return { ...latest, noFillReason: inferredNoFillReason(latest), attemptHistory: history, recoveredAfterRetry };
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function summarize(orders: PaperOrder[], mode: ExecutionMode, running: boolean, equityCents: number, figures: LedgerFigures, budget?: PaperBudget, strategyId: StrategyId = EDGE_BINARY_BUY): ExecutionSummary {
  // Scoped by strategy as well as mode. The two strategies share one ledger because reconciliation is an
  // account-wide concern and a split file would leave real resting orders unmatched, so every money figure
  // read out of it has to re-narrow.
  const mine = orders.filter((order) => order.executionMode === mode && orderStrategyId(order) === strategyId);
  const settled = mine.filter((order) => order.status === 'won' || order.status === 'lost' || order.status === 'invalid' || order.status === 'sold');
  const openOrders = mine.filter((order) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain').length;
  return {
    mode, running,
    depleted: equityCents <= 0 && openOrders === 0,
    startingCents: figures.startingCents,
    availableCents: figures.availableCents,
    reservedCents: figures.reservedCents,
    proposedStakeCents: figures.proposedStakeCents,
    bankrollResets: budget?.resets,
    openOrders,
    settledOrders: settled.length,
    wins: mine.filter((order) => order.status === 'won').length,
    losses: mine.filter((order) => order.status === 'lost').length,
    realizedPnlCents: settled.reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0),
    equityCents,
    recentOrders: groupedRecentOrders(mine).slice(0, 30),
  };
}

/** Raw order ledger for reporting. */
export async function getExecutionOrders(): Promise<PaperOrder[]> {
  return (await readLedger()).orders;
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
    realizedPnlCents: settledOrders.reduce((total, order) => total + (order.actualPnlCents ?? order.pnlCents ?? 0), 0),
    bankrollResets: ledger.paperBudget.resets ?? 0,
    recentExecutions: groupedRecentOrders(orders).slice(0, 30).map(publicPaperExecution),
  };
}

export async function syncCurrentPublicPaperBudgetProjection(): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  await syncPublicPaperBudgetToPostgres(publicPaperBudgetFromLedger(await readLedger()));
}

export async function getPublicPaperBudget(): Promise<PublicPaperBudget> {
  // A hosted dashboard reads the replicated projection; it never opens a local ledger.
  if (isStatelessDeployment()) {
    const replicated = await readPublicPaperBudgetFromPostgres();
    if (replicated) return replicated;
    return {
      durable: false, startingCents: 0, availableCents: 0, equityCents: 0, reservedCents: 0,
      proposedStakeCents: 0, running: false, depleted: false, openOrders: 0, settledOrders: 0,
      realizedPnlCents: 0, bankrollResets: 0, recentExecutions: [],
    };
  }
  return publicPaperBudgetFromLedger(await readLedger());
}

export async function getExecutionSummaries(control: { state: string; mode: string; startingBudgetCents: number; workingEquityCents: number; availableBudgetCents: number; reservedBudgetCents: number; proposedStakeCents: number; perTradeCents: number }): Promise<{ paper: ExecutionSummary; live: ExecutionSummary; executionSignals: ExecutionSignalReadiness[]; liveAvailable: boolean; liveBlockers: string[]; maximumLiveMakerAttempts: number; portfolioConstraints: Pick<PortfolioConstraints, 'maximumPositions' | 'maximumSameWindow' | 'maximumSameGroupPerWindow'>; regimeGate: RegimeGateStatus }> {
  const [ledger, regimeGate] = await Promise.all([readLedger(), getRegimeGateStatus()]);
  const now = Date.now();
  const openPaper = ledger.orders.filter((order) => order.executionMode === 'paper' && (order.status === 'open' || order.status === 'pending_reservation')).reduce((sum, order) => sum + order.stakeCents, 0);
  const paperAvailable = ledger.paperBudget.availableCents;
  // Paper has separate cash but uses the same explicit all-in purchase size for comparable shadow fills.
  const paperStake = Math.max(0, Math.min(control.perTradeCents, maximumPaperStakeCents(), paperAvailable));
  return {
    paper: summarize(ledger.orders, 'paper', paperAvailable > 0, paperAvailable + openPaper, {
      startingCents: ledger.paperBudget.startingCents, availableCents: paperAvailable,
      reservedCents: openPaper, proposedStakeCents: paperStake,
    }, ledger.paperBudget),
    live: {
      ...summarize(ledger.orders, 'live', control.state === 'active' && control.mode === 'live' && liveTradingEnabled(), control.workingEquityCents, {
        startingCents: control.startingBudgetCents,
        availableCents: control.availableBudgetCents, reservedCents: control.reservedBudgetCents,
        proposedStakeCents: Math.min(control.proposedStakeCents, maxLiveStakeCents()),
      }),
      blockedReason: ledger.lastLiveSkip?.reason,
    },
    executionSignals: Object.values(ledger.signalPersistence)
      .filter((state) => Date.parse(state.closesAt) > now)
      .map((state) => {
        const result = evaluateSignalPersistence(state, now, MIN_NET_EDGE, MIN_ESTIMATE_QUALITY);
        const windowOrders = ledger.orders.filter((order) => order.executionMode === 'live' && order.symbol === state.symbol
          && order.side === state.side && order.closesAt === state.closesAt && !order.id.includes(':exit:'))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const latestSold = windowOrders.filter((order) => order.status === 'sold' && order.settledAt).at(-1);
        const currentOrders = latestSold ? windowOrders.filter((order) => Date.parse(order.createdAt) > Date.parse(latestSold.settledAt!)) : windowOrders;
        const logicalId = currentOrders.at(-1)?.logicalOrderId;
        const attempts = logicalId ? entryAttemptsForLogicalOrder(ledger.orders, logicalId) : [];
        const liveOrder = attempts.at(-1);
        const retry = makerRetryDecision(attempts, now, state.closesAt, maximumLiveMakerAttempts());
        return {
          symbol: state.symbol, side: state.side, closesAt: state.closesAt, eligible: result.eligible,
          reason: result.reason, qualifyingSnapshots: result.qualifyingSnapshots, medianNetEdge: result.medianNetEdge,
          portfolio: ledger.portfolioDecisions[`${state.symbol}:${state.side}:${state.closesAt}`],
          liveAttempt: liveOrder ? {
            status: liveOrder.status, createdAt: liveOrder.createdAt, filledCount: liveOrder.filledCount,
            quantity: liveOrder.quantity, reason: liveOrder.reason, noFillReason: inferredNoFillReason(liveOrder),
            attemptNumber: liveOrder.attemptNumber ?? attempts.length, maximumAttempts: maximumLiveMakerAttempts(),
            retryEligible: retry.allowed && attempts.length > 0,
          } : undefined,
        };
      }),
    liveAvailable: liveTradingEnabled(),
    liveBlockers: liveBlockers(),
    maximumLiveMakerAttempts: maximumLiveMakerAttempts(),
    regimeGate,
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
