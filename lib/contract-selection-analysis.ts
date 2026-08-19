import { estimatePaperFill } from './venue-fill';
import { venueFeeFraction } from './venue-fee-schedule';
import { selectPortfolio, type PortfolioConstraints, type PortfolioExposure } from './portfolio-policy';
import {
  advanceSignalPersistence, evaluateSignalPersistenceWithRequirements,
  type SignalPersistenceRequirements, type SignalPersistenceState,
} from './signal-persistence';
import type { PositionSide } from './types';

/**
 * Pure, read-only reconstruction for `scripts/analyze-contract-selection.mjs`.
 *
 * This module deliberately supports only policy v17-v19. Their 3/2/1 portfolio limits, one-attempt live
 * retry state, and 3-over-30 persistence rule are known from the source that ran those cohorts. Later
 * cohorts have changed runtime cap overrides that were not stamped on forecast rows; treating today's
 * environment as historical truth would manufacture an exact replay.
 */

export interface ContractSelectionForecastRow {
  id: string;
  symbol: string;
  closesAt: string;
  issuedAt: string;
  policyVersion?: string;
  status?: string;
  outcome?: PositionSide;
  entryVenue?: 'polymarket' | 'kalshi';
  evaluationVenue?: 'polymarket' | 'kalshi';
  targetIntegrity?: string;
  probabilityUp: number;
  confidence?: number;
  actionableVenuePrices?: Array<{ venue: 'polymarket' | 'kalshi'; side: PositionSide; price: number }>;
  cycleRegime?: { regime?: string };
}

export interface ContractSelectionOrder {
  id: string;
  strategyId?: string;
  executionMode: 'paper' | 'live';
  symbol: string;
  side: PositionSide;
  closesAt: string;
  createdAt: string;
  calculationAt: string;
  status: string;
  makerCompletedAt?: string;
  settledAt?: string;
  filledCount?: number;
  actualStakeCents?: number;
  stakeCents: number;
  reservedStakeCents?: number;
  shadowTakerAllInCents?: number;
  shadowTakerQuantity?: number;
  quantity: number;
  potentialPayoutCents: number;
  modelProbabilityUp: number;
  entryCycleRegime?: string;
  entryDecision?: {
    policyVersion: string;
    calculationAt: string;
    side: PositionSide;
    selectedSideProbability: number;
    confidence: number;
    actionableAsk: number;
    actionableBid: number;
    feeRate: number;
    netEdge: number;
    spread: number;
  };
}

export interface RegimeGateTransitionRecord {
  at: string;
  to: 'disabled' | 'warming' | 'open' | 'closed';
  policyVersion: string;
}

interface HistoricalPolicy {
  label: string;
  minimumEdge: number;
  maximumEdge: number;
  lateCutoffSeconds: number;
  persistence: SignalPersistenceRequirements;
  constraints: PortfolioConstraints;
}

const LEGACY_CONSTRAINTS: PortfolioConstraints = {
  maximumPositions: 3,
  maximumSameWindow: 2,
  maximumSameGroupPerWindow: 1,
  correlationPenaltyCents: 1,
  sameGroupPenaltyCents: 1,
};

const THREE_OVER_THIRTY = { requiredSnapshots: 3, requiredSpanMs: 30_000 };

export const CONTRACT_SELECTION_POLICIES = new Map<string, HistoricalPolicy>([
  ['buy-binary-edge-net5to35-quality50-owned55-price5to97-v17', {
    label: 'v17', minimumEdge: 0.05, maximumEdge: 0.35, lateCutoffSeconds: 120,
    persistence: { ...THREE_OVER_THIRTY, maximumEdgeSpike: Number.POSITIVE_INFINITY, spikeGateEnabled: false },
    constraints: LEGACY_CONSTRAINTS,
  }],
  ['buy-binary-edge-net5to35-quality50-owned55-price5to97-fresh2pp-v18', {
    label: 'v18', minimumEdge: 0.05, maximumEdge: 0.35, lateCutoffSeconds: 120,
    persistence: { ...THREE_OVER_THIRTY, maximumEdgeSpike: 0.02, spikeGateEnabled: true },
    constraints: LEGACY_CONSTRAINTS,
  }],
  ['buy-binary-edge-net5to35-quality50-owned55-price5to97-v19', {
    label: 'v19', minimumEdge: 0.05, maximumEdge: 0.35, lateCutoffSeconds: 120,
    persistence: { ...THREE_OVER_THIRTY, maximumEdgeSpike: Number.POSITIVE_INFINITY, spikeGateEnabled: false },
    constraints: LEGACY_CONSTRAINTS,
  }],
]);

