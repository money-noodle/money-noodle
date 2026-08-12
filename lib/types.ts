export type Direction = 'bullish' | 'bearish' | 'neutral';
export type PositionSide = 'UP' | 'DOWN';
export type Signal = PositionSide | 'WATCH' | 'PASS';

export interface ChartPoint {
  time: number;
  price: number;
}

export interface Factor {
  id: string;
  label: string;
  eyebrow: string;
  direction: Direction;
  score: number;
  weight: number;
  contribution: number;
  confidence: number;
  summary: string;
  detail: string;
  source: string;
  available: boolean;
}

export type TradingVenue = 'polymarket' | 'kalshi';
export type TradingProviderId = TradingVenue | 'crypto-com' | 'forecastex' | 'robinhood';
export type TradingProviderImplementation = 'planned' | 'read-paper' | 'live';

export interface TradingProviderVariant {
  id: string;
  providerId: TradingProviderId;
  name: string;
  status: 'planned' | 'active' | 'superseded';
  forecastModelVersion: string;
  description: string;
}

export interface TradingProviderControl {
  providerId: TradingProviderId;
  researchEnabled: boolean;
  paperEnabled: boolean;
  liveEnabled: boolean;
  selectedVariantId: string;
  updatedAt: string;
}

export interface TradingProviderAuditEvent {
  id: string;
  at: string;
  providerId: TradingProviderId;
  action: 'migrated' | 'updated';
  reason: string;
  previous: Pick<TradingProviderControl, 'researchEnabled' | 'paperEnabled' | 'liveEnabled' | 'selectedVariantId'>;
  next: Pick<TradingProviderControl, 'researchEnabled' | 'paperEnabled' | 'liveEnabled' | 'selectedVariantId'>;
}

export interface TradingProviderConfiguration {
  version: 'trading-provider-config-v1';
  revision: number;
  updatedAt: string;
  executionAuthority: 'legacy-budget-v1' | 'provider-registry-v1';
  providers: TradingProviderControl[];
  audit: TradingProviderAuditEvent[];
}

export interface TradingProviderDescriptor {
  id: TradingProviderId;
  name: string;
  implementation: TradingProviderImplementation;
  adapterVersion: string;
  capabilities: { marketData: boolean; paper: boolean; live: boolean };
  researchEnabled: boolean;
  paperEnabled: boolean;
  liveEnabled: boolean;
  selectedVariantId: string;
  configurationUpdatedAt: string;
  readiness: string;
  variants: TradingProviderVariant[];
}

export type PolicyComponentKind = 'forecast' | 'buy' | 'execution' | 'exit' | 'switch' | 'regime' | 'provider';
export interface PolicyManifestComponent {
  kind: PolicyComponentKind;
  label: string;
  version: string;
  status: 'production' | 'paper' | 'observation';
  summary: string;
  details: Array<{ label: string; value: string }>;
}
export interface PolicyManifestHistoryEntry {
  version: string;
  activatedAt: string;
  deactivatedAt?: string;
  status: 'active' | 'superseded' | 'rolled-back';
  summary: string;
  changes: string[];
  evidence: string[];
}
export interface PolicyManifest {
  version: 'policy-manifest-v1';
  generatedAt: string;
  activeBuyPolicyVersion: string;
  activeBuyPolicyActivatedAt: string;
  components: PolicyManifestComponent[];
  history: PolicyManifestHistoryEntry[];
}

export type ContractComparability = 'exact' | 'approximate' | 'not-comparable';

/** Immutable venue contract/rules record; full rules live once in the provenance registry. */
export interface ContractProvenanceRecord {
  version: 'contract-provenance-v1';
  registryId: string;
  venue: TradingVenue;
  contractId: string;
  marketUrl: string;
  closesAt: string;
  capturedAt: string;
  rulesSource: string;
  rulesFingerprint: string;
  rulesText: string;
  referenceSource?: string;
  referenceValue?: number;
  settlementWindowSeconds?: number;
  comparability: ContractComparability;
}

export type ContractProvenanceRef = Omit<ContractProvenanceRecord, 'rulesText'>;

export interface VenueOutcomeRecord {
  venue: TradingVenue;
  contractId: string;
  outcome?: 'UP' | 'DOWN';
  invalidReason?: string;
  resolutionSource: string;
  resolvedAt: string;
}

export interface MarketQuote {
  probabilityUp: number;
  probabilityDown: number;
  liquidity: number;
  volume: number;
  bidUp?: number;
  askUp?: number;
  bidDown?: number;
  askDown?: number;
  url: string;
  closesAt: string;
  live: boolean;
  contract?: ContractProvenanceRecord;
}

