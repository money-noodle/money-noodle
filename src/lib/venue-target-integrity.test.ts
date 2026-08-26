import { describe, expect, it } from 'vitest';
import { createContractProvenance, contractProvenanceRef } from './contract-provenance';
import { evaluationTargetForForecast } from './forecast-tracker';
import type { TrackedForecast, TradingVenue, VenueOutcomeRecord } from './types';

const forecast = (patch: Partial<TrackedForecast> = {}): TrackedForecast => ({
  id: 'row', symbol: 'BTC', marketUrl: 'https://polymarket.com/event/btc-test',
  issuedAt: '2026-01-01T00:01:00Z', closesAt: '2026-01-01T00:15:00Z',
  direction: 'UP', probabilityUp: 0.7, directionalLikelihood: 0.7, confidence: 0.7,
  modelVersion: 'production', policyVersion: 'v9', polymarketProbabilityUp: 0.5,
  factors: [], status: 'pending', ...patch,
});

const provenance = (venue: TradingVenue, id: string) => contractProvenanceRef(createContractProvenance({
  venue, contractId: id, marketUrl: `https://example.test/${id}`, closesAt: '2026-01-01T00:15:00Z',
  rulesSource: `https://api.example.test/${id}`, rulesText: `${venue} settlement rules`, comparability: 'approximate',
}));

const outcome = (venue: TradingVenue, contractId: string, result: 'UP' | 'DOWN'): VenueOutcomeRecord => ({
  venue, contractId, outcome: result, resolutionSource: `https://api.example.test/${contractId}`,
  resolvedAt: '2026-01-01T00:16:00Z',
});

describe('venue-specific forecast targets', () => {
  it('selects the Kalshi outcome for a Kalshi entry even when Polymarket disagrees', () => {
    const row = forecast({
      entryVenue: 'kalshi',
      venueContracts: { polymarket: provenance('polymarket', 'poly-1'), kalshi: provenance('kalshi', 'kalshi-1') },
      venueOutcomes: { polymarket: outcome('polymarket', 'poly-1', 'UP'), kalshi: outcome('kalshi', 'kalshi-1', 'DOWN') },
    });
    expect(evaluationTargetForForecast(row)).toMatchObject({
      venue: 'kalshi', integrity: 'venue-specific', resolution: { outcome: 'DOWN', contractId: 'kalshi-1' },
    });
  });

  it('fails closed instead of substituting Polymarket when selected-venue provenance is missing', () => {
    const row = forecast({
      entryVenue: 'kalshi',
      venueContracts: { polymarket: provenance('polymarket', 'poly-1') },
      venueOutcomes: { polymarket: outcome('polymarket', 'poly-1', 'UP') },
    });
    expect(evaluationTargetForForecast(row)).toEqual({ venue: 'kalshi', integrity: 'missing-provenance', resolution: undefined });
  });

  it('rejects an outcome record for a different contract on the same venue', () => {
    const row = forecast({
      entryVenue: 'kalshi',
      venueContracts: { kalshi: provenance('kalshi', 'kalshi-expected') },
      venueOutcomes: { kalshi: outcome('kalshi', 'kalshi-other', 'UP') },
    });
    expect(evaluationTargetForForecast(row)).toMatchObject({
      venue: 'kalshi', integrity: 'mismatched-outcome', resolution: { contractId: 'kalshi-other' },
    });
  });

  it('labels historical records explicitly instead of pretending they have venue-specific provenance', () => {
    const row = forecast({
      entryVenue: 'kalshi',
      venueOutcomes: { polymarket: outcome('polymarket', 'legacy-poly', 'UP') },
    });
    expect(evaluationTargetForForecast(row)).toMatchObject({
      venue: 'polymarket', integrity: 'legacy-polymarket', resolution: { outcome: 'UP' },
    });
  });
});
