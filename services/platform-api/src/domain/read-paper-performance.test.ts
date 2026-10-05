// The stored performance document, read into the two published views.
//
// Every value here is synthetic and obviously so: one asset called `EXAMPLE`, tiny
// counts, round ratios. Nothing in this file is a real figure from a real record,
// and nothing in it may become one — the fixtures are also imported by the
// application and HTTP tests, so a real number pasted here would travel.

import { describe, expect, it } from 'vitest';

import type { PaperJsonPayloadRow } from './paper-projection.js';
import { readPaperPerformance, readPaperPerformanceSummary } from './read-paper-performance.js';
import { RecordShapeError } from './read-record.js';

const SOURCE_UPDATED_AT = new Date('2026-10-05T06:10:00.000Z');

export const syntheticForecast = Object.freeze({
  confidence: 0.7,
  correct: true,
  direction: 'UP',
  directionalLikelihood: 0.61,
  id: 'forecast-1',
  issuedAt: '2026-10-05T06:00:00.000Z',
  modelVersion: 'model-1',
  outcome: 'UP',
  policyVersion: 'policy-1',
  status: 'resolved',
  symbol: 'EXAMPLE',
});

const syntheticSlice = Object.freeze({ accuracy: 0.5, correct: 1, label: 'EXAMPLE', resolved: 2 });

const syntheticSegmentGroup = Object.freeze({
  description: 'Synthetic dimension for a synthetic record.',
  dimension: 'Asset',
  segments: [
    {
      label: 'EXAMPLE',
      meanPredictedEdge: 0.04,
      // Null on purpose: the source can compute this as not-a-number, which JSON
      // carries as null, and a record carrying it is a real record.
      meanRealizedReturn: null,
      standardError: null,
      trades: 2,
      windows: 1,
      winRate: 0.5,
    },
  ],
});

const syntheticTrackSummary = Object.freeze({
  losses: 1,
  meanPredictedEdge: 0.04,
  meanRealizedReturn: 0.02,
  mode: 'paper',
  realizedPnlCents: -3.5,
  roi: -0.01,
  settled: 2,
  windows: 1,
  winRate: 0.5,
  wins: 1,
});

const syntheticSignalSummary = Object.freeze({
  accuracy: 0.5,
  brierScore: 0.21,
  calibrationMinimum: 20,
  calibrationProgress: 0.1,
  calibrationReady: false,
  calibrationWindows: 2,
  currentCycleStreak: -1,
  cycleBalancedAccuracy: 0.5,
  cycles: 2,
  issued: 4,
  recent: [syntheticForecast],
  resolved: 2,
  resolvedCycles: 2,
});

const syntheticTrackRecord = Object.freeze({
  actionCounterfactuals: [
    {
      action: 'HOLD',
      alternative: 'exit at the recorded bid',
      alternativePnlCents: -4,
      basis: 'approximate',
      credible: false,
      decisions: 2,
      decisionsBeatingAlternative: 1,
      description: 'Synthetic counterfactual arm.',
      hitRate: 0.5,
      incrementalCents: 1,
      incrementalReturnStandardError: null,
      meanIncrementalCents: 0.5,
      meanIncrementalReturn: 0.01,
      policy: 'policy-1',
      takenPnlCents: -3,
      windows: 1,
    },
  ],
  actionCounterfactualVersion: 'action-counterfactual-v1',
  invalid: 0,
  losses: 1,
  meanPredictedEdge: 0.04,
  meanPrincipalRecoveryVsFullExitCents: null,
  meanRealizedReturn: 0.02,
  meanSwitchVsHoldCents: null,
  mode: 'paper',
  pending: 1,
  principalRecoveryExitsEvaluated: 0,
  principalRecoveryVsFullExitCents: null,
  realizedPnlCents: -3.5,
  rejected: 0,
  returnedCents: 196.5,
  roi: -0.01,
  segments: [syntheticSegmentGroup],
  settled: 2,
  sold: 0,
  stakedCents: 200,
  standaloneExitsEvaluated: 0,
  standardError: null,
  switchesEvaluated: 0,
  unfilled: 1,
  windows: 1,
  winRate: 0.5,
  wins: 1,
});