export interface VenueQuote {
  venue: 'kalshi';
  probabilityUp: number;
  bidUp: number;
  askUp: number;
  bidDown: number;
  askDown: number;
  liquidity: number;
  volume: number;
  url: string;
  closesAt: string;
  ticker: string;
  live: boolean;
  comparability: ContractComparability;
  floorStrike?: number;
  contract?: ContractProvenanceRecord;
}

export interface ContractBasis {
  referencePrice: number;
  currentPrice: number;
  referenceSource: string;
  basisPercent: number;
  secondsRemaining: number;
  volatilityPerSecond: number;
  volatilitySamples: number;
  standardDeviationPercent: number;
  zScore: number;
  probabilityUp: number;
  /** Volatility the venue price implies, given the same basis and clock. */
  impliedVolatilityPerSecond?: number;
  /** Our volatility divided by the market's. Above 1 means we expect a bigger move than the market,
   *  which is the only legitimate source of edge once basis and time are common knowledge. */
  volatilityRatio?: number;
}

export type CycleRegimeLabel = 'insufficient' | 'trending' | 'mean-reverting' | 'mixed';

/** Observation-only path diagnostics. These fields must not affect production probability or gates. */
export interface CycleRegimeFeatures {
  observedAt: string;
  observationCount: number;
  coverageSeconds: number;
  signFlipRate: number | null;
  lagOneAutocorrelation: number | null;
  trendEfficiency: number | null;
  rangePercent: number | null;
  localVolatilityPerSecond: number | null;
  localVolatility15mPercent: number | null;
  regime: CycleRegimeLabel;
}

export interface CyclePathPoint { at: string; offsetSeconds: number; price: number; basisPercent: number }
export interface CyclePathRecord {
  id: string;
  symbol: string;
  cycleStartedAt: string;
  closesAt: string;
  referencePrice: number;
  points: CyclePathPoint[];
  features: CycleRegimeFeatures;
}
export interface CyclePathReport {
  policyVersion: string;
  totalCycles: number;
  completedCycles: number;
  totalPoints: number;
  latestByAsset: Array<{ symbol: string; closesAt: string; features: CycleRegimeFeatures }>;
}

export interface SettlementAverageEstimate {
  probabilityUp: number;
  expectedAveragePrice: number;
  standardDeviationPercent: number;
  effectiveVarianceSeconds: number;
  observedSettlementSeconds: number;
  method: 'future-window' | 'partially-observed-window';
}

export interface MakerFillEstimate {
  probability: number;
  horizonSeconds: number;
  quoteDistance: number;
  quoteVolatilityPerSecond: number;
  samples: number;
  model: 'quote-first-passage-v1';
}

export interface CalibrationReplaySnapshot {
  version: 'calibration-replay-v1';
  source: 'issuance-exact' | 'historical-reconstruction';
  basisInput?: {
    referencePrice: number;
    currentPrice: number;
    secondsRemaining: number;
    volatilityPerSecond: number;
    volatilitySamples: number;
  };
  baselineBasisProbability?: number;
  basisLogOddsWeight: number;
  slowTiltLogOdds: number;
  slowTerms: Array<{ id: string; logOdds: number }>;
  probabilityFloor: number;
  probabilityCeiling: number;
  productionProbabilityUp: number;
  baselineReplayError: number;
}

export interface Prediction {
  symbol: string;
  name: string;
  iconUrl?: string;
  price: number;
  priceChange24h: number;
  modelProbabilityUp: number;
  edge: number;
  confidence: number;
  /** Estimate quality only. Agreement with venue pricing is deliberately excluded so disagreement
   *  can be traded rather than suppressed. */
  confidenceBreakdown: {
    base: number;
    dataQuality: number;
    sampleQuality: number;
    uncertaintyPenalty: number;
  };
  basis?: ContractBasis;
  /** Persisted for validation only; never consumed by probability, confidence, or execution gates. */
  cycleRegime?: CycleRegimeFeatures;
  /** Explicit final-minute average and maker-touch estimates are observation-only until validated. */
  settlementAverageEstimate?: SettlementAverageEstimate;
  makerFillEstimate?: MakerFillEstimate;
  /** Side-specific execution estimates. Legacy `makerFillEstimate` is the selected side snapshot. */
  makerFillEstimates?: Partial<Record<PositionSide, MakerFillEstimate>>;
  /** Versioned venue-independent issuance inputs used only for offline candidate replay. */
  calibrationReplay?: CalibrationReplaySnapshot;
  /** Venue-informed reference forecast, kept for comparison. Never used to compute edge. */
  blendedProbabilityUp?: number;
  venueProbabilityUp?: number;
  venueDisagreement?: number;
  signal: Signal;
  market: MarketQuote;
  kalshi?: VenueQuote;
  enabledTradingVenues: Array<'polymarket' | 'kalshi'>;
  factors: Factor[];
  chart: ChartPoint[];
}

