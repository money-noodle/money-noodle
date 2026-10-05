// Synthetic API responses, shared by every test in this app.
//
// Written for these tests, not recorded from a deployment: no real balance, no real
// market price and no real forecast appears anywhere in this repository. The shapes are
// the generated client's, so a contract change breaks the fixtures here rather than
// silently changing what the views are tested against — which is the point of building
// them from the generated types.

import type {
  ForecastRecordSummary,
  HourlyThresholdMarkets,
  MarketOverview,
  PaperBudget,
  PaperPerformance,
  PaperPerformanceSummary,
  PaperTrackRecord,
} from '@money-noodle/platform-api-client';
import { describe, expect, it } from 'vitest';

export const API_TIME = '2026-10-05T19:30:00.000Z';
export const SOURCE_TIME = '2026-09-07T04:05:06.000Z';

export function syntheticMarketOverview(overrides: Partial<MarketOverview> = {}): MarketOverview {
  return {
    assets: [
      {
        basis: {
          basisPercent: 0.1875,
          currentPrice: 64_120,
          impliedVolatilityPerSecond: 0.0000321,
          probabilityUp: 0.62,
          referencePrice: 64_000,
          referenceSource: 'Kraken 1m series at cycle open',
          secondsRemaining: 450,
          standardDeviationPercent: 0.82,
          volatilityPerSecond: 0.0000269,
          volatilityRatio: 0.838,
          volatilitySamples: 29,
          zScore: 0.228,
        },
        kalshi: {
          askDown: 0.52,
          askUp: 0.5,
          bidDown: 0.48,
          bidUp: 0.48,
          closesAt: '2026-10-05T19:45:00.000Z',
          contractId: 'SYNTH-KALSHI-15M',
          floorStrike: 64_000,
          liquidityUsd: 12_000,
          live: true,
          probabilityUp: 0.49,
          ticker: 'SYNTH-KALSHI-15M',
          url: 'https://kalshi.com/markets/synth15m',
          venue: 'kalshi',
          volumeContracts: 800,
        },
        longHistory: [
          { price: 61_000, time: '2026-09-21T00:00:00.000Z' },
          { price: 63_500, time: '2026-09-28T00:00:00.000Z' },
        ],
        name: 'Synthcoin',
        polymarket: {
          askUp: 0.54,
          bidUp: 0.52,
          closesAt: '2026-10-05T19:45:00.000Z',
          contractId: 'SYNTH-POLY-15M',
          liquidityUsd: 90_000,
          live: true,
          probabilityDown: 0.47,
          probabilityUp: 0.53,
          url: 'https://polymarket.com/event/synth-updown-15m-0',
          venue: 'polymarket',
          volumeUsd: 450_000,
        },
        spot: {
          change1hPercent: 0.4,
          change24hPercent: 1.25,
          change7dPercent: -3.1,
          chart: [
            { price: 63_000, time: '2026-09-28T19:30:00.000Z' },
            { price: 63_500, time: '2026-10-02T07:30:00.000Z' },
            { price: 64_100, time: API_TIME },
          ],
          high24h: 64_500,
          iconUrl: 'https://assets.invalid/synth.png',
          low24h: 62_800,
          price: 64_100,
          volume24h: 1_234_000_000,
        },
        symbol: 'SYN',
        venueDisagreement: 0.04,
        venueProbabilityUp: 0.52,
      },
      {
        // An asset the venues have not listed: no quote, no spot, no basis.
        longHistory: [],
        name: 'Quietcoin',
        symbol: 'QUI',
      },
    ],
    feeds: {
      kalshiQuotes: { ageSeconds: 3, fetchedAt: API_TIME, state: 'fresh' },
      longHistory: { ageSeconds: 3_600, fetchedAt: '2026-10-05T18:30:00.000Z', state: 'fresh' },
      news: { ageSeconds: 120, fetchedAt: '2026-10-05T19:28:00.000Z', state: 'fresh' },
      polymarketQuotes: { ageSeconds: 2, fetchedAt: API_TIME, state: 'fresh' },
      referencePrices: { ageSeconds: 1, fetchedAt: API_TIME, state: 'fresh' },
      spot: { ageSeconds: 30, fetchedAt: '2026-10-05T19:29:30.000Z', state: 'fresh' },
    },
    generatedAt: API_TIME,
    headlines: [
      {
        link: 'https://news.invalid/synthetic-story',
        publishedAt: '2026-10-05T18:00:00.000Z',
        title: 'A synthetic headline about a synthetic asset',
      },
      { title: 'A headline the publisher gave no link for' },
    ],
    marketId: 'crypto-15m',
    requestId: 'synthetic-request',
    schemaVersion: '1',
    ...overrides,
  };
}