const syntheticRecordSummary = Object.freeze({
  accuracy: 0.5,
  benchmarks: [{ accuracy: 0.5, brierScore: 0.21, label: 'model', logLoss: 0.68, resolved: 2 }],
  brierScore: 0.21,
  byAsset: [syntheticSlice],
  byConfidenceBucket: [syntheticSlice],
  byDirection: [syntheticSlice],
  byLeadTime: [{ ...syntheticSlice, brierScore: 0.21 }],
  byModelVersion: [syntheticSlice],
  calibrationBins: [{ label: '45–55%', meanForecast: 0.5, observedRate: 0.5, resolved: 2 }],
  calibrationMinimum: 20,
  calibrationProgress: 0.1,
  calibrationReady: false,
  calibrationWindows: 2,
  correct: 1,
  currentCycleStreak: -1,
  currentStreak: -1,
  cycleBalancedAccuracy: 0.5,
  cycles: 2,
  edgeBuckets: [
    { label: '0–5pp', predictedEdge: 0.04, realizedReturn: 0.02, trades: 2, winRate: 0.5 },
  ],
  evaluationMeaningful: false,
  evaluationMinimumWindows: 20,
  invalid: 0,
  issued: 4,
  logLoss: 0.68,
  meanPredictedEdge: 0.04,
  meanRealizedReturn: 0.02,
  missedBuyCounterfactual: {
    bestPerWindowCandidates: 1,
    bestPerWindowMeanReturn: null,
    bestPerWindowStandardError: null,
    bestPerWindowTotalReturn: null,
    bestPerWindowWins: 0,
    candidates: 1,
    description: 'Sides a policy floor rejected, so none was ever taken.',
    label: 'Rejected candidates',
    meanCandidateReturn: null,
    profitableCandidates: 0,
    standardError: null,
    windows: 1,
  },
  observedCalculations: 4,
  pending: 1,
  realizedEdgeTrades: 2,
  recent: [syntheticForecast],
  resolved: 2,
  resolvedCalculations: 2,
  resolvedCycles: 2,
  resolvedWindows: 1,
  segments: [syntheticSegmentGroup],
  timeline: [
    {
      cumulativeAccuracy: 0.5,
      cumulativeBrier: 0.21,
      resolved: 1,
      rollingAccuracy: 0.5,
      time: '2026-10-05T06:05:00.000Z',
    },
  ],
});

/** The stored document as the current writer produces it, `homepage` included. */
export function syntheticStoredPerformance(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    cyclePaths: {
      completedCycles: 1,
      latestByAsset: [
        {
          closesAt: '2026-10-05T06:00:00.000Z',
          features: {
            coverageSeconds: 840,
            lagOneAutocorrelation: -0.1,
            localVolatility15mPercent: 0.3,
            localVolatilityPerSecond: 0.00002,
            netChangePercent: 0.12,
            observationCount: 60,
            observedAt: '2026-10-05T05:59:00.000Z',
            rangePercent: 0.4,
            regime: 'mixed',
            signedTrendEfficiency: -0.2,
            signFlipRate: 0.5,
            trendEfficiency: 0.2,
          },
          symbol: 'EXAMPLE',
        },
      ],
      policyVersion: 'policy-1',
      totalCycles: 2,
      totalPoints: 120,
    },
    forecasts: [syntheticForecast],
    fullGeneratedAt: '2026-10-05T06:00:30.000Z',
    homepage: {
      generatedAt: '2026-10-05T06:09:00.000Z',
      paperRecord: syntheticTrackSummary,
      summary: syntheticSignalSummary,
    },
    paperEpochs: [
      {
        budgetPnlCents: -3,
        current: true,
        epochId: 'epoch-1',
        firstAt: '2026-10-05T05:00:00.000Z',
        lastAt: '2026-10-05T06:00:00.000Z',
        realizedPnlCents: -3.5,
        settled: 2,
        stakedCents: 200,
        trades: 3,
      },
    ],
    paperProviderRecords: [
      { marketId: 'crypto-15m', providerId: 'kalshi', record: syntheticTrackRecord },
    ],
    paperRecord: syntheticTrackRecord,
    summary: syntheticRecordSummary,
    ...overrides,
  };
}

export const syntheticPerformanceRow = (
  payload: unknown = syntheticStoredPerformance(),
): PaperJsonPayloadRow => Object.freeze({ payload, sourceUpdatedAt: SOURCE_UPDATED_AT });

/** The failure a read rejected with, refusing to let a success pass as one. */
function shapeError(read: () => unknown): RecordShapeError {
  try {
    read();
  } catch (error) {
    if (error instanceof RecordShapeError) return error;
    throw error;
  }
  throw new Error('expected a refusal, got a value');
}