export interface NewsItem {
  title: string;
  link: string;
  publishedAt: string;
  sentiment: Direction;
  score: number;
}

export interface TrackedForecast {
  id: string;
  cycleId?: string;
  trackingPolicyVersion?: string;
  symbol: string;
  marketUrl: string;
  issuedAt: string;
  closesAt: string;
  direction: 'UP' | 'DOWN';
  probabilityUp: number;
  directionalLikelihood: number;
  confidence: number;
  confidenceBreakdown?: Prediction['confidenceBreakdown'];
  modelVersion: string;
  policyVersion: string;
  polymarketProbabilityUp: number;
  kalshiProbabilityUp?: number;
  qualified?: boolean;
  entryVenue?: 'polymarket' | 'kalshi';
  /** Side selected by the expected-value policy. Legacy records without this field are UP entries. */
  entrySide?: PositionSide;
  entryAsk?: number;
  entryFeeRate?: number;
  predictedEdge?: number;
  realizedReturn?: number;
  blendedProbabilityUp?: number;
  volatilityRatio?: number;
  secondsRemaining?: number;
  basisPercent?: number;
  basisProbabilityUp?: number;
  calibrationReplay?: CalibrationReplaySnapshot;
  /** Observation-only path state available at issuance. */
  cycleRegime?: CycleRegimeFeatures;
  settlementAverageEstimate?: SettlementAverageEstimate;
  makerFillEstimate?: MakerFillEstimate;
  venueProbabilityUp?: number;
  enabledTradingVenues?: Array<'polymarket' | 'kalshi'>;
  actionableVenuePrices?: Array<{ venue: 'polymarket' | 'kalshi'; side: 'UP' | 'DOWN'; price: number }>;
  /** Issuance-time pointers into the immutable full-rules contract registry. */
  venueContracts?: Partial<Record<TradingVenue, ContractProvenanceRef>>;
  /** Outcomes are retained independently; `outcome` is selected from `evaluationVenue`. */
  venueOutcomes?: Partial<Record<TradingVenue, VenueOutcomeRecord>>;
  evaluationVenue?: TradingVenue;
  targetIntegrity?: 'venue-specific' | 'legacy-polymarket' | 'missing-provenance' | 'mismatched-outcome';
  factors: Array<Pick<Factor, 'id' | 'label' | 'score' | 'weight' | 'contribution' | 'confidence' | 'available'>>;
  status: 'pending' | 'resolved' | 'invalid';
  lastResolutionCheckAt?: string;
  resolvedAt?: string;
  outcome?: 'UP' | 'DOWN';
  correct?: boolean;
  brierScore?: number;
  logLoss?: number;
  invalidReason?: string;
}

export interface PerformanceSlice {
  label: string;
  resolved: number;
  correct: number;
  accuracy: number;
}

export interface PerformanceTimelinePoint {
  time: string;
  resolved: number;
  cumulativeAccuracy: number;
  rollingAccuracy: number;
  cumulativeBrier: number;
}

export interface BenchmarkScore {
  label: string;
  resolved: number;
  accuracy: number | null;
  brierScore: number | null;
  logLoss: number | null;
}

export interface LeadTimeSlice extends PerformanceSlice {
  brierScore: number | null;
}

export interface CalibrationBin {
  label: string;
  resolved: number;
  meanForecast: number;
  observedRate: number;
}

/**
 * Realized performance of one observable condition known at decision time. Trades inside a single
 * settlement window are correlated, so statistics are clustered by window rather than by trade.
 */
export interface SegmentStat {
  label: string;
  trades: number;
  windows: number;
  meanPredictedEdge: number;
  meanRealizedReturn: number;
  standardError: number | null;
  winRate: number;
}

export interface SegmentGroup {
  dimension: string;
  description: string;
  segments: SegmentStat[];
}

/**
 * Track record of actually executed trades for one mode. Built from the order ledger rather than the
 * calculation log, because fills, fees, and stake sizing are what determine realized money.
 */
