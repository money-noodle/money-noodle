import type { EpochResult } from './budget-epoch';

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

/**
 * A market is an instrument class plus a horizon and settlement semantics. Only one exists today, but
 * budgets, orders, and reported summaries carry it explicitly so a second market is additive rather
 * than a migration of every historical record.
 */
export type MarketId = 'crypto-15m' | 'crypto-spot';

/**
 * A strategy is a complete way of deciding what to buy and when to sell, running on a market. Two exist:
 * the model-driven edge policy, and the long-shot round trip, which consumes no probability at all.
 *
 * Keyed separately from market and provider because it varies along its own axis (SPEC §12.10). Budget,
 * bankroll, P&L, loss stops, and operator intent are per strategy; exposure caps, the kill switch,
 * reconciliation, drain, and the venue order ceiling are not, because those are account properties.
 */
export type StrategyId = 'edge-binary-buy' | 'long-shot-round-trip';

export interface StrategyDescriptor {
  id: StrategyId;
  name: string;
  /** Whether entries come from the forecast model or purely from venue price and clock. */
  signalSource: 'model-probability' | 'venue-price';
  description: string;
}

export interface MarketDescriptor {
  id: MarketId;
  name: string;
  /** Instrument class, kept separate from horizon so a future spot or equity market is not a binary. */
  instrument: 'binary-event-contract' | 'spot';
  horizonSeconds: number;
  /** What the contract settles against, which is why two venues' contracts may not be comparable. */
  settlementBasis: string;
  description: string;
}

/**
 * Declared per (provider, market) pair rather than per provider: a provider may support live trading on
 * one market and nothing at all on another. Crypto.com is the concrete case — its API trades spot and
 * perpetuals but no event contracts.
 */
export interface ProviderMarketCapability {
  providerId: TradingProviderId;
  marketId: MarketId;
  marketData: boolean;
  paper: boolean;
  live: boolean;
  /** Why the pair is limited, shown verbatim so a disabled control is never unexplained. */
  readiness: string;
}

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
  /**
   * Union across this provider's markets, retained so existing callers keep working. Per-market
   * decisions must read `marketCapabilities`: a provider live on one market is not live on all.
   */
  capabilities: { marketData: boolean; paper: boolean; live: boolean };
  marketCapabilities: ProviderMarketCapability[];
  researchEnabled: boolean;
  paperEnabled: boolean;
  liveEnabled: boolean;
  selectedVariantId: string;
  configurationUpdatedAt: string;
  readiness: string;
  variants: TradingProviderVariant[];
}

export type PolicyComponentKind = 'forecast' | 'buy' | 'eligibility' | 'execution' | 'exit' | 'switch' | 'regime' | 'regime-classification' | 'provider';
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
export type ModelPromotionAction = 'promoted' | 'rolled-back';
/** Held-out evidence copied out of the cited run, so it cannot drift away from the decision. */
export interface ModelPromotionEvidence {
  checkpointWindows: number;
  candidateMeanWindowReturn: number;
  baselineMeanWindowReturn: number;
  candidateTrades: number;
  positiveCandidateFolds: number;
  candidateBeatBaselineFolds: number;
  maximumBaselineReplayError: number;
}
export interface ModelPromotionEntry {
  id: string;
  at: string;
  action: ModelPromotionAction;
  modelVersion: string;
  parameters: WalkForwardParameters;
  /** Operator-supplied justification. Required: an unexplained promotion is not auditable. */
  reason: string;
  /** Walk-forward run the decision cited, retained so the evidence cannot drift from the decision. */
  evidenceRunId?: string;
  evidence?: ModelPromotionEvidence;
  /** Entry this one supersedes, set on a rollback so the chain is explicit. */
  supersedesId?: string;
}
/** What production is running, against what the promotion ledger can actually account for. */
export interface PolicyManifestModel {
  productionVersion: string;
  currentPromotion?: ModelPromotionEntry;
  /** True when production runs a version no promotion record explains. */
  unrecorded: boolean;
  history: ModelPromotionEntry[];
}
export interface PolicyManifest {
  version: 'policy-manifest-v1';
  generatedAt: string;
  activeBuyPolicyVersion: string;
  activeBuyPolicyActivatedAt: string;
  components: PolicyManifestComponent[];
  history: PolicyManifestHistoryEntry[];
  /** Promotion provenance is track-record-derived, so it is withheld from the public payload. */
  model?: PolicyManifestModel;
}