export function syntheticHourlyThresholds(
  overrides: Partial<HourlyThresholdMarkets> = {},
): HourlyThresholdMarkets {
  return {
    capability: { live: false, marketData: true, paper: false },
    generatedAt: API_TIME,
    marketDataVersion: 'kalshi-hourly-threshold-read-v1',
    marketId: 'crypto-1h',
    markets: [
      {
        candidates: [
          {
            askYes: 0.55,
            bidYes: 0.53,
            direction: 'ABOVE',
            displaySide: 'UP',
            label: 'Above 64000',
            marketUrl: 'https://kalshi.com/markets/synth',
            modelMinusAsk: 0.0123,
            modelProbabilityYes: 0.5623,
            relation: 'greater-than',
            rulesFingerprint: 'a'.repeat(64),
            settlementPriceMethod: 'simple-average',
            strike: 64_000,
            ticker: 'SYNTH-26OCT0520-T64000',
          },
          {
            bidNo: 0.47,
            direction: 'BELOW',
            displaySide: 'DOWN',
            label: 'Below 63500',
            marketUrl: 'https://kalshi.com/markets/synth',
            modelUnavailableReason: 'volatility-unavailable',
            relation: 'less-than',
            rulesFingerprint: 'b'.repeat(64),
            settlementPriceMethod: 'unknown',
            strike: 63_500,
            ticker: 'SYNTH-26OCT0520-T63500',
          },
        ],
        closesAt: '2026-10-05T20:00:00.000Z',
        currentPrice: 63_875,
        listing: { ageSeconds: 12, fetchedAt: API_TIME, state: 'fresh' },
        marketDataAvailable: true,
        name: 'Synthcoin',
        openAt: '2026-10-05T19:00:00.000Z',
        spot: { ageSeconds: 4, fetchedAt: API_TIME, state: 'fresh' },
        symbol: 'SYN',
        volatilityPerSecond: 0.0000269,
        volatilitySamples: 39,
      },
      {
        candidates: [],
        listing: {
          ageSeconds: 0,
          reason: 'upstream-timeout',
          state: 'unavailable',
        },
        marketDataAvailable: false,
        name: 'Quietcoin',
        symbol: 'QUI',
        unavailableReasons: ['upstream-timeout'],
      },
    ].map((market) => ({ unavailableReasons: [], ...market })) as HourlyThresholdMarkets['markets'],
    modelVersion: 'strike-threshold-zero-drift-v1',
    providerId: 'kalshi',
    referenceSource: 'CF Benchmarks RTI 60-second simple average',
    requestId: 'synthetic-request',
    schemaVersion: '1',
    ...overrides,
  };
}