export interface TradeTrackRecord {
  mode: ExecutionMode;
  settled: number;
  pending: number;
  windows: number;
  wins: number;
  losses: number;
  invalid: number;
  sold: number;
  unfilled: number;
  rejected: number;
  stakedCents: number;
  returnedCents: number;
  realizedPnlCents: number;
  roi: number | null;
  winRate: number | null;
  meanPredictedEdge: number | null;
  meanRealizedReturn: number | null;
  standardError: number | null;
  switchesEvaluated: number;
  meanSwitchVsHoldCents: number | null;
  standaloneExitsEvaluated: number;
  standaloneExitVsHoldCents: number | null;
  meanStandaloneExitVsHoldCents: number | null;
  principalRecoveryExitsEvaluated: number;
  principalRecoveryVsFullExitCents: number | null;
  meanPrincipalRecoveryVsFullExitCents: number | null;
  segments: SegmentGroup[];
}

export type ForecastHistoryRow = Pick<TrackedForecast,
  'id' | 'symbol' | 'direction' | 'directionalLikelihood' | 'issuedAt' | 'modelVersion'
  | 'policyVersion' | 'confidence' | 'outcome' | 'status' | 'correct'>;

/** Did claimed edge actually pay? The primary profitability metric. */
export interface EdgeBucket {
  label: string;
  trades: number;
  predictedEdge: number;
  realizedReturn: number;
  winRate: number;
}

/** Observation-only counterfactuals for sides that were cheap/positive-edge but rejected by a policy gate. */
export interface MissedBuyCounterfactual {
  label: string;
  description: string;
  candidates: number;
  windows: number;
  profitableCandidates: number;
  meanCandidateReturn: number | null;
  standardError: number | null;
  bestPerWindowCandidates: number;
  bestPerWindowWins: number;
  bestPerWindowMeanReturn: number | null;
  bestPerWindowTotalReturn: number | null;
}

export interface PerformanceSummary {
  issued: number;
  pending: number;
  resolved: number;
  cycles: number;
  resolvedCycles: number;
  cycleBalancedAccuracy: number | null;
  correct: number;
  invalid: number;
  accuracy: number | null;
  brierScore: number | null;
  logLoss: number | null;
  currentStreak: number;
  currentCycleStreak: number;
  observedCalculations: number;
  resolvedCalculations: number;
  benchmarks: BenchmarkScore[];
  edgeBuckets: EdgeBucket[];
  segments: SegmentGroup[];
  /** Never traded: exact-contract outcomes for apparent opportunities rejected by the active owned-side floor. */
  missedBuyCounterfactual: MissedBuyCounterfactual;
  /** Distinct 15-minute settlement windows resolved. Assets move together, so this is the honest
   *  independent sample unit; update counts and per-asset counts both overstate it. */
  resolvedWindows: number;
  evaluationMinimumWindows: number;
  evaluationMeaningful: boolean;
  realizedEdgeTrades: number;
  meanPredictedEdge: number | null;
  meanRealizedReturn: number | null;
  byLeadTime: LeadTimeSlice[];
  calibrationBins: CalibrationBin[];
  /** Unique resolved settlement timestamps across all recorded forecasts, including non-qualifying
   * calculations. This—not asset-cycle or update count—controls the calibration lock. */
  calibrationWindows: number;
  calibrationMinimum: number;
  calibrationProgress: number;
  calibrationReady: boolean;
  byAsset: PerformanceSlice[];
  byDirection: PerformanceSlice[];
  byModelVersion: PerformanceSlice[];
  byConfidenceBucket: PerformanceSlice[];
  timeline: PerformanceTimelinePoint[];
  recent: TrackedForecast[];
}

export interface WalkForwardParameters {
  temperature: number;
  basisWeight: number;
  volatilityScale: number;
  slowTiltScale: number;
  probabilityCap: number;
  minimumEdge: number;
  minimumQuality: number;
}

export interface WalkForwardScore {
  windows: number;
  observations: number;
  trades: number;
  winningTrades: number;
  meanWindowReturn: number;
  brierScore: number | null;
  logLoss: number | null;
  maximumDrawdown: number;
}

export interface WalkForwardFold {
  index: number;
  trainingWindows: number;
  testingWindows: number;
  testStartsAt: string;
  testEndsAt: string;
  selectedParameters: WalkForwardParameters;
  baseline: WalkForwardScore;
  candidate: WalkForwardScore;
}

