import type {
  EntryDecisionSnapshot, ExecutionMode, PaperOrderStatus, PortfolioDecisionState, PositionSide, StrategyId,
  TradingProviderId,
} from './types';
import type { PortfolioConstraints } from './portfolio-policy';
import type { SignalObservation } from './signal-persistence';

export const PORTFOLIO_CHOICE_SET_VERSION = 'portfolio-choice-set-v1' as const;

export interface PortfolioChoiceSetExposure {
  orderId: string;
  strategyId: StrategyId;
  symbol: string;
  side: PositionSide;
  closesAt: string;
  status: PaperOrderStatus;
}

export type PortfolioDrainDisposition =
  | 'issued'
  | 'issued-earlier'
  | 'skipped-earlier'
  | 'pending'
  | 'not-selected'
  | 'not-ready';

export interface PortfolioChoiceSetCandidate {
  id: string;
  symbol: string;
  contractId?: string;
  side: PositionSide;
  closesAt: string;
  selectedSideProbability: number;
  confidence: number;
  actionableAsk?: number;
  actionableBid?: number;
  feeRate?: number;
  netEdge?: number;
  spread?: number;
  persistenceObservations?: SignalObservation[];
  eligibility?: { eligible: boolean; reason: string; qualifyingSnapshots: number; medianNetEdge: number | null; edgeSpike: number | null };
  retry?: { allowed: boolean; attemptNumber: number; reason: string; retryOfOrderId?: string };
  cooldownRemainingMs: number;
  assetAdmitted: boolean;
  cycleRegime?: string;
  regimeAdmitted: boolean;
  /** Combined asset and classified-regime filters used before the live drain. */
  liveFiltersAdmitted: boolean;
  portfolioState: PortfolioDecisionState;
  portfolioReason: string;
  sizingPolicyVersion?: string;
  sizingMultiplier?: number;
  quantity?: number;
  stakeCents?: number;
  feeCents?: number;
  potentialPayoutCents?: number;
  expectedProfitCents?: number;
  adjustedExpectedContributionCents?: number;
  rank?: number;
  initiallySelected: boolean;
  executionReady: boolean;
  drainDisposition: PortfolioDrainDisposition;
  drainReason?: string;
  outcome?: PositionSide;
  resolvedAt?: string;
}

export interface PortfolioChoiceSetRecord {
  id: string;
  version: typeof PORTFOLIO_CHOICE_SET_VERSION;
  recordedAt: string;
  calculationAt: string;
  drainSequence: number;
  strategyId: StrategyId;
  executionMode: Extract<ExecutionMode, 'live'>;
  marketId: string;
  providerId: TradingProviderId;
  providerVariantId?: string;
  forecastModelVersion?: string;
  buyPolicyVersion: string;
  executionPolicyVersion?: string;
  sizingPolicyVersion?: string;
  issuedOrderId: string;
  issuedLogicalOrderId: string;
  issuedCandidateId: string;
  issuedEntryDecision: EntryDecisionSnapshot;
  issuedReservedStakeCents: number;
  proposedStakeCents: number;
  maximumLiveStakeCents: number;
  providerSpendableCents: number;
  effectiveStakeCeilingCents: number;
  adaptiveRegimeGate: { phase: string; allowsEntries: boolean; policyVersion: string; reason: string };
  classifiedRegimeRequired: boolean;
  liveControl: { revision: number; state: string; mode: string };
  liveOperationalReady: true;
  constraints: PortfolioConstraints;
  exposures: PortfolioChoiceSetExposure[];
  priorDrainActions: Array<{ candidateId: string; action: 'issued' | 'skipped'; reason: string }>;
  candidates: PortfolioChoiceSetCandidate[];
}

export type PortfolioChoiceSetEvent =
  | { op: 'decision'; value: PortfolioChoiceSetRecord }
  | { op: 'resolution'; recordId: string; candidateId: string; outcome: PositionSide; resolvedAt: string };