export function syntheticPaperBudget(overrides: Partial<PaperBudget> = {}): PaperBudget {
  return {
    availableCents: 61_250,
    bankrollResets: 2,
    depleted: false,
    durable: true,
    equityCents: 73_750,
    openOrders: 1,
    proposedStakeCents: 5_000,
    realizedPnlCents: -1_250,
    recentExecutions: [
      {
        askPrice: 0.42,
        closesAt: '2026-09-07T04:15:00.000Z',
        createdAt: '2026-09-07T04:01:00.000Z',
        executionKey: 'synthetic-execution-1',
        feeCents: 12,
        liquidityRole: 'maker',
        outcome: 'UP',
        pnlCents: 580,
        quantity: 11.9,
        side: 'UP',
        stakeCents: 500,
        status: 'won',
        symbol: 'SYN',
        venue: 'polymarket',
      },
      {
        askPrice: 0.5,
        closesAt: '2026-09-07T04:30:00.000Z',
        createdAt: '2026-09-07T04:16:00.000Z',
        executionKey: 'synthetic-execution-2',
        feeCents: 0,
        noFillReason: 'post_only_race',
        quantity: 0,
        side: 'DOWN',
        stakeCents: 0,
        status: 'unfilled',
        symbol: 'QUI',
        venue: 'kalshi',
      },
    ],
    requestId: 'synthetic-request',
    reservedCents: 12_500,
    running: true,
    schemaVersion: '1',
    settledOrders: 24,
    sourceUpdatedAt: SOURCE_TIME,
    startingCents: 75_000,
    ...overrides,
  };
}

const syntheticTrackRecord = (): PaperTrackRecord => ({
  actionCounterfactualVersion: 'synthetic-counterfactual-v1',
  actionCounterfactuals: [
    {
      action: 'hold',
      alternative: 'exit at quote',
      basis: 'recorded decisions',
      credible: false,
      decisions: 9,
      decisionsBeatingAlternative: 5,
      description: 'A synthetic comparison.',
      hitRate: 0.5556,
      incrementalCents: 240,
      meanIncrementalCents: 26.7,
      meanIncrementalReturn: 0.012,
      incrementalReturnStandardError: 0.004,
      alternativePnlCents: -120,
      policy: 'synthetic-policy',
      takenPnlCents: 120,
      windows: 7,
    },
  ],
  invalid: 1,
  losses: 9,
  meanPredictedEdge: 0.031,
  meanPrincipalRecoveryVsFullExitCents: null,
  meanRealizedReturn: 0.018,
  meanSwitchVsHoldCents: null,
  mode: 'paper',
  pending: 1,
  principalRecoveryExitsEvaluated: 0,
  principalRecoveryVsFullExitCents: null,
  realizedPnlCents: -1_190,
  rejected: 0,
  returnedCents: 10_810,
  roi: -0.099,
  segments: [
    {
      description: 'A synthetic segment group.',
      dimension: 'venue',
      segments: [
        {
          label: 'polymarket',
          meanPredictedEdge: 0.03,
          meanRealizedReturn: 0.02,
          standardError: 0.01,
          trades: 15,
          windows: 9,
          winRate: 0.6,
        },
      ],
    },
  ],
  settled: 24,
  sold: 2,
  stakedCents: 12_000,
  standaloneExitsEvaluated: 3,
  standardError: 0.009,
  switchesEvaluated: 4,
  unfilled: 3,
  windows: 14,
  winRate: 0.5833,
  wins: 14,
});