export type ContractComparability = 'exact' | 'approximate' | 'not-comparable';
export type SettlementPriceMethod = 'simple-average' | 'time-weighted-average' | 'point-in-time' | 'unknown';

export interface ContractTargetComparison {
  comparability: ContractComparability;
  reason: string;
  closeAligned: boolean;
  settlementWindowAligned: boolean | null;
  referenceWindowAligned: boolean | null;
  oracleAligned: boolean | null;
  methodAligned: boolean | null;
}

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
  settlementPriceMethod?: SettlementPriceMethod;
  referenceWindowSeconds?: number;
  settlementWindowSeconds?: number;
  roundingDecimals?: number;
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

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface BinaryOrderBook {
  yesBids: OrderBookLevel[];
  noBids: OrderBookLevel[];
  observedAt: string;
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
  orderBook?: BinaryOrderBook;
  contract?: ContractProvenanceRecord;
}

export interface ContractComparabilityVenueReport {
  venue: TradingVenue;
  contracts: number;
  metadataContracts: number;
  resolvedWindows: number;
  directReferenceDriftSamples: number;
  meanReferenceDriftPercent: number | null;
  meanAbsoluteReferenceDriftPercent: number | null;
  maximumAbsoluteReferenceDriftPercent: number | null;
  proxyOutcomeSamples: number;
  proxyOutcomeAgreement: number | null;
}

export interface ContractComparabilityRow {
  id: string;
  symbol: string;
  venue: TradingVenue;
  contractId: string;
  closesAt: string;
  settlementPriceMethod: SettlementPriceMethod;
  referenceWindowSeconds?: number;
  settlementWindowSeconds?: number;
  krakenReferencePrice: number;
  venueReferencePrice?: number;
  referenceDriftPercent?: number;
  krakenSettlementAverage?: number;
  proxyOutcome?: PositionSide;
  venueOutcome?: PositionSide;
  proxyAgreed?: boolean;
}

export interface ContractComparabilityReport {
  version: 'contract-comparability-v1';
  generatedAt: string;
  comparison: ContractTargetComparison;
  totalContracts: number;
  metadataContracts: number;
  pairedOutcomeWindows: number;
  pairedOutcomeAssetWindows: number;
  venueOutcomeDisagreements: number;
  venues: ContractComparabilityVenueReport[];
  recent: ContractComparabilityRow[];
  productionChanged: false;
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
  windowSeconds?: number;
  expectedAveragePrice: number;
  standardDeviationPercent: number;
  effectiveVarianceSeconds: number;
  observedSettlementSeconds: number;
  method: 'future-window' | 'partially-observed-window';
}

export interface MakerFillEstimate {
  /** Probability the resting order is FILLED, not merely touched. */
  probability: number;
  horizonSeconds: number;
  quoteDistance: number;
  quoteVolatilityPerSecond: number;
  samples: number;
  model: 'quote-first-passage-v1' | 'maker-fill-empirical-v2';
  /** First-passage touch probability, retained as a diagnostic after it failed validation. */
  touchProbability?: number;
  /** Comparable prior attempts the empirical estimate was shrunk toward, and their observed rate. */
  cohortLabel?: string;
  cohortAttempts?: number;
  cohortFillRate?: number | null;
}

/**
 * Everything production's estimate-quality expression reads, so a candidate can recompute quality
 * instead of inheriting the number production already produced.
 */
export interface ConfidenceReplayInput {
  basisPresent: boolean;
  /** Only presence changes the score today, but the count is what production actually observed. */
  venueProbabilityCount: number;
  volatilitySamples: number;
  secondsRemaining: number;
  /** 24-hour high-low spread as a percent of price. */
  rangePercent: number;
}