/** First decision wins; settlement may patch only one candidate's outcome once. */
export function replayPortfolioChoiceSetEvents(
  initial: PortfolioChoiceSetRecord[], events: PortfolioChoiceSetEvent[],
): PortfolioChoiceSetRecord[] {
  const byId = new Map(initial.map((record) => [record.id, record]));
  for (const event of events) {
    if (event.op === 'decision') {
      if (event.value?.id && !byId.has(event.value.id)) byId.set(event.value.id, event.value);
      continue;
    }
    const record = byId.get(event.recordId);
    if (!record) continue;
    const index = record.candidates.findIndex((candidate) => candidate.id === event.candidateId);
    if (index < 0 || record.candidates[index].resolvedAt) continue;
    const candidates = record.candidates.map((candidate, candidateIndex) => candidateIndex === index
      ? { ...candidate, outcome: event.outcome, resolvedAt: event.resolvedAt }
      : candidate);
    byId.set(record.id, { ...record, candidates });
  }
  return [...byId.values()];
}

interface Pair { closesAt: string; issuedReturn: number; preferredReturn: number; sameChoice: boolean }
export interface PortfolioChoiceSetReport {
  records: number;
  integrityFailures: number;
  unresolvedRecords: number;
  scoreableRecords: number;
  independentWindows: number;
  sameChoiceRecords: number;
  differingChoiceRecords: number;
  issuedMean: number | null;
  preferredMean: number | null;
  differenceMean: number | null;
  differenceStandardError: number | null;
  diagnosticReviewReady: boolean;
  differingChoiceReviewReady: boolean;
}

function candidateReturn(candidate: PortfolioChoiceSetCandidate): number | undefined {
  if (!candidate.outcome || !(candidate.stakeCents && candidate.stakeCents > 0)
    || !(candidate.potentialPayoutCents && candidate.potentialPayoutCents > 0)) return undefined;
  return (candidate.outcome === candidate.side ? candidate.potentialPayoutCents : 0) / candidate.stakeCents - 1;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function buildPortfolioChoiceSetReport(records: PortfolioChoiceSetRecord[]): PortfolioChoiceSetReport {
  let integrityFailures = 0;
  let unresolvedRecords = 0;
  let sameChoiceRecords = 0;
  const pairs: Pair[] = [];
  for (const record of records) {
    const issued = record.candidates.find((candidate) => candidate.id === record.issuedCandidateId
      && candidate.drainDisposition === 'issued');
    if (!issued || record.candidates.filter((candidate) => candidate.drainDisposition === 'issued').length !== 1) {
      integrityFailures += 1;
      continue;
    }
    const preferred = record.candidates
      .filter((candidate) => candidate.initiallySelected && candidate.executionReady
        && (candidate.drainDisposition === 'issued' || candidate.drainDisposition === 'pending'))
      .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))[0];
    if (!preferred) { integrityFailures += 1; continue; }
    const issuedReturn = candidateReturn(issued);
    const preferredReturn = candidateReturn(preferred);
    if (issuedReturn === undefined || preferredReturn === undefined) { unresolvedRecords += 1; continue; }
    if (issued.id === preferred.id) sameChoiceRecords += 1;
    pairs.push({ closesAt: issued.closesAt, issuedReturn, preferredReturn, sameChoice: issued.id === preferred.id });
  }
  const clustered = new Map<string, Pair[]>();
  for (const pair of pairs) clustered.set(pair.closesAt, [...(clustered.get(pair.closesAt) ?? []), pair]);
  const windows = [...clustered.values()].map((items) => ({
    issued: mean(items.map((item) => item.issuedReturn))!,
    preferred: mean(items.map((item) => item.preferredReturn))!,
    difference: mean(items.map((item) => item.issuedReturn - item.preferredReturn))!,
    differing: items.some((item) => item.issuedReturn !== item.preferredReturn),
  }));
  const differences = windows.map((window) => window.difference);
  const differenceMean = mean(differences);
  const differenceStandardError = differences.length > 1 && differenceMean !== null
    ? Math.sqrt(differences.reduce((sum, value) => sum + (value - differenceMean) ** 2, 0)
      / (differences.length - 1) / differences.length)
    : null;
  const differingChoiceRecords = pairs.length - sameChoiceRecords;
  const differingWindows = new Set(pairs.filter((pair) => !pair.sameChoice).map((pair) => pair.closesAt)).size;
  return {
    records: records.length, integrityFailures, unresolvedRecords, scoreableRecords: pairs.length,
    independentWindows: windows.length, sameChoiceRecords, differingChoiceRecords,
    issuedMean: mean(windows.map((window) => window.issued)),
    preferredMean: mean(windows.map((window) => window.preferred)),
    differenceMean, differenceStandardError,
    diagnosticReviewReady: windows.length >= 30,
    differingChoiceReviewReady: windows.length >= 60 && differingWindows >= 20,
  };
}
