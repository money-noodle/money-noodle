import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PORTFOLIO_CHOICE_SET_VERSION, buildPortfolioChoiceSetReport, replayPortfolioChoiceSetEvents,
  type PortfolioChoiceSetCandidate, type PortfolioChoiceSetRecord,
} from './portfolio-choice-set';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from './strategy-registry';

const candidate = (
  id: string, side: 'UP' | 'DOWN', outcome: 'UP' | 'DOWN', disposition: PortfolioChoiceSetCandidate['drainDisposition'], rank: number,
): PortfolioChoiceSetCandidate => ({
  id, symbol: id.toUpperCase(), contractId: `KX-${id}`, side, closesAt: '2026-08-20T00:15:00Z',
  selectedSideProbability: 0.7, confidence: 0.8, actionableAsk: 0.5, actionableBid: 0.49,
  feeRate: 0.01, netEdge: 0.19, spread: 0.01, cooldownRemainingMs: 0,
  assetAdmitted: true, cycleRegime: 'stable', regimeAdmitted: true, liveFiltersAdmitted: true,
  portfolioState: 'portfolio-selected', portfolioReason: `rank ${rank}`,
  quantity: 2, stakeCents: 100, feeCents: 0, potentialPayoutCents: 200,
  expectedProfitCents: 40, adjustedExpectedContributionCents: 40, rank,
  initiallySelected: true, executionReady: true, drainDisposition: disposition,
  outcome, resolvedAt: '2026-08-20T00:16:00Z',
});

const record = (patch: Partial<PortfolioChoiceSetRecord> = {}): PortfolioChoiceSetRecord => ({
  id: 'portfolio-choice-set-v1:order-1', version: PORTFOLIO_CHOICE_SET_VERSION,
  recordedAt: '2026-08-20T00:10:00Z', calculationAt: '2026-08-20T00:10:00Z', drainSequence: 1,
  strategyId: EDGE_BINARY_BUY, executionMode: 'live', marketId: 'crypto-15m', providerId: 'kalshi',
  forecastModelVersion: 'model', buyPolicyVersion: 'v21', executionPolicyVersion: 'v3',
  issuedOrderId: 'order-1', issuedLogicalOrderId: 'logical-1', issuedCandidateId: 'btc',
  issuedEntryDecision: {
    version: 'entry-decision-v2', policyVersion: 'v21', calculationAt: '2026-08-20T00:10:00Z', side: 'UP',
    probabilityUp: 0.7, probabilityDown: 0.3, selectedSideProbability: 0.7, confidence: 0.8,
    confidenceBreakdown: { base: 0.3, dataQuality: 0.2, sampleQuality: 0.2, uncertaintyPenalty: 0 },
    actionableAsk: 0.5, actionableBid: 0.49, feeRate: 0.01, netEdge: 0.19, spread: 0.01,
    secondsRemaining: 300, qualifyingSnapshots: 2, medianNetEdge: 0.18, factors: [],
  },
  issuedReservedStakeCents: 100, proposedStakeCents: 100, maximumLiveStakeCents: 100,
  providerSpendableCents: 1_000, effectiveStakeCeilingCents: 100,
  adaptiveRegimeGate: { phase: 'open', allowsEntries: true, policyVersion: 'v21', reason: 'open' },
  classifiedRegimeRequired: true, liveControl: { revision: 1, state: 'active', mode: 'live' }, liveOperationalReady: true,
  constraints: { maximumPositions: 9, maximumSameWindow: 6, maximumSameGroupPerWindow: 3, correlationPenaltyCents: 1, sameGroupPenaltyCents: 1 },
  exposures: [{ orderId: 'shot', strategyId: LONG_SHOT_ROUND_TRIP, symbol: 'ETH', side: 'DOWN', closesAt: '2026-08-20T00:15:00Z', status: 'open' }],
  priorDrainActions: [],
  candidates: [candidate('btc', 'UP', 'DOWN', 'issued', 2), candidate('eth', 'UP', 'UP', 'pending', 1)],
  ...patch,
});

describe('portfolio choice-set event replay', () => {
  it('keeps the first decision immutable and patches each candidate outcome only once', () => {
    const first = record({ candidates: record().candidates.map((item) => ({ ...item, outcome: undefined, resolvedAt: undefined })) });
    const replayed = replayPortfolioChoiceSetEvents([], [
      { op: 'decision', value: first },
      { op: 'decision', value: { ...first, proposedStakeCents: 999 } },
      { op: 'resolution', recordId: first.id, candidateId: 'btc', outcome: 'UP', resolvedAt: '2026-08-20T00:16:00Z' },
      { op: 'resolution', recordId: first.id, candidateId: 'btc', outcome: 'DOWN', resolvedAt: '2026-08-20T00:17:00Z' },
    ]);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].proposedStakeCents).toBe(100);
    expect(replayed[0].candidates.find((item) => item.id === 'btc')).toMatchObject({ outcome: 'UP', resolvedAt: '2026-08-20T00:16:00Z' });
    expect(replayed[0].candidates.find((item) => item.id === 'eth')?.outcome).toBeUndefined();
  });
});

describe('pre-registered portfolio choice-set report', () => {
  it('scores every record and clusters repeated records on settlement window', () => {
    const first = record();
    const second = record({ id: 'portfolio-choice-set-v1:order-2', issuedOrderId: 'order-2' });
    const third = record({
      id: 'portfolio-choice-set-v1:order-3', issuedOrderId: 'order-3',
      candidates: record().candidates.map((item) => ({ ...item, closesAt: '2026-08-20T00:30:00Z' })),
    });
    const report = buildPortfolioChoiceSetReport([first, second, third]);
    expect(report).toMatchObject({ records: 3, integrityFailures: 0, scoreableRecords: 3, independentWindows: 2, sameChoiceRecords: 0, differingChoiceRecords: 3 });
    expect(report.differenceMean).toBe(-2);
    expect(report.diagnosticReviewReady).toBe(false);
    expect(report.differingChoiceReviewReady).toBe(false);
  });

  it('fails closed when the issued candidate is absent from its own immutable set', () => {
    const report = buildPortfolioChoiceSetReport([record({ issuedCandidateId: 'missing' })]);
    expect(report).toMatchObject({ integrityFailures: 1, scoreableRecords: 0, differenceMean: null });
  });
});

describe('choice-set evidence cannot feed a money-moving module', () => {
  it('is append-journaled and imported only by shared orchestration', () => {
    const store = readFileSync(path.join(process.cwd(), 'lib', 'portfolio-choice-set-store.ts'), 'utf8');
    expect(store).toContain('appendFile(JOURNAL_FILE');
    expect(store).toContain('JOURNAL_COMPACTION_BYTES');
    expect(store).toContain("await atomicWrite(JOURNAL_FILE, '')");
    const forbidden = [
      'prediction-policy.ts', 'entry-execution-policy.ts', 'exit-policy.ts', 'portfolio-policy.ts',
      'venue-fill.ts', 'live-risk-policy.ts', 'live-orders.ts', 'trading-control.ts',
      'maker-retry-policy.ts', 'signal-persistence.ts',
    ];
    for (const file of forbidden) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      expect({ file, importsStore: source.includes('portfolio-choice-set-store') }).toEqual({ file, importsStore: false });
    }
  });
});