const feeRate = (venue: 'polymarket' | 'kalshi', price: number) => venueFeeFraction(venue, price, 'taker');
const sideProbability = (row: Pick<ContractSelectionForecastRow, 'probabilityUp'>, side: PositionSide) =>
  side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
const decisionId = (symbol: string, closesAt: string, side: PositionSide) => `${symbol}|${closesAt}|${side}`;
const assetWindow = (symbol: string, closesAt: string) => `${symbol}|${closesAt}`;
const finiteTime = (value: string | undefined) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
};

interface EntryOption {
  venue: 'polymarket' | 'kalshi';
  side: PositionSide;
  price: number;
  probability: number;
  feeRate: number;
  netEdge: number;
}

function entryOptions(row: ContractSelectionForecastRow): EntryOption[] {
  return (row.actionableVenuePrices ?? []).flatMap((quote) => {
    if (!(quote.price > 0) || quote.price >= 1) return [];
    const probability = sideProbability(row, quote.side);
    const fee = feeRate(quote.venue, quote.price);
    return [{ ...quote, probability, feeRate: fee, netEdge: probability - quote.price - fee }];
  }).sort((left, right) => right.netEdge - left.netEdge || left.price - right.price || left.side.localeCompare(right.side));
}

function bestEntry(row: ContractSelectionForecastRow, policy: HistoricalPolicy): EntryOption | undefined {
  return entryOptions(row).find((option) => option.price >= 0.05 && option.price <= 0.97
    && option.probability >= 0.55 && option.netEdge < policy.maximumEdge);
}

function sharedQualifies(row: ContractSelectionForecastRow, policy: HistoricalPolicy): boolean {
  const entry = bestEntry(row, policy);
  return (row.confidence ?? 0) >= 0.5 && Boolean(entry && entry.netEdge >= policy.minimumEdge);
}

function kalshiEntry(row: ContractSelectionForecastRow, side: PositionSide, policy: HistoricalPolicy): EntryOption | undefined {
  return entryOptions(row).find((option) => option.venue === 'kalshi' && option.side === side
    && option.price >= 0.05 && option.price <= 0.97 && option.probability >= 0.55
    && option.netEdge >= policy.minimumEdge && option.netEdge < policy.maximumEdge);
}

interface RowPersistence {
  side?: PositionSide;
  state?: SignalPersistenceState;
}

function buildPersistence(rows: ContractSelectionForecastRow[], policy: HistoricalPolicy): Map<string, RowPersistence> {
  const result = new Map<string, RowPersistence>();
  let state: SignalPersistenceState | undefined;
  let currentSide: PositionSide | undefined;
  for (const row of [...rows].sort((left, right) => Date.parse(left.issuedAt) - Date.parse(right.issuedAt))) {
    const entry = bestEntry(row, policy);
    if (!entry) {
      state = undefined;
      currentSide = undefined;
      result.set(row.id, {});
      continue;
    }
    if (currentSide !== entry.side) state = undefined;
    currentSide = entry.side;
    state = advanceSignalPersistence(state, {
      symbol: row.symbol, side: entry.side, closesAt: row.closesAt, calculationAt: row.issuedAt,
      qualifies: sharedQualifies(row, policy), netEdge: entry.netEdge, quality: row.confidence ?? 0,
    });
    result.set(row.id, { side: entry.side, state });
  }
  return result;
}

/** Whether a durable order occupied a global portfolio slot at a historical instant. */
export function orderOccupiesSlotAt(order: ContractSelectionOrder, atMs: number): boolean {
  const createdAt = finiteTime(order.createdAt);
  if (order.executionMode !== 'live' || createdAt === null || createdAt > atMs || order.id.includes(':exit:')) return false;
  if (order.status === 'rejected') return false;
  const filled = (order.filledCount ?? 0) > 0 || (order.actualStakeCents ?? 0) > 0
    || order.status === 'open' || order.status === 'sold' || order.status === 'won' || order.status === 'lost' || order.status === 'invalid';
  if (filled) {
    const terminal = order.status === 'sold' ? finiteTime(order.settledAt) : finiteTime(order.closesAt);
    return terminal === null || atMs < terminal;
  }
  const completedAt = finiteTime(order.makerCompletedAt);
  return completedAt !== null && atMs < completedAt;
}

