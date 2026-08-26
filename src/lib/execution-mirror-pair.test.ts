import { describe, expect, it } from 'vitest';
import { buildExecutionMirrorPairReport, executionMirrorPairStamp } from './execution-mirror-pair';
import type { PaperOrder } from './types';

const order = (mode: 'paper' | 'live', patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: `${mode}:BTC:UP:2026-01-01T00:15:00Z`, logicalOrderId: `${mode}:BTC:UP:2026-01-01T00:15:00Z`,
  executionMode: mode, strategyId: 'edge-binary-buy', providerId: 'kalshi', symbol: 'BTC', venue: 'kalshi',
  contractId: 'KXBTC15M-TEST', side: 'UP', status: 'unfilled', createdAt: '2026-01-01T00:01:00.100Z',
  calculationAt: '2026-01-01T00:01:00.000Z', closesAt: '2026-01-01T00:15:00.000Z', entryEpisode: 1,
  modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
  quantity: 0.5, requestedQuantity: 0.5, stakeCents: 20, feeCents: 0, potentialPayoutCents: 50,
  ...patch,
});

function stamped(mode: 'paper' | 'live', patch: Partial<PaperOrder> = {}): PaperOrder {
  const result = order(mode, patch);
  result.executionMirrorPair = executionMirrorPairStamp(result);
  return result;
}

describe('prospective execution mirror pairs', () => {
  it('joins only exact decision identity and episode, independent of lane creation time', () => {
    const paper = stamped('paper');
    const live = stamped('live', { createdAt: '2026-01-01T00:01:18.000Z' });
    expect(paper.executionMirrorPair).toEqual(live.executionMirrorPair);
    expect(executionMirrorPairStamp({ ...live, calculationAt: '2026-01-01T00:01:15.000Z' }).id)
      .not.toBe(paper.executionMirrorPair!.id);
    expect(executionMirrorPairStamp({ ...live, entryEpisode: 2 }).id).not.toBe(paper.executionMirrorPair!.id);
  });

  it('reports all four fill cells and exact route, quantity, and price agreement', () => {
    const pairs: PaperOrder[] = [];
    const add = (suffix: number, paperFill: number, liveFill: number) => {
      const calculationAt = `2026-01-01T00:0${suffix}:00.000Z`;
      const paper = stamped('paper', {
        id: `paper-${suffix}`, calculationAt, status: paperFill ? 'open' : 'unfilled', filledCount: paperFill,
        authoritativeFillPrice: paperFill ? 0.4 : undefined, liquidityRole: 'maker',
      });
      const live = stamped('live', {
        id: `live-${suffix}`, calculationAt, status: liveFill ? 'open' : 'unfilled', filledCount: liveFill,
        authoritativeFillPrice: liveFill ? 0.39 : undefined, liquidityRole: 'maker',
      });
      pairs.push(paper, live);
    };
    add(1, 0.5, 0.5);
    add(2, 0.5, 0);
    add(3, 0, 0.5);
    add(4, 0, 0);
    const report = buildExecutionMirrorPairReport(pairs);
    expect(report).toMatchObject({
      stampedIntents: 8, pairedIntents: 4, decidedPairs: 4, awaitingPairs: 0,
      bothFilled: 1, paperOnlyFills: 1, liveOnlyFills: 1, neitherFilled: 1,
      sameRoute: 4, sameRequestedQuantity: 4, bothFilledSameQuantity: 1,
      fillAgreement: 0.5, paperCaptureOfLiveFills: 0.5,
    });
    expect(report.meanPaperMinusLiveFillPrice).toBeCloseTo(0.01);
  });

  it('withholds fill cells until both execution lifecycles are terminal', () => {
    const paper = stamped('paper', { status: 'pending_reservation' });
    const live = stamped('live', { status: 'unfilled' });
    expect(buildExecutionMirrorPairReport([paper, live])).toMatchObject({
      pairedIntents: 1, decidedPairs: 0, awaitingPairs: 1,
      bothFilled: 0, paperOnlyFills: 0, liveOnlyFills: 0, neitherFilled: 0,
      fillAgreement: null,
    });
  });

  it('reports one-sided and ambiguous identities without selecting a winner', () => {
    const paperOnly = stamped('paper', { calculationAt: '2026-01-01T00:01:00.000Z' });
    const liveOnly = stamped('live', { calculationAt: '2026-01-01T00:02:00.000Z' });
    const duplicateA = stamped('paper', { id: 'paper-a', calculationAt: '2026-01-01T00:03:00.000Z' });
    const duplicateB = stamped('paper', { id: 'paper-b', calculationAt: '2026-01-01T00:03:00.000Z' });
    const duplicateLive = stamped('live', { calculationAt: '2026-01-01T00:03:00.000Z' });
    expect(buildExecutionMirrorPairReport([paperOnly, liveOnly, duplicateA, duplicateB, duplicateLive])).toMatchObject({
      stampedIntents: 5, pairedIntents: 0, paperOnlyIntents: 1, liveOnlyIntents: 1,
      ambiguousPairIds: 1, bothFilled: 0, paperOnlyFills: 0, liveOnlyFills: 0, neitherFilled: 0,
    });
  });
});