export interface WalkForwardEvaluationRun {
  id: string;
  policyVersion: string;
  generatedAt: string;
  checkpointWindows: number;
  datasetFingerprint: string;
  datasetStartsAt: string;
  datasetEndsAt: string;
  exactReplayObservations: number;
  reconstructedReplayObservations: number;
  maximumBaselineReplayError: number;
  folds: WalkForwardFold[];
  baseline: WalkForwardScore;
  candidate: WalkForwardScore;
  recommendedParameters: WalkForwardParameters;
  parameterSelectionCounts: Array<{ parameters: WalkForwardParameters; folds: number }>;
  positiveCandidateFolds: number;
  candidateBeatBaselineFolds: number;
  decision: 'candidate_passed_review_thresholds' | 'baseline_retained' | 'insufficient_test_trades';
  reason: string;
  productionChanged: false;
}

export interface WalkForwardEvaluationHistory {
  policyVersion: string;
  activationWindows: number;
  checkpointEveryWindows: number;
  currentWindows: number;
  nextCheckpointWindows: number;
  runs: WalkForwardEvaluationRun[];
}

export interface CollectorStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  startedAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface DashboardData {
  generatedAt: string;
  expiresAt: string;
  modelVersion: string;
  tradingProviders: TradingProviderDescriptor[];
  policyManifest: PolicyManifest;
  collector: CollectorStatus;
  sourceStatus: {
    polymarket: boolean;
    kalshi: boolean;
    coinGecko: boolean;
    news: boolean;
    historical: boolean;
    contractReference: boolean;
    volatility: boolean;
    cache: boolean;
  };
  predictions: Prediction[];
  performance: PerformanceSummary;
  news: NewsItem[];
  disclaimer: string;
}

/** Public research response. Private performance and provider-control metadata are never serialized here. */
export type PublicDashboardData = Omit<DashboardData, 'tradingProviders' | 'performance'>;
/** A client may receive either public research data or the full signed dashboard payload. */
export type DashboardViewData = PublicDashboardData & Partial<Pick<DashboardData, 'tradingProviders' | 'performance'>>;

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  source?: 'direct' | 'pi';
  enabled: boolean;
  current: boolean;
  defaultModel: string;
  model: string;
}

export interface ResearchResponse {
  provider: string;
  model: string;
  answer: string;
  attemptedProviders?: string[];
  generatedAt: string;
}

export interface AccountPosition {
  venue: 'polymarket' | 'kalshi';
  id: string;
  title: string;
  side: string;
  size: number;
  averagePrice: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
}

export interface VenueAccount {
  venue: 'polymarket' | 'kalshi';
  configured: boolean;
  environment?: 'demo' | 'production';
  connected: boolean;
  tradeAuthenticated?: boolean;
  balance?: number;
  positions: AccountPosition[];
  openOrders: number;
  error?: string;
}

export interface AccountsData {
  generatedAt: string;
  tradingEnabled: false;
  venues: VenueAccount[];
}

export type AutomationState = 'unconfigured' | 'paused' | 'active' | 'depleted';