interface AttemptAvailability { allowed: boolean; persistenceAfter?: number; reason?: 'cooldown' | 'retry' }

/**
 * v17-v19 live allowed one attempt per generation. A completed sale starts a new generation only after
 * the 60-second re-entry cooldown; an unfilled/rejected first generation remains exhausted.
 */
export function historicalAttemptAvailability(
  orders: ContractSelectionOrder[], symbol: string, side: PositionSide, closesAt: string, atMs: number,
): AttemptAvailability {
  const prior = orders.filter((order) => order.executionMode === 'live' && !order.id.includes(':exit:')
    && order.symbol === symbol && order.side === side && order.closesAt === closesAt
    && (finiteTime(order.createdAt) ?? Number.POSITIVE_INFINITY) < atMs)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const sold = prior.filter((order) => order.status === 'sold' && (finiteTime(order.settledAt) ?? Number.POSITIVE_INFINITY) < atMs).at(-1);
  let generationStartedAt = Number.NEGATIVE_INFINITY;
  if (sold) {
    const soldAt = finiteTime(sold.settledAt)!;
    if (atMs < soldAt + 60_000) return { allowed: false, reason: 'cooldown' };
    generationStartedAt = soldAt;
  }
  const generation = prior.filter((order) => (finiteTime(order.createdAt) ?? Number.NEGATIVE_INFINITY) > generationStartedAt);
  return generation.length ? { allowed: false, reason: 'retry' } : { allowed: true, persistenceAfter: generationStartedAt };
}

function adaptiveRegimeAllows(
  transitions: RegimeGateTransitionRecord[], policyVersion: string, atMs: number,
): boolean {
  const latest = transitions.filter((transition) => transition.policyVersion === policyVersion
    && (finiteTime(transition.at) ?? Number.POSITIVE_INFINITY) <= atMs)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1);
  return latest?.to !== 'closed';
}

interface Candidate {
  id: string;
  symbol: string;
  side: PositionSide;
  closesAt: string;
  expectedProfitCents: number;
  askReturn: number;
  source: 'order' | 'forecast-reconstruction';
}

export interface ContractSelectionSnapshotResult {
  policyVersion: string;
  policyLabel: string;
  calculationAt: string;
  closesAt: string;
  chosenIds: string[];
  preferredIds: string[];
  chosenReturn: number;
  preferredReturn: number;
  difference: number;
  sameChoice: boolean;
  chosenAdmittedByReplay: boolean;
  reconstructedCandidates: number;
  exclusions: Record<string, number>;
}

export interface ClusteredSnapshotPairs {
  snapshots: number;
  windows: number;
  chosenMean: number | null;
  preferredMean: number | null;
  differenceMean: number | null;
  differenceStandardError: number | null;
}

/** Cluster paired choice differences on settlement window; snapshots inside one window are not trials. */
export function clusterSnapshotPairs(snapshots: ContractSelectionSnapshotResult[]): ClusteredSnapshotPairs {
  if (!snapshots.length) return {
    snapshots: 0, windows: 0, chosenMean: null, preferredMean: null,
    differenceMean: null, differenceStandardError: null,
  };
  const byWindow = new Map<string, ContractSelectionSnapshotResult[]>();
  for (const snapshot of snapshots) byWindow.set(snapshot.closesAt, [...(byWindow.get(snapshot.closesAt) ?? []), snapshot]);
  const windows = [...byWindow.values()].map((items) => ({
    chosen: items.reduce((sum, item) => sum + item.chosenReturn, 0) / items.length,
    preferred: items.reduce((sum, item) => sum + item.preferredReturn, 0) / items.length,
    difference: items.reduce((sum, item) => sum + item.difference, 0) / items.length,
  }));
  const average = (key: 'chosen' | 'preferred' | 'difference') => windows.reduce((sum, item) => sum + item[key], 0) / windows.length;
  const differenceMean = average('difference');
  const differenceStandardError = windows.length > 1
    ? Math.sqrt(windows.reduce((sum, item) => sum + (item.difference - differenceMean) ** 2, 0) / (windows.length - 1) / windows.length)
    : null;
  return {
    snapshots: snapshots.length, windows: windows.length,
    chosenMean: average('chosen'), preferredMean: average('preferred'),
    differenceMean, differenceStandardError,
  };
}