describe('readPaperPerformanceSummary', () => {
  it('publishes the pre-computed summary with the source clock that produced it', () => {
    const summary = readPaperPerformanceSummary(syntheticPerformanceRow());

    expect(summary.durable).toBe(true);
    expect(summary.generatedAt).toBe('2026-10-05T06:09:00.000Z');
    // The row's own write time is published beside it, because the two differ and a
    // reader judging freshness needs to know which is which.
    expect(summary.sourceUpdatedAt).toBe(SOURCE_UPDATED_AT.toISOString());
    expect(summary.summary.accuracy).toBe(0.5);
    expect(summary.paperRecord.mode).toBe('paper');
    expect(summary.paperRecord.realizedPnlCents).toBe(-3.5);
  });

  it('reads a document written before the summary member existed', () => {
    // The legacy shape: no `homepage`, so the same record is projected out of the
    // wider members and the row's write time stands in for a stamp it never had.
    const payload = syntheticStoredPerformance();
    delete payload.homepage;
    const summary = readPaperPerformanceSummary(syntheticPerformanceRow(payload));

    expect(summary.generatedAt).toBe(SOURCE_UPDATED_AT.toISOString());
    expect(summary.summary.issued).toBe(4);
    expect(summary.summary.recent).toHaveLength(1);
    expect(summary.paperRecord.settled).toBe(2);
  });

  it('treats a non-array recent list in a legacy document as empty rather than broken', () => {
    const payload = syntheticStoredPerformance();
    delete payload.homepage;
    payload.summary = { ...syntheticRecordSummary, recent: undefined };

    expect(readPaperPerformanceSummary(syntheticPerformanceRow(payload)).summary.recent).toEqual(
      [],
    );
  });

  it('bounds the recent list even if the source published more', () => {
    const payload = syntheticStoredPerformance({
      homepage: {
        generatedAt: '2026-10-05T06:09:00.000Z',
        paperRecord: syntheticTrackSummary,
        summary: {
          ...syntheticSignalSummary,
          recent: [1, 2, 3, 4, 5, 6].map((index) => ({
            ...syntheticForecast,
            id: `forecast-${index}`,
          })),
        },
      },
    });

    expect(
      readPaperPerformanceSummary(syntheticPerformanceRow(payload)).summary.recent,
    ).toHaveLength(4);
  });

  it('normalizes a legacy non-ISO stamp rather than passing it through', () => {
    const payload = syntheticStoredPerformance({
      homepage: {
        // A database text cast of a timestamp, which is what the source's own
        // fallback produces. It is a real instant and not ISO-8601.
        generatedAt: '2026-10-05 06:09:00+00',
        paperRecord: syntheticTrackSummary,
        summary: syntheticSignalSummary,
      },
    });

    expect(readPaperPerformanceSummary(syntheticPerformanceRow(payload)).generatedAt).toBe(
      '2026-10-05T06:09:00.000Z',
    );
  });

  it('strips a key the source added rather than serving it', () => {
    const payload = syntheticStoredPerformance({
      homepage: {
        generatedAt: '2026-10-05T06:09:00.000Z',
        paperRecord: { ...syntheticTrackSummary, liveEquityCents: 1_000_000 },
        summary: syntheticSignalSummary,
      },
    });

    const published = readPaperPerformanceSummary(syntheticPerformanceRow(payload));
    expect(Object.keys(published.paperRecord)).not.toContain('liveEquityCents');
    expect(JSON.stringify(published)).not.toContain('1000000');
  });

  it('refuses a record that claims any mode other than simulation', () => {
    const payload = syntheticStoredPerformance({
      homepage: {
        generatedAt: '2026-10-05T06:09:00.000Z',
        paperRecord: { ...syntheticTrackSummary, mode: 'live' },
        summary: syntheticSignalSummary,
      },
    });

    expect(
      shapeError(() => readPaperPerformanceSummary(syntheticPerformanceRow(payload))).path,
    ).toBe('payload.homepage.paperRecord.mode');
  });

  it.each([
    ['payload.homepage.summary.issued', 'issued'],
    ['payload.homepage.summary.calibrationReady', 'calibrationReady'],
  ])('names %s when the source stops publishing it', (path, key) => {
    const summary: Record<string, unknown> = { ...syntheticSignalSummary };
    delete summary[key];
    const payload = syntheticStoredPerformance({
      homepage: {
        generatedAt: '2026-10-05T06:09:00.000Z',
        paperRecord: syntheticTrackSummary,
        summary,
      },
    });

    expect(
      shapeError(() => readPaperPerformanceSummary(syntheticPerformanceRow(payload))).path,
    ).toBe(path);
  });

  it('refuses a payload that is not an object', () => {
    expect(shapeError(() => readPaperPerformanceSummary(syntheticPerformanceRow(null))).path).toBe(
      'payload',
    );
  });
});