const syntheticRecordSummary = (): ForecastRecordSummary => ({
  accuracy: 0.5417,
  benchmarks: [
    {
      accuracy: 0.5,
      brierScore: 0.25,
      label: 'always up',
      logLoss: 0.693,
      resolved: 24,
    },
  ],
  brierScore: 0.2412,
  byAsset: [{ accuracy: 0.6, correct: 6, label: 'SYN', resolved: 10 }],
  byConfidenceBucket: [{ accuracy: 0.5, correct: 5, label: '0.50–0.60', resolved: 10 }],
  byDirection: [{ accuracy: 0.52, correct: 13, label: 'UP', resolved: 25 }],
  byLeadTime: [
    { accuracy: 0.55, brierScore: 0.24, correct: 11, label: 'under 5 min', resolved: 20 },
  ],
  byModelVersion: [{ accuracy: 0.54, correct: 13, label: 'synthetic-model-v1', resolved: 24 }],
  calibrationBins: [{ label: '0.50–0.60', meanForecast: 0.55, observedRate: 0.52, resolved: 12 }],
  calibrationMinimum: 30,
  calibrationProgress: 0.4667,
  calibrationReady: false,
  calibrationWindows: 14,
  correct: 13,
  currentCycleStreak: -2,
  currentStreak: -1,
  cycleBalancedAccuracy: 0.5333,
  cycles: 18,
  edgeBuckets: [
    { label: '0–2 pp', predictedEdge: 0.012, realizedReturn: -0.004, trades: 8, winRate: 0.5 },
  ],
  evaluationMeaningful: false,
  evaluationMinimumWindows: 25,
  invalid: 1,
  issued: 31,
  logLoss: 0.688,
  meanPredictedEdge: 0.031,
  meanRealizedReturn: 0.018,
  missedBuyCounterfactual: {
    bestPerWindowCandidates: 7,
    bestPerWindowMeanReturn: 0.03,
    bestPerWindowStandardError: 0.01,
    bestPerWindowTotalReturn: 0.21,
    bestPerWindowWins: 4,
    candidates: 19,
    description: 'A synthetic counterfactual.',
    label: 'not taken',
    meanCandidateReturn: 0.01,
    profitableCandidates: 9,
    standardError: 0.008,
    windows: 7,
  },
  observedCalculations: 40,
  pending: 6,
  realizedEdgeTrades: 21,
  recent: [
    {
      confidence: 0.55,
      correct: false,
      direction: 'UP',
      directionalLikelihood: 0.58,
      id: 'synthetic-forecast-1',
      issuedAt: SOURCE_TIME,
      modelVersion: 'synthetic-model-v1',
      outcome: 'DOWN',
      policyVersion: 'synthetic-policy-v1',
      status: 'resolved',
      symbol: 'SYN',
    },
    {
      confidence: 0.51,
      direction: 'DOWN',
      directionalLikelihood: 0.52,
      id: 'synthetic-forecast-2',
      issuedAt: SOURCE_TIME,
      modelVersion: 'synthetic-model-v1',
      policyVersion: 'synthetic-policy-v1',
      status: 'pending',
      symbol: 'QUI',
    },
  ],
  resolved: 24,
  resolvedCalculations: 24,
  resolvedCycles: 15,
  resolvedWindows: 14,
  segments: [
    {
      description: 'A synthetic forecast segment group.',
      dimension: 'asset',
      segments: [
        {
          label: 'SYN',
          meanPredictedEdge: 0.03,
          meanRealizedReturn: 0.02,
          standardError: 0.01,
          trades: 10,
          windows: 6,
          winRate: 0.6,
        },
      ],
    },
  ],
  timeline: [
    {
      cumulativeAccuracy: 0.5,
      cumulativeBrier: 0.25,
      resolved: 10,
      rollingAccuracy: 0.5,
      time: '2026-09-06T00:00:00.000Z',
    },
    {
      cumulativeAccuracy: 0.5417,
      cumulativeBrier: 0.2412,
      resolved: 24,
      rollingAccuracy: 0.55,
      time: SOURCE_TIME,
    },
  ],
});

export function syntheticPaperPerformanceSummary(
  overrides: Partial<PaperPerformanceSummary> = {},
): PaperPerformanceSummary {
  const full = syntheticRecordSummary();
  return {
    durable: true,
    generatedAt: SOURCE_TIME,
    paperRecord: {
      losses: 9,
      meanPredictedEdge: 0.031,
      meanRealizedReturn: 0.018,
      mode: 'paper',
      realizedPnlCents: -1_190,
      roi: -0.099,
      settled: 24,
      windows: 14,
      winRate: 0.5833,
      wins: 14,
    },
    requestId: 'synthetic-request',
    schemaVersion: '1',
    sourceUpdatedAt: '2026-09-07T04:10:00.000Z',
    summary: {
      accuracy: full.accuracy,
      brierScore: full.brierScore,
      calibrationMinimum: full.calibrationMinimum,
      calibrationProgress: full.calibrationProgress,
      calibrationReady: full.calibrationReady,
      calibrationWindows: full.calibrationWindows,
      currentCycleStreak: full.currentCycleStreak,
      cycleBalancedAccuracy: full.cycleBalancedAccuracy,
      cycles: full.cycles,
      issued: full.issued,
      recent: full.recent,
      resolved: full.resolved,
      resolvedCycles: full.resolvedCycles,
    },
    ...overrides,
  };
}

