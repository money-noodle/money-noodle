import { describe, expect, it } from 'vitest';
import {
  CALENDAR_EVALUATION_VERSION, buildCalendarEvaluationReport, calendarFixedSnapshotDue, replayCalendarEvaluationEvents,
  type CalendarEvaluationEvent,
} from './calendar-evaluation-store';
import type { CalendarForecastObservation, CalendarWindowObservation } from './types';

const policy = 'production-v1';
const close = '2026-08-14T00:15:00.000Z';
const forecast = (patch: Partial<CalendarForecastObservation> = {}): CalendarForecastObservation => ({
  id: 'forecast:BTC', collectionVersion: CALENDAR_EVALUATION_VERSION, policyVersion: policy,
  modelVersion: 'model-v1', symbol: 'BTC', contractId: 'BTC-CONTRACT', closesAt: close,
  observedAt: '2026-08-14T00:10:00.000Z', secondsRemaining: 300,
  probabilityUp: 0.6, confidence: 0.7, askUp: 0.5, bidUp: 0.49, askDown: 0.51, bidDown: 0.5,
  estimatedFeeUp: 0.01, estimatedFeeDown: 0.01, qualified: true, selectedSide: 'UP',
  predictedNetEdge: 0.09, factors: [], outcome: 'UP', resolvedAt: '2026-08-14T00:16:00.000Z',
  brierScore: 0.1, correct: true, ...patch,
});
const window = (patch: Partial<CalendarWindowObservation> = {}): CalendarWindowObservation => ({
  id: 'window:1', collectionVersion: CALENDAR_EVALUATION_VERSION, policyVersion: policy, closesAt: close,
  evaluationAt: '2026-08-14T00:10:00.000Z', firstObservedAt: '2026-08-14T00:01:00.000Z',
  candidateStatus: 'selected', candidate: {
    symbol: 'BTC', contractId: 'BTC-CONTRACT', side: 'UP', createdAt: '2026-08-14T00:08:00.000Z',
    selectedSideProbability: 0.6, confidence: 0.7, askPrice: 0.5, bidPrice: 0.49,
    estimatedFeeRate: 0.01, estimatedMakerFeeRate: 0.005, predictedNetEdge: 0.09,
    makerFillProbability: 0.5, outcome: 'UP', resolvedAt: '2026-08-14T00:16:00.000Z',
    askProfitPerContract: 0.49, makerExpectedProfitPerContract: 0.2525,
  }, ...patch,
});

const store = (forecasts: CalendarForecastObservation[], windows: CalendarWindowObservation[]) => ({
  collectionVersion: CALENDAR_EVALUATION_VERSION,
  startedAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T01:00:00.000Z', forecasts, windows,
});

describe('calendar evaluation store', () => {
  it('captures only the precommitted five-minute tolerance', () => {
    expect(calendarFixedSnapshotDue(300)).toBe(true);
    expect(calendarFixedSnapshotDue(270)).toBe(true);
    expect(calendarFixedSnapshotDue(300.01)).toBe(false);
    expect(calendarFixedSnapshotDue(269.99)).toBe(false);
  });

  it('replays idempotent forecast and window upserts', () => {
    const revised = forecast({ brierScore: 0.2 });
    const events: CalendarEvaluationEvent[] = [
      { op: 'forecast', value: forecast() }, { op: 'forecast', value: revised }, { op: 'window', value: window() },
    ];
    const replayed = replayCalendarEvaluationEvents({ forecasts: [], windows: [] }, events);
    expect(replayed.forecasts).toEqual([revised]);
    expect(replayed.windows).toHaveLength(1);
  });

  it('clusters fixed forecasts by settlement window instead of treating assets as independent', () => {
    const report = buildCalendarEvaluationReport(store([
      forecast(), forecast({ id: 'forecast:ETH', symbol: 'ETH', contractId: 'ETH-CONTRACT', brierScore: 0.3, correct: false }),
    ], [window()]), policy);
    const band = report.timeBands.find((item) => item.fixedForecasts === 2)!;
    expect(band.resolvedForecastWindows).toBe(1);
    expect(band.brierScore).toBeCloseTo(0.2);
    expect(band.forecastAccuracy).toBe(0.5);
    expect(band.resolvedCandidateWindows).toBe(1);
    expect(report.timeReviewReady).toBe(false);
    expect(report.productionChanged).toBe(false);
  });

  it('retains but never blends superseded policy evidence', () => {
    const report = buildCalendarEvaluationReport(store([
      forecast(), forecast({ id: 'old', policyVersion: 'production-v0', brierScore: 0.9 }),
    ], [window(), window({ id: 'old-window', policyVersion: 'production-v0' })]), policy);
    expect(report.fixedForecasts).toBe(1);
    expect(report.observedWindows).toBe(1);
  });

  it('counts explicit no-candidate windows', () => {
    const report = buildCalendarEvaluationReport(store([], [
      window({ candidate: undefined, candidateStatus: 'none', finalizedAt: '2026-08-14T00:16:00.000Z' }),
    ]), policy);
    expect(report.noCandidateWindows).toBe(1);
    expect(report.resolvedCandidateWindows).toBe(0);
  });
});
