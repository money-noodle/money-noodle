// The paper dashboard as this API publishes it.
//
// These are the published views, kept apart from `paper-projection.ts`, which is
// the projection's own shape. The separation is the reason this file exists: the
// stored record belongs to a separate system and may change, and a rendering
// convenience must never become the stored meaning (ADR-0012). Mapping between
// the two happens in `read-paper-budget.ts` and `read-paper-performance.ts`,
// field by field and in one direction.
//
// Everything here is read-only simulation. No type in this file describes a
// funded position, an order to place, or an authority to act, and adding one
// would be a change of authority rather than a change of code.
//
// Parity with v1 is deliberate and occasionally uncomfortable. Where the source
// computes a figure oddly — a win rate whose denominator includes void and
// early-exited positions, two different realized-profit numbers that are not
// expected to agree — the oddity is carried through and documented rather than
// corrected, so this API and the system that produced the data cannot disagree
// about what a number means. The OpenAPI document is where those notes live for
// clients; the ones that would surprise a reader of this code are repeated here.

/** Amounts are US cents, possibly fractional, possibly negative. */
export type Cents = number;

/** A fraction, never a percentage: 0.42 is 42%. */
export type Ratio = number;

/** An instant the source recorded, as ISO-8601 UTC. Never this service's clock. */
export type SourceTime = string;

export interface PublishedExecution {
  readonly askPrice: Ratio;
  readonly closesAt: SourceTime;
  readonly createdAt: SourceTime;
  readonly executionKey: string;
  readonly feeCents: Cents;
  /** Absent, not null, when the source recorded none. The source's own distinction. */
  readonly liquidityRole?: 'maker' | 'taker';
  readonly noFillReason?: string;
  readonly outcome?: 'DOWN' | 'UP';
  readonly pnlCents?: Cents;
  readonly quantity: number;
  readonly side: 'DOWN' | 'UP';
  readonly stakeCents: Cents;
  /** Lifecycle state. Unconstrained upstream, so an unknown value is served as it is. */
  readonly status: string;
  readonly symbol: string;
  readonly venue: 'kalshi' | 'polymarket';
}

export interface PublishedBudget {
  readonly availableCents: Cents;
  readonly bankrollResets: number;
  readonly depleted: boolean;
  /** Always true: the record came from the durable read model, the only source here. */
  readonly durable: true;
  readonly equityCents: Cents;
  readonly openOrders: number;
  readonly proposedStakeCents: Cents;
  /**
   * Current funding only, whole-cent accounting, including recorded corrections.
   * Deliberately a different number from the track record's lifetime exact one.
   */
  readonly realizedPnlCents: Cents;
  readonly recentExecutions: readonly PublishedExecution[];
  readonly reservedCents: Cents;
  readonly running: boolean;
  readonly settledOrders: number;
  /** Additive to v1, which hid it: freshness is disclosed, never judged here. */
  readonly sourceUpdatedAt: SourceTime;
  readonly startingCents: Cents;
}

export interface PublishedForecast {
  readonly confidence: Ratio;
  readonly correct?: boolean;
  readonly direction: string;
  readonly directionalLikelihood: Ratio;
  readonly id: string;
  readonly issuedAt: SourceTime;
  readonly modelVersion: string;
  readonly outcome?: string;
  readonly policyVersion: string;
  readonly status: string;
  readonly symbol: string;
}

export interface PublishedForecastSignalSummary {
  readonly accuracy: Ratio | null;
  readonly brierScore: number | null;
  readonly calibrationMinimum: number;
  readonly calibrationProgress: Ratio;
  readonly calibrationReady: boolean;
  readonly calibrationWindows: number;
  readonly currentCycleStreak: number;
  readonly cycleBalancedAccuracy: Ratio | null;
  readonly cycles: number;
  readonly issued: number;
  readonly recent: readonly PublishedForecast[];
  readonly resolved: number;
  readonly resolvedCycles: number;
}

export interface PublishedTrackSummary {
  readonly meanPredictedEdge: Ratio | null;
  readonly meanRealizedReturn: number | null;
  readonly mode: 'paper';
  readonly realizedPnlCents: Cents;
  readonly roi: Ratio | null;
  readonly settled: number;
  readonly windows: number;
  /** Wins over settled, and settled includes void and early-exited positions. */
  readonly winRate: Ratio | null;
  readonly losses: number;
  readonly wins: number;
}