describe('readPaperPerformance', () => {
  it('publishes the full record and never the members the source keeps internal', () => {
    const record = readPaperPerformance(syntheticPerformanceRow());

    expect(record.durable).toBe(true);
    // The document's own stamp, not the row's: the row is rewritten far more often
    // than the document is recomputed, so the row's time would overstate this.
    expect(record.generatedAt).toBe('2026-10-05T06:00:30.000Z');
    expect(record.sourceUpdatedAt).toBe(SOURCE_UPDATED_AT.toISOString());
    expect(Object.keys(record)).not.toContain('homepage');
    expect(Object.keys(record)).not.toContain('fullGeneratedAt');
    expect(record.summary.benchmarks[0]?.label).toBe('model');
    expect(record.paperRecord.actionCounterfactuals[0]?.action).toBe('HOLD');
    expect(record.paperProviderRecords[0]?.providerId).toBe('kalshi');
    expect(record.paperEpochs[0]?.current).toBe(true);
    expect(record.forecasts).toHaveLength(1);
    expect(record.cyclePaths?.latestByAsset[0]?.features.regime).toBe('mixed');
  });

  it('falls back to the row write time when the document carries no stamp', () => {
    const payload = syntheticStoredPerformance();
    delete payload.fullGeneratedAt;

    expect(readPaperPerformance(syntheticPerformanceRow(payload)).generatedAt).toBe(
      SOURCE_UPDATED_AT.toISOString(),
    );
  });

  it('reads an older document with no optional members at all', () => {
    const payload = syntheticStoredPerformance();
    delete payload.cyclePaths;
    delete payload.paperEpochs;
    delete payload.paperProviderRecords;
    delete payload.forecasts;
    const record = readPaperPerformance(syntheticPerformanceRow(payload));

    // Absent, not null: the key is gone from the JSON entirely.
    expect(Object.keys(record)).not.toContain('cyclePaths');
    expect(record.paperEpochs).toEqual([]);
    expect(record.paperProviderRecords).toEqual([]);
    expect(record.forecasts).toEqual([]);
  });

  it('reads path diagnostics written before the two newer fields existed', () => {
    const payload = syntheticStoredPerformance();
    const report = payload.cyclePaths as { latestByAsset: { features: Record<string, unknown> }[] };
    delete report.latestByAsset[0]?.features.netChangePercent;
    delete report.latestByAsset[0]?.features.signedTrendEfficiency;
    const features = readPaperPerformance(syntheticPerformanceRow(payload)).cyclePaths
      ?.latestByAsset[0]?.features;

    expect(features).toBeDefined();
    expect(Object.keys(features ?? {})).not.toContain('netChangePercent');
    expect(features?.regime).toBe('mixed');
  });

  it('keeps a null the source stored as the answer it is', () => {
    const segment =
      readPaperPerformance(syntheticPerformanceRow()).paperRecord.segments[0]?.segments[0];

    expect(segment?.meanRealizedReturn).toBeNull();
    expect(segment?.standardError).toBeNull();
  });

  it.each([
    ['payload.summary', 'summary'],
    ['payload.paperRecord', 'paperRecord'],
  ])('refuses a document with no %s', (path, key) => {
    const payload = syntheticStoredPerformance();
    delete payload[key];

    expect(shapeError(() => readPaperPerformance(syntheticPerformanceRow(payload))).path).toBe(
      path,
    );
  });

  it('names the exact element and field when one entry of an array is wrong', () => {
    const payload = syntheticStoredPerformance({
      summary: {
        ...syntheticRecordSummary,
        benchmarks: [
          syntheticRecordSummary.benchmarks[0],
          { ...syntheticRecordSummary.benchmarks[0], accuracy: 'not a number' },
        ],
      },
    });

    const error = shapeError(() => readPaperPerformance(syntheticPerformanceRow(payload)));
    expect(error.path).toBe('payload.summary.benchmarks[1].accuracy');
    // The path travels; the offending value does not.
    expect(error.message).not.toContain('not a number');
  });
});