export interface CalibrationReplaySnapshot {
  version: 'calibration-replay-v1';
  source: 'issuance-exact' | 'historical-reconstruction';
  /**
   * Quality replay is tracked separately from probability replay because it began later: rows issued
   * before it existed carry `absent` rather than a reconstruction, since quality cannot be inverted
   * from its output uniquely the way the basis z-score can.
   */
  confidenceSource?: 'issuance-exact' | 'absent';
  confidenceInput?: ConfidenceReplayInput;
  productionConfidence?: number;
  confidenceReplayError?: number;
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
  /** Rule-level comparison only; observation/reporting input, never a forecast or execution gate. */
  targetComparison?: ContractTargetComparison;
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
  targetComparison?: ContractTargetComparison;
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
  /**
   * Consecutive resolution passes that produced no outcome. Drives exponential backoff so a forecast
   * whose contract never resolves stops costing an upstream request every minute forever.
   */
  resolutionAttempts?: number;
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

/** The standalone exit policies, named exactly as they are stamped onto each exit order. */
export type StandaloneExitPolicy = 'strict-value-v1' | 'profit-reversal-75-v1';

/**
 * Whether an arm's rejected alternative is priced from the settled venue outcome, or estimated from an
 * executable bid recorded while the position was open. The two are not equivalent evidence.
 */
export type ActionCounterfactualBasis = 'authoritative' | 'approximate';

/**
 * One action-versus-alternative comparison. Positive incremental values mean the action actually taken
 * beat the alternative it rejected. Means are clustered by settlement window.
 */
export interface ActionCounterfactualArm {
  action: 'HOLD' | 'EXIT' | 'SWITCH';
  alternative: string;
  policy: string;
  basis: ActionCounterfactualBasis;
  description: string;
  decisions: number;
  windows: number;
  /** Decisions where the action beat its alternative. Frequency, not magnitude — the two diverge. */
  decisionsBeatingAlternative: number;
  /**
   * Share of decisions where the action beat its alternative.
   *
   * Read together with `meanIncrementalReturn`, never instead of it. An exit policy is insurance and is
   * expected to be right well under half the time while still being worth running; a low hit rate beside
   * a positive mean is the intended shape, not a defect to tune away.
   */
  hitRate: number | null;
  takenPnlCents: number;
  alternativePnlCents: number;
  incrementalCents: number;
  meanIncrementalCents: number | null;
  meanIncrementalReturn: number | null;
  incrementalReturnStandardError: number | null;
  credible: boolean;
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
  /**
   * Per-policy HOLD/EXIT/SWITCH counterfactuals. These replace the single blended exit-versus-hold
   * figure, which averaged two policies that point in opposite directions and hid both.
   */
  actionCounterfactualVersion: string;
  actionCounterfactuals: ActionCounterfactualArm[];
  principalRecoveryExitsEvaluated: number;
  principalRecoveryVsFullExitCents: number | null;
  meanPrincipalRecoveryVsFullExitCents: number | null;
  segments: SegmentGroup[];
}

/**
 * One track record per (provider, market) within an execution mode, so a venue's fills, unfilled maker
 * attempts, and rejections are never averaged into another's. Attempts and failures matter as much as
 * wins here: a provider that rejects half its orders is not comparable to one that fills them.
 */
export interface ProviderTradeRecord {
  providerId: TradingProviderId;
  marketId: MarketId;
  record: TradeTrackRecord;
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
  bestPerWindowStandardError: number | null;
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
  /**
   * Upper bound on net edge, mirroring `maximumNetEdge()` in the production gate.
   *
   * Absent until 2026-08-18, which meant the evaluator's baseline was **not the gate the desk runs**: it
   * admitted candidates production rejects as implausible, so a candidate parameter set was compared
   * against a policy that has never traded. Defaulted to the production constant so the existing baseline
   * reproduces exactly.
   */
  maximumEdge: number;
  /**
   * Floor on the selected side's own probability, mirroring `MIN_SELECTED_PROBABILITY`.
   *
   * Also absent until 2026-08-18, and load-bearing: v13 restored this floor after prospective v12
   * monitoring found that acquired 52.5–55% sides lost. An evaluator that cannot express it cannot
   * re-derive that decision or defend it.
   */
  minimumSelectedProbability: number;
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
  /**
   * Quality-replay coverage, reported separately from probability coverage. Until this reaches the
   * whole dataset, a candidate that changes how quality is computed can only be scored on the rows
   * that carry exact inputs — the rest inherit production's quality and cannot test a replacement.
   */
  exactConfidenceReplayObservations: number;
  absentConfidenceReplayObservations: number;
  maximumConfidenceReplayError: number;
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
  venue: TradingProviderId;
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
  /** Any provider, not only the two original venues: an account is a provider-level relationship. */
  venue: TradingProviderId;
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
  /**
   * Highest working equity observed in this budget epoch, so drawdown is measured from the peak rather
   * than from the funded amount. Absent on records written before peak tracking; those fall back to the
   * starting budget, which reproduces the previous behaviour exactly.
   */
  peakEquityCents?: number;
  /**
   * Identity of the current budget configuration. Reconfiguring rebases funded capital and restarts
   * current-epoch P&L, so without this an earlier epoch's trades are silently unattributable — which is
   * why reconstructed history did not reconcile with the control record. Absent on records written
   * before epochs existed; those belong to `LEGACY_BUDGET_EPOCH_ID`.
   */
  epochId?: string;
  epochSequence?: number;
  epochStartedAt?: string;
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

/** Share of a provider's equity that one market may commit. Hard cap, never a target. */
export interface MarketAllocation {
  marketId: MarketId;
  percent: number;
  /**
   * Strategies funded within this market. Absent means the whole market allocation belongs to
   * `edge-binary-buy`, which is what every configuration written before 2026-08-15 meant.
   */
  strategies?: StrategyAllocation[];
}

/**
 * A strategy's share of one (provider, market) allocation. `percent` funds it once, at configuration
 * time; `startingCents` is the resulting cash and is what the strategy's own equity rolls forward from.
 *
 * The percentage is deliberately not re-applied continuously. Doing so would size one strategy's ticket
 * from the other's results — a run of edge-policy wins would raise the long-shot ticket, and its own
 * losses would only reach it diluted by its share, so the drawdown halt could never fire on the strategy
 * that earned it.
 */
export interface StrategyAllocation {
  strategyId: StrategyId;
  percent: number;
  startingCents: number;
  fundedAt: string;
}

/**
 * Operator-configured budget for one provider. `liveLimitCents` and `paperLimitCents` are ceilings on
 * the equity this provider may put to work, not a second cash ledger: cash accounting stays single-source
 * in the legacy control and paper ledger until a second live provider is funded and per-provider balances
 * can be reconciled against real venue cash.
 */
export interface ProviderBudget {
  providerId: TradingProviderId;
  /** 0 means no provider-specific ceiling beyond the configured working budget. */
  liveLimitCents: number;
  paperLimitCents: number;
  allocations: MarketAllocation[];
  updatedAt: string;
}

export interface ProviderBudgetConfiguration {
  version: 'provider-budget-v1';
  revision: number;
  updatedAt: string;
  /** Records the legacy control this configuration was seeded from, for audit. */
  seededFrom?: string;
  providers: ProviderBudget[];
}

/** What a single (provider, market) pair may commit right now, after its own reservations. */
export interface MarketFunding {
  providerId: TradingProviderId;
  marketId: MarketId;
  mode: ExecutionMode;
  /** Provider equity the allocation is computed against. */
  providerEquityCents: number;
  percent: number;
  /** percent × provider equity, floored to whole cents. */
  capCents: number;
  /** This pair's own open commitments, which its own cap must cover. */
  reservedCents: number;
  /** cap − own reservations, further bounded by cash actually available. */
  spendableCents: number;
  reason: string;
}

/** What one strategy within a (provider, market) pair may commit right now, and whether it has halted. */
export interface StrategyFunding {
  strategyId: StrategyId;
  marketId: MarketId;
  mode: ExecutionMode;
  percent: number;
  /** Cash this strategy was funded with, which its equity rolls forward from. */
  startingCents: number;
  /** This strategy's own settled P&L, read from the shared ledger. */
  realizedPnlCents: number;
  /** starting + own realized P&L: the figure the ticket is sized from. */
  equityCents: number;
  /** This strategy's own open commitments. */
  reservedCents: number;
  spendableCents: number;
  ticketCents: number;
  halted: boolean;
  reason: string;
}

export interface LiveRiskStatus {
  allowed: boolean;
  currentEpochDrawdownCents: number;
  lifetimeRealizedPnlCents: number;
  lifetimeLossCents: number;
  maximumCurrentEpochDrawdownCents: number;
  maximumCurrentEpochDrawdownPercent: number;
  maximumLifetimeLossCents: number;
  /**
   * Current-epoch realized P&L per strategy, for the drawdown stop only.
   *
   * The drawdown is deliberately **not** scoped by strategy: there is one pot of cash, so if one strategy
   * loses, the account really is down and a capital-preservation stop should fire. What that costs is
   * attribution — the stop can pause a strategy that did nothing wrong — so the split is reported instead,
   * and the reason names it as account-wide rather than implying the strategy being blocked caused it.
   *
   * The lifetime stop is different and *is* scoped, because it measures a strategy's own track record
   * rather than the capital remaining.
   */
  currentEpochAttribution: Array<{ strategyId: StrategyId; realizedPnlCents: number }>;
  reasons: string[];
}

export interface CalendarForecastObservation {
  id: string;
  collectionVersion: string;
  policyVersion: string;
  modelVersion: string;
  symbol: string;
  contractId: string;
  closesAt: string;
  observedAt: string;
  secondsRemaining: number;
  probabilityUp: number;
  confidence: number;
  askUp: number;
  bidUp: number;
  askDown: number;
  bidDown: number;
  estimatedFeeUp: number;
  estimatedFeeDown: number;
  qualified: boolean;
  selectedSide?: PositionSide;
  predictedNetEdge?: number;
  cycleRegime?: CycleRegimeLabel;
  factors: Array<Pick<Factor, 'id' | 'score' | 'contribution' | 'available'>>;
  outcome?: PositionSide;
  resolvedAt?: string;
  brierScore?: number;
  correct?: boolean;
}

export interface CalendarCandidateObservation {
  symbol: string;
  contractId: string;
  side: PositionSide;
  createdAt: string;
  selectedSideProbability: number;
  confidence: number;
  askPrice: number;
  bidPrice: number;
  estimatedFeeRate: number;
  estimatedMakerFeeRate: number;
  predictedNetEdge: number;
  makerFillProbability?: number | null;
  makerFillModel?: string;
  outcome?: PositionSide;
  resolvedAt?: string;
  askProfitPerContract?: number;
  makerExpectedProfitPerContract?: number;
}

export interface CalendarWindowObservation {
  id: string;
  collectionVersion: string;
  policyVersion: string;
  closesAt: string;
  evaluationAt: string;
  firstObservedAt: string;
  candidate?: CalendarCandidateObservation;
  candidateStatus: 'pending' | 'selected' | 'none';
  finalizedAt?: string;
}

export interface CalendarCohortReport {
  key: string;
  label: string;
  observedWindows: number;
  calendarDates: number;
  fixedForecasts: number;
  resolvedForecastWindows: number;
  forecastAccuracy: number | null;
  brierScore: number | null;
  candidateWindows: number;
  resolvedCandidateWindows: number;
  noCandidateWindows: number;
  meanAskProfitPerContract: number | null;
  askStandardError: number | null;
  meanMakerExpectedProfitPerContract: number | null;
}

export interface CalendarEvaluationReport {
  collectionVersion: string;
  productionPolicyVersion: string;
  timeZone: string;
  startedAt: string;
  updatedAt: string;
  fixedForecasts: number;
  resolvedForecasts: number;
  observedWindows: number;
  resolvedCandidateWindows: number;
  noCandidateWindows: number;
  distinctCalendarDates: number;
  minimumTimeReviewDates: number;
  minimumCandidateWindowsPerCohort: number;
  minimumWeekdayOccurrences: number;
  timeReviewReady: boolean;
  weekdayReviewReady: boolean;
  productionChanged: false;
  timeBands: CalendarCohortReport[];
  weekdays: CalendarCohortReport[];
}

export interface PersistenceCandidateIntent {
  id: string;
  candidateVersion: string;
  productionPolicyVersion: string;
  symbol: string;
  contractId: string;
  side: PositionSide;
  closesAt: string;
  createdAt: string;
  calculationAt: string;
  selectedSideProbability: number;
  confidence: number;
  askPrice: number;
  bidPrice: number;
  spread: number;
  estimatedAskFeeRate: number;
  estimatedMakerFeeRate: number;
  predictedNetEdge: number;
  qualifyingSnapshots: number;
  observationSpanMs: number;
  productionEligibleAtCandidate: boolean;
  productionEligibleAt?: string;
  productionDelayMs?: number;
  /** Empirical accepted-order fill estimate captured prospectively; never treated as an observed fill. */
  makerFillProbability?: number | null;
  makerFillModel?: string;
  outcome?: PositionSide;
  resolvedAt?: string;
  askProfitPerContract?: number;
  makerExpectedProfitPerContract?: number;
  invalidReason?: string;
}

export interface PersistenceCandidateReport {
  candidateVersion: string;
  productionPolicyVersion: string;
  startedAt: string;
  updatedAt: string;
  candidateIntents: number;
  incrementalIntents: number;
  productionCaughtUp: number;
  meanProductionDelayMs: number | null;
  modelledMakerIntents: number;
  resolvedIntents: number;
  resolvedWindows: number;
  resolvedIncrementalIntents: number;
  resolvedIncrementalWindows: number;
  meanAskProfitPerContract: number | null;
  meanMakerExpectedProfitPerContract: number | null;
  meanIncrementalAskProfitPerContract: number | null;
  meanIncrementalMakerExpectedProfitPerContract: number | null;
  incrementalAskStandardError: number | null;
  minimumReviewWindows: number;
  reviewReady: boolean;
  productionChanged: false;
  recent: PersistenceCandidateIntent[];
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

export interface EntryExecutionObservation {
  at: string;
  event: 'paper_submitted' | 'paper_fill' | 'paper_expired' | 'create_quote' | 'create_rejected'
    | 'accepted' | 'management_quote' | 'amend_accepted' | 'amend_rejected'
    | 'cancel_requested' | 'cancel_confirmed' | 'terminal_fill';
  selectedBid?: number;
  selectedAsk?: number;
  spread?: number;
  limitPrice?: number;
  displayedAtLimit?: number;
  displayedAhead?: number;
  bestBidDepth?: number;
  bestAskDepth?: number;
  depthImbalance?: number;
  filledCount?: number;
  remainingCount?: number;
  cancellationLatencyMs?: number;
  restingDurationMs?: number;
  touched?: boolean;
  reason?: string;
}

export interface PositionLifecycleObservation {
  at: string;
  selectedBid: number;
  selectedAsk: number;
  spread: number;
  bestBidDepth?: number;
  bestAskDepth?: number;
  depthImbalance?: number;
  netLiquidationCents: number;
  exitFeeCents: number;
  exactCostCents: number;
  unrealizedPnlCents: number;
  unrealizedReturn: number;
  ownedSideProbability: number;
  confidence: number;
  basisPercent?: number;
  cycleRegime?: CycleRegimeLabel;
  secondsRemaining: number;
}

export interface PaperOrder {
  id: string;
  /** Paper runs continuously as a shadow; live only runs while automation is active in live mode. */
  executionMode: ExecutionMode;
  /** Absent on records written before markets were explicit; those belong to `crypto-15m`. */
  marketId?: MarketId;
  /**
   * Absent on records written before strategies were explicit; those belong to `edge-binary-buy`, which
   * was the only thing trading. Read it through `orderStrategyId` rather than directly: an unattributed
   * long-shot order would land inside the edge policy's lifetime loss breaker.
   */
  strategyId?: StrategyId;
  /**
   * Live budget epoch this order was placed under, so a later reconfiguration cannot reattribute its P&L.
   *
   * Live orders only. Paper orders written before 2026-08-17 also carry it, copied from the live control
   * by a `buildOrder` that did not distinguish the tracks; that stamp is ignored for paper, which reads
   * `paperBankrollId` instead. Those records are evidence and are never rewritten.
   */
  budgetEpochId?: string;
  /**
   * Paper bankroll funding this order was placed under, minted by a reset. Absent means the original
   * bankroll. Paper orders only — the two budgets are opened by different acts and must not share an
   * identity. See docs/paper-bankroll-fundings-design.md.
   */
  paperBankrollId?: string;
  /**
   * Path-regime label at the moment of entry, recorded so cohort analysis does not require rejoining a
   * 210MB forecast snapshot. Observation-only for live; paper additionally refuses unclassified windows.
   */
  entryCycleRegime?: CycleRegimeLabel;
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
  /** Paper maker simulation: the order rests until this instant, then goes unfilled. */
  restingUntil?: string;
  /** When a maker attempt became terminal; retry cooldown starts after cancellation, not submission. */
  makerCompletedAt?: string;
  settlementAverageEstimate?: SettlementAverageEstimate;
  /** Legacy entry price retained for compatibility. New orders keep this as the issuance ask. */
  askPrice: number;
  bidPrice: number;
  spread: number;
  issuanceAskPrice?: number;
  issuanceBidPrice?: number;
  issuanceSpread?: number;
  approvedMaximumPrice?: number;
  initialSubmittedPrice?: number;
  authoritativeFillPrice?: number;
  entryExecutionObservations?: EntryExecutionObservation[];
  positionObservations?: PositionLifecycleObservation[];
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
  /**
   * Separate authoritative-fill overlay for a contemporaneous paper intent. It never changes the
   * independent paper status or bankroll; analysts can compare this result with the queue simulation
   * without pretending live selection/fill evidence was available to every paper signal.
   */
  matchedLiveFill?: {
    version: 'matched-live-fill-shadow-v1';
    liveOrderId: string;
    liveVenueOrderId?: string;
    capturedAt: string;
    quantity: number;
    fillPrice: number;
    purchaseCents: number;
    feeCents: number;
    stakeCents: number;
  };
  /** Reverse link retained on the live record when a contemporaneous paper intent existed. */
  matchedPaperOrderId?: string;
  /**
   * All-in cents actually reserved from the budget at issuance, before any fill revised `stakeCents`
   * down to what the maker really paid. This is the operator's authorization ceiling, so it is what
   * reconciliation compares a recovered venue fill cost against. It is deliberately its own field:
   * the guard previously read `shadowTakerAllInCents`, which holds the same number today only because
   * the taker shadow is currently priced from the issuance stake. That is a reporting field, and a
   * change to how the taker counterfactual is priced must not silently move a fail-closed safety
   * threshold. Absent on orders issued before this field existed; see the fallback in
   * `reconcileExecutionLedger`.
   */
  reservedStakeCents?: number;
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
  standaloneExitPolicy?: StandaloneExitPolicy;
  standaloneExitAttemptedAt?: string;
  standaloneExitHoldValueCents?: number;
  standaloneExitOptimisticHoldValueCents?: number;
  /** Reduce-only close terms when a position is sold before settlement or to fund a superior candidate. */
  exitClientOrderId?: string;
  exitRequestedAt?: string;
  exitPending?: boolean;
  exitVenueOrderId?: string;
  /**
   * Long-shot policy exit target in force for this position, recorded so a later mark change cannot be
   * mistaken for the one this order actually traded under.
   */
  exitTargetCents?: number;
  /**
   * Policy version this order was placed under, derived from the settings that define a cohort. Read by
   * the report so a parameter change starts a fresh cohort instead of blending two rule sets.
   */
  strategyPolicyVersion?: string;
  /**
   * Ask at the first look that qualified, before trailing waited for the fall to stall.
   *
   * Kept beside the achieved fill so what trailing earned is measurable rather than assumed at the 2.1¢
   * median measured retrospectively at fifteen-second spacing.
   */
  firstTouchAskCents?: number;
  /** Looks taken while trailing before buying. One means it stalled immediately. */
  trailingLooks?: number;
  /**
   * Entry generation within this asset and settlement window; 1 is the first, above 1 is a re-entry.
   *
   * A re-entry can only follow a profitable exit, so it carries direct evidence that this window whipsaws
   * — a fresher version of what the rejected prior-cycle filter was reaching for. Tagged so that
   * hypothesis stays testable rather than buried in a blended average.
   */
  entryGeneration?: number;
  /**
   * Highest owned-side bid observed while this position was open, sampled every two seconds.
   *
   * Recorded on every tick rather than only on a fill: it is what lets every candidate exit mark be
   * evaluated from one dataset afterwards. Without it the only recoverable fact is whether the single
   * mark in force was reached, and re-choosing the mark would need another month of collection.
   */
  peakOwnedSideBidCents?: number;
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
  /** Authoritative live fills overlaid on contemporaneous paper intents, never mixed into paper P&L. */
  matchedLivePaper: {
    matchedIntents: number;
    independentPaperFills: number;
    liveOnlyFills: number;
    bothFilled: number;
    meanMatchedQuantity: number | null;
    meanLiveFillPrice: number | null;
  };
  adaptiveExecution: {
    policyVersion: string;
    shadowEvaluations: number;
    takerRecommendations: number;
    resolvedTakerRecommendations: number;
    resolvedTakerWindows: number;
    /** Window-clustered return; repeated assets and attempts in one settlement window are not independent. */
    meanTakerCounterfactualReturn: number | null;
    takerCounterfactualReturnStandardError: number | null;
    pairedMakerComparisonWindows: number;
    meanTakerAdvantageOverMaker: number | null;
    takerAdvantageOverMakerStandardError: number | null;
    /** Prospective cohort under the currently active buy policy; historical policy mixtures are context only. */
    currentPolicy: {
      buyPolicyVersion: string;
      recommendations: number;
      resolvedRecommendations: number;
      resolvedWindows: number;
      meanTakerCounterfactualReturn: number | null;
      takerCounterfactualReturnStandardError: number | null;
      meanTakerAdvantageOverMaker: number | null;
      takerAdvantageOverMakerStandardError: number | null;
    };
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
  executionAudit: {
    attemptsWithPath: number;
    attemptsWithDepth: number;
    repricedAttempts: number;
    meanDisplayedAhead: number | null;
    cancellationsObserved: number;
    meanCancellationLatencyMs: number | null;
    meanRestingDurationMs: number | null;
    positionsObserved: number;
    positionSnapshots: number;
  };
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

/**
 * Forecast scoring served whole. Every field measures the calculation rather than the money and is
 * identical for a signed operator and a public reader, so calibration, benchmarks, segments, lead-time
 * slices, and the missed-buy counterfactual are all public. Only `recent` is narrowed: the private
 * summary carries entire forecast records there, including factor weights and contract provenance.
 */
export type PublicPerformanceSummary = Omit<PerformanceSummary, 'recent'> & { recent: ForecastHistoryRow[] };

/**
 * Paper-only track record exposed without a signed dashboard session. This is the signed performance
 * payload minus three surfaces: `liveRecord`; the maker-fill report, which is built exclusively from
 * live Kalshi orders; and the walk-forward evaluation history, which carries the fitted model
 * parameters. Results are published, the model that produced them is not — unlike the buy thresholds,
 * which the public policy version already states, weights such as basis weight, temperature, and
 * volatility scale appear nowhere else and have no reader value.
 */
export interface PublicPaperPerformance {
  /** False when neither a local ledger nor a replicated projection is available to report. */
  durable: boolean;
  generatedAt: string;
  summary: PublicPerformanceSummary;
  /** Complete paper record, including segment breakdowns and switch/exit counterfactuals. */
  paperRecord: TradeTrackRecord;
  /** Paper split per provider. The live split is never published. */
  paperProviderRecords: ProviderTradeRecord[];
  /**
   * Paper's funding history, one entry per bankroll reset. Paper only — live's fundings describe real
   * money and are never published.
   */
  paperEpochs?: EpochResult[];
  forecasts: ForecastHistoryRow[];
  cyclePaths?: CyclePathReport;
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
  /**
   * The P&L that reconciles with the budget figures beside it: `startingCents + realizedPnlCents`
   * equals equity. Its scope differs per track and is stated in `pnlScope`, because the two budgets
   * mean different things — live's was re-funded and counts from that epoch, paper's never has been.
   *
   * Whole-cent throughout. These sit next to budget figures, and the budget counters accumulate
   * `payoutCents - stakeCents` in whole cents, so summing the exact `actualPnlCents` here would make
   * the panel disagree with itself. The exact view belongs in performance reporting.
   */
  realizedPnlCents: number;
  /** Every settled order on this track, whichever budget epoch funded it. Never reconciles with equity. */
  lifetimePnlCents: number;
  /** What `realizedPnlCents` covers, so the two figures can never be read as the same quantity. */
  pnlScope: 'budget-epoch' | 'lifetime';
  /**
   * When the funding behind `realizedPnlCents` opened, so the figure and the equity beside it can be
   * read against the moment they count from. Absent when the record holds no opening timestamp — as
   * paper's original bankroll does not — and never inferred, because a guessed date misattributes
   * every figure shown with it. Present independently of `pnlScope`: paper's P&L counts from its
   * bankroll funding while still spanning that bankroll's whole life.
   */
  epochStartedAt?: string;
  /**
   * Earliest order covered by `realizedPnlCents`, scoped the same way it is. The only anchor available
   * for a funding that predates stamping — paper's original bankroll — and reported as a first trade,
   * never as a funding moment: the record does not contain when that bankroll was opened.
   */
  fundingFirstOrderAt?: string;
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