export function syntheticPaperPerformance(
  overrides: Partial<PaperPerformance> = {},
): PaperPerformance {
  return {
    durable: true,
    forecasts: syntheticRecordSummary().recent,
    generatedAt: SOURCE_TIME,
    paperEpochs: [
      {
        budgetPnlCents: -1_250,
        current: true,
        epochId: 'synthetic-epoch-2',
        firstAt: '2026-09-01T00:00:00.000Z',
        lastAt: SOURCE_TIME,
        realizedPnlCents: -1_190,
        settled: 24,
        stakedCents: 12_000,
        trades: 27,
      },
      {
        budgetPnlCents: 0,
        current: false,
        epochId: 'synthetic-epoch-1',
        realizedPnlCents: 0,
        settled: 0,
        stakedCents: 0,
        trades: 0,
      },
    ],
    paperProviderRecords: [
      { marketId: 'crypto-15m', providerId: 'polymarket', record: syntheticTrackRecord() },
    ],
    paperRecord: syntheticTrackRecord(),
    requestId: 'synthetic-request',
    schemaVersion: '1',
    sourceUpdatedAt: '2026-09-07T04:10:00.000Z',
    summary: syntheticRecordSummary(),
    cyclePaths: {
      completedCycles: 15,
      latestByAsset: [
        {
          closesAt: SOURCE_TIME,
          features: {
            coverageSeconds: 840,
            lagOneAutocorrelation: -0.1,
            localVolatility15mPercent: 0.4,
            localVolatilityPerSecond: 0.00003,
            observationCount: 120,
            observedAt: SOURCE_TIME,
            rangePercent: 0.6,
            regime: 'mixed',
            signFlipRate: 0.48,
            trendEfficiency: 0.2,
          },
          symbol: 'SYN',
        },
      ],
      policyVersion: 'synthetic-policy-v1',
      totalCycles: 18,
      totalPoints: 2_160,
    },
    ...overrides,
  };
}

describe('synthetic records', () => {
  // That these satisfy the guards is asserted where the guards live. What is asserted here
  // is the other half of the contract these fixtures have with this repository: nothing in
  // them came from a deployment (SECURITY.md).
  const records = [
    syntheticMarketOverview(),
    syntheticHourlyThresholds(),
    syntheticPaperBudget(),
    syntheticPaperPerformanceSummary(),
    syntheticPaperPerformance(),
  ];

  it('carry no real identifier, host or record', () => {
    for (const record of records) {
      const serialised = JSON.stringify(record);
      expect(serialised).toContain('synthetic');
      // No deployment of this platform, and no credential-shaped value.
      for (const forbidden of ['noodle.money', 'run.app', 'googleapis', 'Bearer ', 'secret']) {
        expect(serialised).not.toContain(forbidden);
      }
      // Only invented hosts, and the venues' own public pages.
      for (const host of serialised.match(/https?:\/\/[^"/]+/gu) ?? []) {
        expect(host).toMatch(/\.invalid$|kalshi\.com$|polymarket\.com$/u);
      }
    }
  });

  it('carry the stopped-writer era of the simulation, not today', () => {
    // The views have to show an old record as old, so the fixtures have to be old.
    for (const time of [SOURCE_TIME, syntheticPaperBudget().sourceUpdatedAt]) {
      expect(time.startsWith('2026-09-')).toBe(true);
    }
    expect(API_TIME.startsWith('2026-10-')).toBe(true);
  });
});