export interface ContractSelectionAnalysis {
  generatedAt: string;
  supportedPolicies: string[];
  orderSnapshots: number;
  replayedSnapshots: number;
  verifiedSnapshots: number;
  chosenOrders: number;
  chosenAdmittedByReplay: number;
  sameChoiceSnapshots: number;
  snapshots: ContractSelectionSnapshotResult[];
  overall: ClusteredSnapshotPairs;
  byPolicy: Array<{ policyVersion: string; label: string; result: ClusteredSnapshotPairs; sameChoiceSnapshots: number }>;
  exclusions: Record<string, number>;
  limitations: string[];
}

function nearestSnapshotRow(
  rows: ContractSelectionForecastRow[], atMs: number,
): ContractSelectionForecastRow | undefined {
  return rows.filter((row) => {
    const issuedAt = finiteTime(row.issuedAt);
    // `dashboard.generatedAt` is stamped before its forecasts are persisted; permit two seconds of that
    // known clock ordering, but never reach into the next collector observation.
    return issuedAt !== null && issuedAt >= atMs - 30_000 && issuedAt <= atMs + 2_000;
  }).sort((left, right) => Math.abs(Date.parse(left.issuedAt) - atMs) - Math.abs(Date.parse(right.issuedAt) - atMs))[0];
}

function candidateFromOrder(order: ContractSelectionOrder, stakeLimitCents: number, outcome: PositionSide): Candidate | null {
  const decision = order.entryDecision;
  if (!decision) return null;
  const fill = estimatePaperFill(stakeLimitCents, decision.actionableAsk, 'kalshi');
  if (!fill) return null;
  const probability = decision.selectedSideProbability;
  const cost = decision.actionableAsk + decision.feeRate;
  return {
    id: decisionId(order.symbol, order.closesAt, order.side), symbol: order.symbol, side: order.side,
    closesAt: order.closesAt, expectedProfitCents: fill.potentialPayoutCents * probability - fill.stakeCents,
    askReturn: (outcome === order.side ? 1 : 0) / cost - 1, source: 'order',
  };
}