export interface PublishedPerformanceSummary {
  readonly durable: true;
  /** When the source last computed this summary, on its own clock. */
  readonly generatedAt: SourceTime;
  readonly paperRecord: PublishedTrackSummary;
  /** When the stored row was last written, which is more often than the above. */
  readonly sourceUpdatedAt: SourceTime;
  readonly summary: PublishedForecastSignalSummary;
}

export interface PublishedForecastSlice {
  readonly accuracy: Ratio;
  readonly correct: number;
  readonly label: string;
  readonly resolved: number;
}

export interface PublishedLeadTimeSlice extends PublishedForecastSlice {
  readonly brierScore: number | null;
}

export interface PublishedCalibrationBin {
  readonly label: string;
  readonly meanForecast: Ratio;
  readonly observedRate: Ratio;
  readonly resolved: number;
}

export interface PublishedBenchmarkScore {
  readonly accuracy: Ratio | null;
  readonly brierScore: number | null;
  readonly label: string;
  readonly logLoss: number | null;
  readonly resolved: number;
}

export interface PublishedEdgeBucket {
  readonly label: string;
  readonly predictedEdge: Ratio;
  readonly realizedReturn: number;
  readonly trades: number;
  readonly winRate: Ratio;
}

export interface PublishedSegmentStat {
  readonly label: string;
  readonly meanPredictedEdge: Ratio;
  /** Nullable by necessity: the source can compute this as not-a-number. */
  readonly meanRealizedReturn: number | null;
  readonly standardError: number | null;
  readonly trades: number;
  readonly windows: number;
  readonly winRate: Ratio;
}

export interface PublishedSegmentGroup {
  readonly description: string;
  readonly dimension: string;
  readonly segments: readonly PublishedSegmentStat[];
}

export interface PublishedMissedBuyCounterfactual {
  readonly bestPerWindowCandidates: number;
  readonly bestPerWindowMeanReturn: number | null;
  readonly bestPerWindowStandardError: number | null;
  readonly bestPerWindowTotalReturn: number | null;
  readonly bestPerWindowWins: number;
  readonly candidates: number;
  readonly description: string;
  readonly label: string;
  readonly meanCandidateReturn: number | null;
  readonly profitableCandidates: number;
  readonly standardError: number | null;
  readonly windows: number;
}

export interface PublishedTimelinePoint {
  readonly cumulativeAccuracy: Ratio;
  readonly cumulativeBrier: number;
  readonly resolved: number;
  readonly rollingAccuracy: Ratio;
  readonly time: SourceTime;
}

export interface PublishedForecastRecordSummary {
  readonly accuracy: Ratio | null;
  readonly benchmarks: readonly PublishedBenchmarkScore[];
  readonly brierScore: number | null;
  readonly byAsset: readonly PublishedForecastSlice[];
  readonly byConfidenceBucket: readonly PublishedForecastSlice[];
  readonly byDirection: readonly PublishedForecastSlice[];
  readonly byLeadTime: readonly PublishedLeadTimeSlice[];
  readonly byModelVersion: readonly PublishedForecastSlice[];
  readonly calibrationBins: readonly PublishedCalibrationBin[];
  readonly calibrationMinimum: number;
  readonly calibrationProgress: Ratio;
  readonly calibrationReady: boolean;
  readonly calibrationWindows: number;
  readonly correct: number;
  readonly currentCycleStreak: number;
  readonly currentStreak: number;
  readonly cycleBalancedAccuracy: Ratio | null;
  readonly cycles: number;
  readonly edgeBuckets: readonly PublishedEdgeBucket[];
  readonly evaluationMeaningful: boolean;
  readonly evaluationMinimumWindows: number;
  readonly invalid: number;
  readonly issued: number;
  readonly logLoss: number | null;
  readonly meanPredictedEdge: Ratio | null;
  readonly meanRealizedReturn: number | null;
  readonly missedBuyCounterfactual: PublishedMissedBuyCounterfactual;
  readonly observedCalculations: number;
  readonly pending: number;
  readonly realizedEdgeTrades: number;
  readonly recent: readonly PublishedForecast[];
  readonly resolved: number;
  readonly resolvedCalculations: number;
  readonly resolvedCycles: number;
  readonly resolvedWindows: number;
  readonly segments: readonly PublishedSegmentGroup[];
  readonly timeline: readonly PublishedTimelinePoint[];
}

