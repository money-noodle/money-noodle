import { describe, expect, it } from 'vitest';
import { FORECAST_CANDIDATE_REGISTRY, FORECAST_CANDIDATE_REGISTRY_VERSION } from './forecast-candidates';
import { summarizeForecastCandidateCollection } from './forecast-candidate-summary';
import type { ForecastCandidateDecision, TrackedForecast } from './types';

const now = Date.parse('2026-08-25T12:00:00Z');

function row(index: number, options: { outcome?: boolean; complete?: boolean } = {}): TrackedForecast {
  const closesAt = new Date(now - (index + 1) * 15 * 60_000).toISOString();
  const decisions: ForecastCandidateDecision[] = FORECAST_CANDIDATE_REGISTRY
    .slice(0, options.complete === false ? -1 : undefined)
    .map((candidate) => ({
      candidateId: candidate.id,
      candidateModelVersion: candidate.modelVersion,
      status: 'available',
      probabilityUp: 0.6,
      replayError: candidate.id === 'production-control-v1' ? 0 : undefined,
      qualified: false,
    }));
  return {
    id: `row-${index}`, symbol: 'BTC', marketUrl: 'https://example.test',
    issuedAt: new Date(Date.parse(closesAt) - 5 * 60_000).toISOString(), closesAt,
    direction: 'UP', probabilityUp: 0.6, directionalLikelihood: 0.6, confidence: 0.7,
    modelVersion: 'Blend 0.4', policyVersion: 'v22', polymarketProbabilityUp: 0.5,
    factors: [], status: options.outcome === false ? 'pending' : 'resolved',
    venueContracts: {
      kalshi: {
        version: 'contract-provenance-v1', registryId: `contract-${index}`, venue: 'kalshi',
        contractId: `K-${index}`, marketUrl: 'https://example.test', closesAt,
        capturedAt: closesAt, rulesSource: 'test', rulesFingerprint: 'hash', comparability: 'exact',
      },
    },
    venueOutcomes: options.outcome === false ? undefined : {
      kalshi: {
        venue: 'kalshi', contractId: `K-${index}`, outcome: 'UP',
        resolutionSource: 'test', resolvedAt: new Date(Date.parse(closesAt) + 30_000).toISOString(),
      },
    },
    candidateEvaluation: {
      registryVersion: FORECAST_CANDIDATE_REGISTRY_VERSION,
      providerRegistryVersion: 'trading-provider-registry-v1',
      productionModelVersion: 'blend-0.4-forecast-model-v1', policyVersion: 'v22',
      maximumNetEdge: 1, downEntryEnabled: true, confidence: 0.7, decisions,
    },
  };
}

describe('forecast candidate collection milestones', () => {
  it('counts independent close timestamps rather than repeated rows', () => {
    const forecasts = Array.from({ length: 10 }, (_, index) => row(index));
    forecasts.push({ ...row(0), id: 'duplicate-calculation', issuedAt: new Date(now - 2 * 60_000).toISOString() });
    const summary = summarizeForecastCandidateCollection(forecasts, now);
    expect(summary.rows).toBe(11);
    expect(summary.closedWindows).toBe(10);
    expect(summary.milestones.smoke10.met).toBe(true);
    expect(summary.milestones.coverage100.met).toBe(false);
  });

  it('requires complete families and at least 95% funded-outcome coverage at 100 windows', () => {
    const forecasts = Array.from({ length: 100 }, (_, index) => row(index, {
      outcome: index >= 5,
      complete: index !== 99,
    }));
    const summary = summarizeForecastCandidateCollection(forecasts, now);
    expect(summary.candidates[0].scoreableCoverage).toBeCloseTo(0.95, 12);
    expect(summary.fundedOutcomeCoverage).toEqual({
      scoreableRows: 95,
      unavailableRows: 5,
      unavailableClasses: [{ reason: 'funded-outcome-unavailable', rows: 5, windows: 5 }],
    });
    expect(summary.milestones.coverage100.met).toBe(true);
    expect(summary.milestones.smoke10.met).toBe(false);
    expect(summary.milestones.phaseExit300.automatedCriteriaMet).toBe(false);
  });

  it('reports every candidate and funded-outcome unavailable class', () => {
    const forecasts = [row(0), row(1), row(2)];
    forecasts[0].venueContracts = {};
    forecasts[1].venueOutcomes = undefined;
    forecasts[2].candidateEvaluation!.decisions = forecasts[2].candidateEvaluation!.decisions.map((decision) => (
      decision.candidateId === 'basis-only-v1'
        ? {
            candidateId: decision.candidateId,
            candidateModelVersion: decision.candidateModelVersion,
            status: 'unavailable' as const,
            unavailableReason: 'test input unavailable',
          }
        : decision
    ));

    const summary = summarizeForecastCandidateCollection(forecasts, now);
    expect(summary.fundedOutcomeCoverage).toEqual({
      scoreableRows: 1,
      unavailableRows: 2,
      unavailableClasses: [
        { reason: 'funded-contract-provenance-unavailable', rows: 1, windows: 1 },
        { reason: 'funded-outcome-unavailable', rows: 1, windows: 1 },
      ],
    });
    expect(summary.candidates.find((candidate) => candidate.candidateId === 'basis-only-v1')?.unavailableClasses)
      .toEqual([{ reason: 'test input unavailable', rows: 1, windows: 1 }]);
  });
});