export function analyzeContractSelection(input: {
  forecasts: ContractSelectionForecastRow[];
  orders: ContractSelectionOrder[];
  transitions?: RegimeGateTransitionRecord[];
  generatedAt?: string;
}): ContractSelectionAnalysis {
  const transitions = input.transitions ?? [];
  const exclusions: Record<string, number> = {};
  const exclude = (local: Record<string, number>, reason: string) => {
    local[reason] = (local[reason] ?? 0) + 1;
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
  };

  // Alternatives are priced on Kalshi, so only a venue-specific Kalshi outcome may grade them. Taking
  // whichever row happened to be visited last can silently substitute a Polymarket resolution in the
  // small set of approximately comparable windows where the venues disagree.
  const outcomes = new Map<string, PositionSide>();
  const rowsByAssetWindowPolicy = new Map<string, ContractSelectionForecastRow[]>();
  for (const row of input.forecasts) {
    if ((row.outcome === 'UP' || row.outcome === 'DOWN')
      && row.evaluationVenue === 'kalshi' && row.targetIntegrity === 'venue-specific') {
      outcomes.set(assetWindow(row.symbol, row.closesAt), row.outcome);
    }
    if (!row.policyVersion || !CONTRACT_SELECTION_POLICIES.has(row.policyVersion)) continue;
    const key = `${row.policyVersion}|${assetWindow(row.symbol, row.closesAt)}`;
    rowsByAssetWindowPolicy.set(key, [...(rowsByAssetWindowPolicy.get(key) ?? []), row]);
  }
  for (const rows of rowsByAssetWindowPolicy.values()) rows.sort((left, right) => Date.parse(left.issuedAt) - Date.parse(right.issuedAt));

  const persistenceByRow = new Map<string, RowPersistence>();
  for (const [key, rows] of rowsByAssetWindowPolicy) {
    const policyVersion = key.slice(0, key.indexOf('|'));
    const policy = CONTRACT_SELECTION_POLICIES.get(policyVersion)!;
    for (const [id, state] of buildPersistence(rows, policy)) persistenceByRow.set(id, state);
  }

  const eligibleOrders = input.orders.filter((order) => order.executionMode === 'live'
    && order.strategyId !== 'long-shot-round-trip' && !order.id.includes(':exit:')
    && Boolean(order.entryDecision && CONTRACT_SELECTION_POLICIES.has(order.entryDecision.policyVersion)));
  const snapshotGroups = new Map<string, ContractSelectionOrder[]>();
  for (const order of eligibleOrders) {
    const policyVersion = order.entryDecision!.policyVersion;
    const key = `${policyVersion}|${order.calculationAt}|${order.closesAt}`;
    snapshotGroups.set(key, [...(snapshotGroups.get(key) ?? []), order]);
  }

  const snapshots: ContractSelectionSnapshotResult[] = [];
  let chosenOrders = 0;
  let chosenAdmittedByReplay = 0;

  for (const chosen of snapshotGroups.values()) {
    const first = chosen[0];
    const policyVersion = first.entryDecision!.policyVersion;
    const policy = CONTRACT_SELECTION_POLICIES.get(policyVersion)!;
    const atMs = finiteTime(first.calculationAt);
    const outcome = outcomes.get(assetWindow(first.symbol, first.closesAt));
    if (atMs === null || !outcome) { exclusions.snapshotMissingOutcome = (exclusions.snapshotMissingOutcome ?? 0) + 1; continue; }
    chosenOrders += chosen.length;
    const local: Record<string, number> = {};
    if (!adaptiveRegimeAllows(transitions, policyVersion, atMs)) {
      exclude(local, 'adaptiveRegimeClosed');
      continue;
    }

    const stakeLimit = Math.max(...chosen.map((order) => order.shadowTakerAllInCents
      ?? order.reservedStakeCents ?? order.stakeCents).filter(Number.isSafeInteger));
    if (!Number.isSafeInteger(stakeLimit) || stakeLimit <= 0) { exclude(local, 'missingStakeLimit'); continue; }

    const candidates = new Map<string, Candidate>();
    for (const order of chosen) {
      const orderOutcome = outcomes.get(assetWindow(order.symbol, order.closesAt));
      const candidate = orderOutcome ? candidateFromOrder(order, stakeLimit, orderOutcome) : null;
      if (candidate) candidates.set(candidate.id, candidate);
      else exclude(local, 'chosenTermsUnavailable');
    }

    for (const [key, rows] of rowsByAssetWindowPolicy) {
      if (!key.startsWith(`${policyVersion}|`) || rows[0]?.closesAt !== first.closesAt) continue;
      const row = nearestSnapshotRow(rows, atMs);
      if (!row) { exclude(local, 'noCurrentForecast'); continue; }
      if (row.symbol.toUpperCase() === 'XRP') { exclude(local, 'assetExcluded'); continue; }
      const entry = bestEntry(row, policy);
      if (!entry || !sharedQualifies(row, policy)) { exclude(local, 'currentGate'); continue; }
      const remainingSeconds = (Date.parse(row.closesAt) - atMs) / 1_000;
      const cycleAgeSeconds = 900 - remainingSeconds;
      // The shared evaluator carries today's 30-second cutoff; v17-v19 ran 120 seconds. Apply the stamped
      // historical clock before calling it rather than projecting the current constant backward.
      if (cycleAgeSeconds < 90 || remainingSeconds <= policy.lateCutoffSeconds) { exclude(local, 'executionClock'); continue; }
      if (!row.cycleRegime?.regime || row.cycleRegime.regime === 'insufficient') { exclude(local, 'classifiedRegime'); continue; }
      const kalshi = kalshiEntry(row, entry.side, policy);
      if (!kalshi) { exclude(local, 'kalshiGate'); continue; }
      const opposite = (row.actionableVenuePrices ?? []).find((quote) => quote.venue === 'kalshi' && quote.side !== entry.side);
      const bid = opposite ? 1 - opposite.price : Number.NaN;
      const spread = kalshi.price - bid;
      if (!(bid > 0) || bid > kalshi.price || spread > 0.10 + 1e-9) { exclude(local, 'bookOrSpread'); continue; }
      const persistence = persistenceByRow.get(row.id);
      if (!persistence?.state || persistence.side !== entry.side) { exclude(local, 'persistenceState'); continue; }
      const attempt = historicalAttemptAvailability(input.orders, row.symbol, entry.side, row.closesAt, atMs);
      if (!attempt.allowed) { exclude(local, attempt.reason === 'cooldown' ? 'reentryCooldown' : 'retryExhausted'); continue; }
      const eligibility = evaluateSignalPersistenceWithRequirements(
        persistence.state, atMs, policy.minimumEdge, 0.5, policy.persistence,
      );
      if (!eligibility.eligible) { exclude(local, 'persistence'); continue; }
      const fill = estimatePaperFill(stakeLimit, kalshi.price, 'kalshi');
      const rowOutcome = outcomes.get(assetWindow(row.symbol, row.closesAt));
      if (!fill || !rowOutcome) { exclude(local, 'sizingOrOutcome'); continue; }
      const id = decisionId(row.symbol, row.closesAt, entry.side);
      if (candidates.has(id)) continue; // Exact order snapshot is authoritative for the chosen decision.
      candidates.set(id, {
        id, symbol: row.symbol, side: entry.side, closesAt: row.closesAt,
        expectedProfitCents: fill.potentialPayoutCents * kalshi.probability - fill.stakeCents,
        askReturn: (rowOutcome === entry.side ? 1 : 0) / (kalshi.price + kalshi.feeRate) - 1,
        source: 'forecast-reconstruction',
      });
    }

    const exposures: PortfolioExposure[] = input.orders.filter((order) => orderOccupiesSlotAt(order, atMs))
      .map((order) => ({ symbol: order.symbol, closesAt: order.closesAt }));
    const selection = selectPortfolio([...candidates.values()].map((candidate) => ({
      id: candidate.id, symbol: candidate.symbol, closesAt: candidate.closesAt,
      expectedProfitCents: candidate.expectedProfitCents,
    })), exposures, policy.constraints);
    const selected = selection.filter((item) => item.selected).sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999));
    const chosenIds = chosen.map((order) => decisionId(order.symbol, order.closesAt, order.side));
    const chosenAdmitted = chosenIds.every((id) => selection.some((item) => item.id === id && item.selected));
    if (chosenAdmitted) chosenAdmittedByReplay += chosen.length;
    else exclude(local, 'chosenStateMismatch');
    const preferredIds = selected.slice(0, chosenIds.length).map((item) => item.id);
    if (!chosenIds.every((id) => candidates.has(id)) || preferredIds.length !== chosenIds.length) {
      exclude(local, 'incompleteChoiceSet');
      continue;
    }
    const meanReturn = (ids: string[]) => ids.reduce((sum, id) => sum + candidates.get(id)!.askReturn, 0) / ids.length;
    const chosenReturn = meanReturn(chosenIds);
    const preferredReturn = meanReturn(preferredIds);
    snapshots.push({
      policyVersion, policyLabel: policy.label, calculationAt: first.calculationAt, closesAt: first.closesAt,
      chosenIds, preferredIds, chosenReturn, preferredReturn, difference: chosenReturn - preferredReturn,
      sameChoice: chosenIds.length === preferredIds.length && chosenIds.every((id) => preferredIds.includes(id)),
      chosenAdmittedByReplay: chosenAdmitted, reconstructedCandidates: [...candidates.values()].filter((item) => item.source === 'forecast-reconstruction').length,
      exclusions: local,
    });
  }

  // If the replay cannot admit the order production demonstrably placed, it has failed its positive
  // control. Keep that diagnostic row visible, but never let it estimate a ranking effect.
  const verified = snapshots.filter((snapshot) => snapshot.chosenAdmittedByReplay);
  const byPolicy = [...CONTRACT_SELECTION_POLICIES].map(([policyVersion, policy]) => {
    const cohort = verified.filter((snapshot) => snapshot.policyVersion === policyVersion);
    return { policyVersion, label: policy.label, result: clusterSnapshotPairs(cohort), sameChoiceSnapshots: cohort.filter((item) => item.sameChoice).length };
  });
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    supportedPolicies: [...CONTRACT_SELECTION_POLICIES.keys()],
    orderSnapshots: snapshotGroups.size, replayedSnapshots: snapshots.length, verifiedSnapshots: verified.length, chosenOrders,
    chosenAdmittedByReplay, sameChoiceSnapshots: verified.filter((snapshot) => snapshot.sameChoice).length,
    snapshots, overall: clusterSnapshotPairs(verified), byPolicy, exclusions,
    limitations: [
      'Forecast history does not retain every failed dashboard observation; reconstructed persistence is a lower-fidelity proxy, never authoritative production state.',
      'Historical portfolio decisions are overwritten rather than journaled, so alternatives are reconstructed from issuance-near forecasts instead of read from a committed choice set.',
      'Only v17-v19 are evaluated: their policy, one-attempt retry rule, and 3/2/1 caps are known. Later runtime cap overrides were not stamped and fail closed here.',
      'Ask-and-hold returns isolate selection from maker fills and exits; they are not realized P&L.',
    ],
  };
}