export interface PublishedActionCounterfactualArm {
  readonly action: string;
  readonly alternative: string;
  readonly alternativePnlCents: Cents;
  readonly basis: string;
  readonly credible: boolean;
  readonly decisions: number;
  readonly decisionsBeatingAlternative: number;
  readonly description: string;
  readonly hitRate: Ratio | null;
  readonly incrementalCents: Cents;
  readonly incrementalReturnStandardError: number | null;
  readonly meanIncrementalCents: number | null;
  readonly meanIncrementalReturn: number | null;
  readonly policy: string;
  readonly takenPnlCents: Cents;
  readonly windows: number;
}

export interface PublishedTrackRecord {
  readonly actionCounterfactuals: readonly PublishedActionCounterfactualArm[];
  readonly actionCounterfactualVersion: string;
  readonly invalid: number;
  readonly losses: number;
  readonly meanPredictedEdge: Ratio | null;
  readonly meanPrincipalRecoveryVsFullExitCents: number | null;
  readonly meanRealizedReturn: number | null;
  readonly meanSwitchVsHoldCents: number | null;
  readonly mode: 'paper';
  readonly pending: number;
  readonly principalRecoveryExitsEvaluated: number;
  readonly principalRecoveryVsFullExitCents: number | null;
  readonly realizedPnlCents: Cents;
  readonly rejected: number;
  readonly returnedCents: Cents;
  readonly roi: Ratio | null;
  readonly segments: readonly PublishedSegmentGroup[];
  readonly settled: number;
  readonly sold: number;
  readonly stakedCents: Cents;
  readonly standaloneExitsEvaluated: number;
  readonly standardError: number | null;
  readonly switchesEvaluated: number;
  readonly unfilled: number;
  readonly windows: number;
  readonly winRate: Ratio | null;
  readonly wins: number;
}

export interface PublishedProviderTrackRecord {
  readonly marketId: string;
  readonly providerId: string;
  readonly record: PublishedTrackRecord;
}

export interface PublishedBankrollEpoch {
  readonly budgetPnlCents: Cents;
  readonly current: boolean;
  readonly epochId: string;
  readonly firstAt?: SourceTime;
  readonly lastAt?: SourceTime;
  readonly realizedPnlCents: Cents;
  readonly settled: number;
  readonly stakedCents: Cents;
  readonly trades: number;
}

export interface PublishedCycleRegimeFeatures {
  readonly coverageSeconds: number;
  readonly lagOneAutocorrelation: number | null;
  readonly localVolatility15mPercent: number | null;
  readonly localVolatilityPerSecond: number | null;
  /** Percent units, not a ratio: 0.12 means 0.12%. Absent on older records. */
  readonly netChangePercent?: number | null;
  readonly observationCount: number;
  readonly observedAt: SourceTime;
  /** Percent units, as above. */
  readonly rangePercent: number | null;
  readonly regime: string;
  readonly signedTrendEfficiency?: number | null;
  readonly signFlipRate: Ratio | null;
  readonly trendEfficiency: Ratio | null;
}

export interface PublishedCyclePathLatest {
  readonly closesAt: SourceTime;
  readonly features: PublishedCycleRegimeFeatures;
  readonly symbol: string;
}

export interface PublishedCyclePathReport {
  readonly completedCycles: number;
  readonly latestByAsset: readonly PublishedCyclePathLatest[];
  readonly policyVersion: string;
  readonly totalCycles: number;
  readonly totalPoints: number;
}

export interface PublishedPerformance {
  readonly cyclePaths?: PublishedCyclePathReport;
  readonly durable: true;
  /** When the source last replaced the full document. Not the row's write time. */
  readonly generatedAt: SourceTime;
  readonly forecasts: readonly PublishedForecast[];
  readonly paperEpochs: readonly PublishedBankrollEpoch[];
  readonly paperProviderRecords: readonly PublishedProviderTrackRecord[];
  readonly paperRecord: PublishedTrackRecord;
  readonly sourceUpdatedAt: SourceTime;
  readonly summary: PublishedForecastRecordSummary;
}

/**
 * The executions a budget read publishes.
 *
 * The source replaces its execution list whole on every budget write and never
 * keeps more than this, so the bound is the whole recent history rather than a
 * page of a longer one. Stated here because it is a property of the published
 * contract, not of the query that happens to fetch it.
 */
export const PUBLISHED_EXECUTION_LIMIT = 30;

/** The most recent forecasts a bounded summary publishes. */
export const PUBLISHED_RECENT_FORECAST_LIMIT = 4;