export interface BudgetControl {
  revision: number;
  state: AutomationState;
  mode: 'paper' | 'live';
  startingBudgetCents: number;
  availableBudgetCents: number;
  reservedBudgetCents: number;
  realizedPnlCents: number;
  /** All-in spend cap for a single purchase, inclusive of venue fees. */
  perTradeCents: number;
  /** Retained for historical records; sizing is now an explicit per-trade amount. */
  purchasePercent: number;
  enabledVenues: Array<'polymarket' | 'kalshi'>;
  /** Last explicit operator choice. System safety suspension never changes active intent. */
  operatorIntent?: 'active' | 'paused';
  pauseOrigin?: 'user' | 'system' | 'configuration';
  autoResumeEligible?: boolean;
  pauseReason?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface LiveRiskStatus {
  allowed: boolean;
  currentEpochDrawdownCents: number;
  lifetimeRealizedPnlCents: number;
  lifetimeLossCents: number;
  maximumCurrentEpochDrawdownCents: number;
  maximumCurrentEpochDrawdownPercent: number;
  maximumLifetimeLossCents: number;
  reasons: string[];
}

export interface AdaptiveRegimeGateStatus {
  phase: 'disabled' | 'warming' | 'open' | 'closed';
  allowsEntries: boolean;
  policyVersion: string;
  resolvedWindows: number;
  effectiveWindows: number;
  weightedMeanEdge: number | null;
  standardError: number | null;
  negativeReturnConfidence: number | null;
  reason: string;
  pendingWindows: number;
  latestResolvedAt?: string;
  configured: {
    enabled: boolean;
    minimumPolicyWindows: number;
    evidenceHalfLifeWindows: number;
    pauseConfidence: number;
    resumeConfidence: number;
  };
  transitions: Array<{
    at: string;
    from: 'disabled' | 'warming' | 'open' | 'closed';
    to: 'disabled' | 'warming' | 'open' | 'closed';
    policyVersion: string;
    reason: string;
  }>;
}

export interface BudgetAuditEvent {
  id: string;
  timestamp: string;
  type: 'configured' | 'venues_updated' | 'paused' | 'risk_stopped' | 'resumed' | 'reserved' | 'released' | 'settled' | 'depleted' | 'rejected' | 'reconciled';
  reason: string;
  previousState: AutomationState;
  newState: AutomationState;
  amountCents?: number;
  payoutCents?: number;
  venue?: 'polymarket' | 'kalshi';
  relatedId?: string;
  revision: number;
}

export interface TradingVenueReadiness {
  venue: 'polymarket' | 'kalshi';
  environment?: 'demo' | 'production';
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  tradeReady: boolean;
  balanceCents?: number;
  reason: string;
}

export type PaperOrderStatus = 'pending_reservation' | 'uncertain' | 'open' | 'sold' | 'won' | 'lost' | 'invalid' | 'unfilled' | 'rejected';
export type ExecutionMode = 'paper' | 'live';

/** Immutable issuance-time evidence explaining why an order cleared the binary edge-buy gates. */
export interface EntryDecisionSnapshot {
  version: 'entry-decision-v1';
  providerId?: TradingProviderId;
  providerVariantId?: string;
  forecastModelVersion?: string;
  executionPolicyVersion?: string;
  policyVersion: string;
  calculationAt: string;
  side: PositionSide;
  probabilityUp: number;
  probabilityDown: number;
  selectedSideProbability: number;
  confidence: number;
  confidenceBreakdown: Prediction['confidenceBreakdown'];
  actionableAsk: number;
  actionableBid: number;
  feeRate: number;
  netEdge: number;
  spread: number;
  secondsRemaining: number;
  qualifyingSnapshots: number;
  medianNetEdge: number | null;
  basis?: ContractBasis;
  calibrationReplay?: CalibrationReplaySnapshot;
  settlementAverageEstimate?: SettlementAverageEstimate;
  factors: Factor[];
}

export interface PaperOrder {
  id: string;
  /** Paper runs continuously as a shadow; live only runs while automation is active in live mode. */
  executionMode: ExecutionMode;
  providerId?: TradingProviderId;
  providerVariantId?: string;
  /** Stable asset/window intent shared by bounded maker attempts. */
  logicalOrderId?: string;
  attemptNumber?: number;
  retryOfOrderId?: string;
  /** Deterministic id submitted to the venue; retained even when the HTTP response is lost. */
  clientOrderId?: string;
  /** Venue order identifier, persisted as soon as Kalshi acknowledges an order. */
  venueOrderId?: string;
  filledCount?: number;
  liquidityRole?: 'maker' | 'taker';
  noFillReason?: 'post_only_race' | 'rested_no_fill' | 'ioc_no_fill';
  /** Present on grouped API views; the durable ledger still retains every individual attempt. */
  attemptHistory?: Array<{
    id: string;
    attemptNumber: number;
    status: PaperOrderStatus;
    noFillReason?: 'post_only_race' | 'rested_no_fill' | 'ioc_no_fill';
    filledCount?: number;
    createdAt: string;
  }>;
  recoveredAfterRetry?: boolean;
  symbol: string;
  venue: 'polymarket' | 'kalshi';
  contractId: string;
  side: PositionSide;
  status: PaperOrderStatus;
  createdAt: string;
  calculationAt: string;
  closesAt: string;
  modelProbabilityUp: number;
  confidence: number;
  /** Complete immutable decision snapshot for open-position inspection and historical audit. */
  entryDecision?: EntryDecisionSnapshot;
  /** Observation-only estimate captured for fill-model validation; never used for sizing/gating. */
  makerFillEstimate?: MakerFillEstimate;
  settlementAverageEstimate?: SettlementAverageEstimate;
  askPrice: number;
  bidPrice: number;
  spread: number;
  quantity: number;
  /** Original requested count retained when a partial fill later replaces quantity with acquired size. */
  requestedQuantity?: number;
  /** Whole-cent amount held in the local risk ledger; may conservatively round venue spend up. */
  stakeCents: number;
  feeCents: number;
  /** Exact sub-cent venue terms for live fills; absent on legacy and simulated records. */
  actualPurchaseCents?: number;
  actualFeeCents?: number;
  actualStakeCents?: number;
  actualPnlCents?: number;
  /** Issuance-time maker/taker decision. Maker mode records taker recommendations as shadow only. */
  entryExecutionDecision?: {
    policyVersion: string;
    configuredMode: 'maker' | 'adaptive' | 'taker';
    executedStyle: 'maker' | 'taker';
    recommendedStyle: 'maker' | 'taker';
    reason: string;
    takerNetEdge: number;
    medianNetEdge: number;
    makerNetEdge: number;
    makerExpectedCapturedEdge: number | null;
    takerAdvantage: number | null;
    makerCohort: string;
    makerSamples: number;
    makerFillRate: number | null;
  };
  shadowTakerAllInCents?: number;
  shadowTakerQuantity?: number;
  /** Durable standalone-exit observation state; all values use executable owned-side bids. */
  profitLockArmedAt?: string;
  peakNetLiquidationCents?: number;
  peakNetProfitPercent?: number;
  peakOwnedSideProbability?: number;
  peakObservedAt?: string;
  latestNetLiquidationCents?: number;
  latestNetProfitPercent?: number;
  latestOwnedSideProbability?: number;
  latestExitObservationAt?: string;
  standaloneExitPolicy?: 'strict-value-v1' | 'profit-reversal-75-v1';
  standaloneExitAttemptedAt?: string;
  standaloneExitHoldValueCents?: number;
  standaloneExitOptimisticHoldValueCents?: number;
  /** Reduce-only close terms when a position is sold before settlement or to fund a superior candidate. */
  exitClientOrderId?: string;
  exitRequestedAt?: string;
  exitPending?: boolean;
  exitVenueOrderId?: string;
  exitPrice?: number;
  exitFeeCents?: number;
  saleProceedsCents?: number;
  switchDeltaCents?: number;
  switchDecisionAt?: string;
  switchedToOrderId?: string;
  counterfactualHoldOutcome?: 'UP' | 'DOWN';
  counterfactualHoldPnlCents?: number;
  counterfactualSwitchPnlCents?: number;
  switchVsHoldCents?: number;
  replacedOrderId?: string;
  potentialPayoutCents: number;
  settledAt?: string;
  outcome?: 'UP' | 'DOWN';
  payoutCents?: number;
  pnlCents?: number;
  reason?: string;
}

export type PortfolioDecisionState = 'qualified' | 'portfolio-selected' | 'switch-candidate' | 'blocked';
export interface PortfolioDecisionView {
  state: PortfolioDecisionState;
  reason: string;
  expectedProfitCents?: number;
  adjustedExpectedContributionCents?: number;
  rank?: number;
  updatedAt: string;
}

export interface ExecutionSignalReadiness {
  symbol: string;
  side: PositionSide;
  closesAt: string;
  eligible: boolean;
  reason: string;
  qualifyingSnapshots: number;
  medianNetEdge: number | null;
  portfolio?: PortfolioDecisionView;
  /** Latest live entry lifecycle for this exact asset and contract window. */
  liveAttempt?: {
    status: PaperOrderStatus;
    createdAt: string;
    filledCount?: number;
    quantity: number;
    reason?: string;
    noFillReason?: 'post_only_race' | 'rested_no_fill' | 'ioc_no_fill';
    attemptNumber?: number;
    maximumAttempts?: number;
    retryEligible?: boolean;
  };
}

export interface MakerFillBucket {
  label: string;
  attempts: number;
  fills: number;
  meanPredictedProbability: number;
  observedFillRate: number;
}
export interface MakerExecutionSegment {
  dimension: 'Direction' | 'Attempt' | 'Entry price' | 'Quote distance' | 'Quote volatility';
  label: string;
  submitted: number;
  accepted: number;
  fills: number;
  resolvedFills: number;
  fillRateGivenAcceptance: number | null;
  filledWinRate: number | null;
  meanFilledReturn: number | null;
}

export interface MakerFillReport {
  adaptiveExecution: {
    policyVersion: string;
    shadowEvaluations: number;
    takerRecommendations: number;
    resolvedTakerRecommendations: number;
    meanTakerCounterfactualReturn: number | null;
    actualTakerOrders: number;
    actualTakerFills: number;
    resolvedActualTakerFills: number;
    meanActualTakerReturn: number | null;
  };
  /** Backward-compatible first-passage cohort: accepted terminal attempts carrying a model estimate. */
  attempts: number;
  fills: number;
  meanPredictedProbability: number | null;
  observedFillRate: number | null;
  buckets: MakerFillBucket[];
  model: 'quote-first-passage-v1';
  submittedAttempts: number;
  postOnlyRaces: number;
  otherRejectedAttempts: number;
  acceptedAttempts: number;
  restedNoFillAttempts: number;
  partialFills: number;
  completeFills: number;
  acceptanceRate: number | null;
  fillRateGivenAcceptance: number | null;
  resolvedFilledAttempts: number;
  resolvedFilledWindows: number;
  resolvedAcceptedNoFillAttempts: number;
  resolvedAcceptedNoFillWindows: number;
  filledWinRate: number | null;
  acceptedNoFillCounterfactualWinRate: number | null;
  adverseSelectionWinRateGap: number | null;
  pairedAdverseSelectionWindows: number;
  pairedWinRateGap: number | null;
  pairedWinRateGapStandardError: number | null;
  meanFilledReturn: number | null;
  meanAcceptedNoFillCounterfactualReturn: number | null;
  pairedReturnGap: number | null;
  pairedReturnGapStandardError: number | null;
  segments: MakerExecutionSegment[];
}

/** Sanitized, bounded paper-only execution row exposed without a signed dashboard session. */
export interface PublicPaperExecutionRecord {
  symbol: string;
  venue: 'polymarket' | 'kalshi';
  side: PositionSide;
  status: PaperOrderStatus;
  createdAt: string;
  closesAt: string;
  askPrice: number;
  quantity: number;
  stakeCents: number;
  feeCents: number;
  pnlCents?: number;
  outcome?: PositionSide;
  noFillReason?: 'post_only_race' | 'rested_no_fill' | 'ioc_no_fill';
  liquidityRole?: 'maker' | 'taker';
}

/** Bounded paper-only ledger view exposed without a signed dashboard session. */
export interface PublicPaperBudget {
  /** False on a stateless hosted dashboard, which cannot report the persistent worker ledger. */
  durable: boolean;
  startingCents: number;
  availableCents: number;
  equityCents: number;
  reservedCents: number;
  proposedStakeCents: number;
  running: boolean;
  depleted: boolean;
  openOrders: number;
  settledOrders: number;
  realizedPnlCents: number;
  bankrollResets: number;
  /** Newest grouped paper execution intents only; never includes live data or venue/client identifiers. */
  recentExecutions: PublicPaperExecutionRecord[];
}

export interface ExecutionSummary {
  mode: ExecutionMode;
  running: boolean;
  /** No funds left and nothing open to recover them, so the track has stalled until it is reset. */
  depleted: boolean;
  /** Why the most recent cycle declined to place an order, so a skip is never silent. */
  blockedReason?: string;
  startingCents: number;
  /** Spendable now, excluding stakes already committed to open positions. */
  availableCents: number;
  /** Committed to open positions and unavailable until they settle. */
  reservedCents: number;
  /** What the next qualifying trade would stake under this track's own sizing rules. */
  proposedStakeCents: number;
  bankrollResets?: number;
  openOrders: number;
  settledOrders: number;
  wins: number;
  losses: number;
  realizedPnlCents: number;
  equityCents: number;
  recentOrders: PaperOrder[];
}

export interface TradingControlData {
  control: BudgetControl;
  tradingProviders?: TradingProviderDescriptor[];
  workingEquityCents: number;
  proposedStakeCents: number;
  maximumPurchasePercent: number;
  /** Server-only emergency ceiling; effective purchase cap is min(user amount, this value). */
  maximumLiveStakeCents: number;
  totalUsableBalanceCents: number;
  fundingCovered: boolean;
  executionEngineReady: boolean;
  canResume: boolean;
  blockers: string[];
  venues: TradingVenueReadiness[];
  recentAudit: BudgetAuditEvent[];
  paper?: ExecutionSummary;
  live?: ExecutionSummary;
  reconciliation?: import('./reconciliation-state').KalshiReconciliationStatus;
  executionDrain?: import('./execution-drain-state').ExecutionDrainStatus;
  executionSignals?: ExecutionSignalReadiness[];
  liveAvailable: boolean;
  liveBlockers: string[];
  maximumLiveMakerAttempts?: number;
  portfolioConstraints?: { maximumPositions: number; maximumSameWindow: number; maximumSameGroupPerWindow: number };
  liveRisk: LiveRiskStatus;
  /** Adaptive soft entry gate; it never withdraws operator intent or blocks reduce-only exits. */
  regimeGate?: AdaptiveRegimeGateStatus;
}
