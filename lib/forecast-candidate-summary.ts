import { FORECAST_CANDIDATE_REGISTRY, FORECAST_CANDIDATE_REGISTRY_VERSION } from './forecast-candidates';
import { productionMarketCapability } from './market-registry';
import type { ForecastCandidateDecision, TrackedForecast, TradingVenue } from './types';

export interface ForecastCandidateCoverage {
  candidateId: string;
  closedRows: number;
  availableRows: number;
  actionableRows: number;
  qualifiedRows: number;
  scoreableRows: number;
  availableCoverage: number | null;
  scoreableCoverage: number | null;
  availableWindows: number;
  scoreableWindows: number;
}

export interface ForecastCandidateCollectionSummary {
  registryVersion: string;
  activationAt?: string;
  generatedAt: string;
  rows: number;
  closedRows: number;
  windows: number;
  closedWindows: number;
  rowsWithCompleteFamily: number;
  maximumProductionReplayError: number | null;
  candidates: ForecastCandidateCoverage[];
  milestones: {
    smoke10: { met: boolean; reason: string };
    coverage100: { met: boolean; reason: string };
    phaseExit300: { automatedCriteriaMet: boolean; reason: string; manualLatencyReviewStillRequired: true };
  };
}

function fundedOutcome(forecast: TrackedForecast): 'UP' | 'DOWN' | undefined {
  const funded = (Object.keys(forecast.venueContracts ?? {}) as TradingVenue[])
    .filter((venue) => productionMarketCapability(venue).live);
  // Phase 2 is deliberately valid only while exactly one funded provider is implemented for this market. A future
  // multi-provider generation must select and resolve its own provider rather than silently taking the first one.
  if (funded.length !== 1) return undefined;
  return forecast.venueOutcomes?.[funded[0]]?.outcome;
}

const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;

export function summarizeForecastCandidateCollection(
  forecasts: TrackedForecast[],
  nowMs = Date.now(),
): ForecastCandidateCollectionSummary {
  const rows = forecasts.filter((forecast) => forecast.candidateEvaluation?.registryVersion === FORECAST_CANDIDATE_REGISTRY_VERSION)
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt) || a.id.localeCompare(b.id));
  const closedRows = rows.filter((forecast) => Date.parse(forecast.closesAt) < nowMs);
  const windows = new Set(rows.map((forecast) => forecast.closesAt));
  const closedWindows = new Set(closedRows.map((forecast) => forecast.closesAt));
  const expectedIds = new Set(FORECAST_CANDIDATE_REGISTRY.map((candidate) => candidate.id));
  let rowsWithCompleteFamily = 0;
  let maximumProductionReplayError: number | null = null;
  for (const forecast of rows) {
    const decisions = forecast.candidateEvaluation!.decisions;
    const ids = new Set(decisions.map((decision) => decision.candidateId));
    if (decisions.length === expectedIds.size && ids.size === expectedIds.size
      && [...expectedIds].every((id) => ids.has(id))) rowsWithCompleteFamily += 1;
    const control = decisions.find((decision) => decision.candidateId === 'production-control-v1');
    if (control?.replayError !== undefined && Number.isFinite(control.replayError)) {
      maximumProductionReplayError = Math.max(maximumProductionReplayError ?? 0, control.replayError);
    }
  }

  const candidates = FORECAST_CANDIDATE_REGISTRY.map((descriptor): ForecastCandidateCoverage => {
    let availableRows = 0;
    let actionableRows = 0;
    let qualifiedRows = 0;
    let scoreableRows = 0;
    const availableWindows = new Set<string>();
    const scoreableWindows = new Set<string>();
    for (const forecast of closedRows) {
      const decision: ForecastCandidateDecision | undefined = forecast.candidateEvaluation!.decisions
        .find((candidate) => candidate.candidateId === descriptor.id);
      if (decision?.status !== 'available') continue;
      availableRows += 1;
      availableWindows.add(forecast.closesAt);
      if (decision.bestOption) actionableRows += 1;
      if (decision.qualified) qualifiedRows += 1;
      if (fundedOutcome(forecast)) {
        scoreableRows += 1;
        scoreableWindows.add(forecast.closesAt);
      }
    }
    return {
      candidateId: descriptor.id,
      closedRows: closedRows.length,
      availableRows,
      actionableRows,
      qualifiedRows,
      scoreableRows,
      availableCoverage: ratio(availableRows, closedRows.length),
      scoreableCoverage: ratio(scoreableRows, closedRows.length),
      availableWindows: availableWindows.size,
      scoreableWindows: scoreableWindows.size,
    };
  });

  const completeFamily = rows.length > 0 && rowsWithCompleteFamily === rows.length;
  const replayExact = maximumProductionReplayError !== null && maximumProductionReplayError <= 1e-12;
  const control = candidates.find((candidate) => candidate.candidateId === 'production-control-v1')!;
  const allAvailable90 = candidates.every((candidate) => (candidate.availableCoverage ?? 0) >= 0.9);
  const smokeMet = windows.size >= 10 && completeFamily && replayExact;
  const coverageMet = closedWindows.size >= 100 && (control.scoreableCoverage ?? 0) >= 0.95;
  const exitMet = closedWindows.size >= 300 && (control.scoreableCoverage ?? 0) >= 0.95 && allAvailable90;

  return {
    registryVersion: FORECAST_CANDIDATE_REGISTRY_VERSION,
    activationAt: rows[0]?.issuedAt,
    generatedAt: new Date(nowMs).toISOString(),
    rows: rows.length,
    closedRows: closedRows.length,
    windows: windows.size,
    closedWindows: closedWindows.size,
    rowsWithCompleteFamily,
    maximumProductionReplayError,
    candidates,
    milestones: {
      smoke10: {
        met: smokeMet,
        reason: `${windows.size}/10 windows; ${rowsWithCompleteFamily}/${rows.length} rows carry the complete family; maximum production replay error ${maximumProductionReplayError ?? 'unavailable'}.`,
      },
      coverage100: {
        met: coverageMet,
        reason: `${closedWindows.size}/100 closed windows; production funded-outcome coverage ${control.scoreableCoverage === null ? 'unavailable' : `${(control.scoreableCoverage * 100).toFixed(2)}%`}.`,
      },
      phaseExit300: {
        automatedCriteriaMet: exitMet,
        reason: `${closedWindows.size}/300 closed windows; production funded-outcome coverage ${control.scoreableCoverage === null ? 'unavailable' : `${(control.scoreableCoverage * 100).toFixed(2)}%`}; minimum candidate availability ${candidates.length ? `${(Math.min(...candidates.map((candidate) => candidate.availableCoverage ?? 0)) * 100).toFixed(2)}%` : 'unavailable'}.`,
        manualLatencyReviewStillRequired: true,
      },
    },
  };
}
