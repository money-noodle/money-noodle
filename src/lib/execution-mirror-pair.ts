import type { ExecutionMirrorPairStamp, MakerFillReport, PaperOrder } from './types';

export const ENTRY_EXECUTION_MIRROR_PAIR_VERSION = 'entry-execution-mirror-pair-v1' as const;

type PairIdentityOrder = Pick<PaperOrder,
  'strategyId' | 'providerId' | 'venue' | 'contractId' | 'side' | 'closesAt' | 'calculationAt' | 'entryEpisode' | 'attemptNumber'>;

/**
 * Prospective exact join for two intents built from one calculation. There is deliberately no timestamp
 * tolerance: if capital or serialized drain work moves a lane to another calculation, it is not the same
 * execution decision and must remain unpaired.
 */
export function executionMirrorPairStamp(order: PairIdentityOrder): ExecutionMirrorPairStamp {
  const fields = [
    order.strategyId ?? 'edge-binary-buy', order.providerId ?? order.venue, order.contractId,
    order.side, order.closesAt, order.calculationAt, String(order.entryEpisode ?? order.attemptNumber ?? 1),
  ];
  return {
    version: ENTRY_EXECUTION_MIRROR_PAIR_VERSION,
    id: `${ENTRY_EXECUTION_MIRROR_PAIR_VERSION}:${fields.map((value) => encodeURIComponent(value)).join(':')}`,
  };
}

const filled = (order: PaperOrder) => (order.filledCount ?? 0) > 1e-8;
const route = (order: PaperOrder) => order.entryExecutionDecision?.executedStyle
  ?? order.paperEntryRoute ?? order.liquidityRole;
const requestedQuantity = (order: PaperOrder) => order.requestedQuantity ?? order.quantity;

/** Complete prospective agreement report. Ambiguous ownership is visible and never resolved by order. */
export function buildExecutionMirrorPairReport(orders: PaperOrder[]): MakerFillReport['executionMirrorPairs'] {
  const stamped = orders.filter((order) => !order.id.includes(':exit:')
    && order.executionMirrorPair?.version === ENTRY_EXECUTION_MIRROR_PAIR_VERSION);
  const grouped = new Map<string, PaperOrder[]>();
  for (const order of stamped) {
    const id = order.executionMirrorPair!.id;
    grouped.set(id, [...(grouped.get(id) ?? []), order]);
  }

  let paperOnlyIntents = 0, liveOnlyIntents = 0, ambiguousPairIds = 0;
  const pairs: Array<{ paper: PaperOrder; live: PaperOrder }> = [];
  for (const rows of grouped.values()) {
    const paper = rows.filter((order) => order.executionMode === 'paper');
    const live = rows.filter((order) => order.executionMode === 'live');
    if (paper.length > 1 || live.length > 1) { ambiguousPairIds += 1; continue; }
    if (paper.length === 1 && live.length === 1) pairs.push({ paper: paper[0], live: live[0] });
    else if (paper.length === 1) paperOnlyIntents += 1;
    else if (live.length === 1) liveOnlyIntents += 1;
  }

  const terminal = (order: PaperOrder) => order.status !== 'pending_reservation' && order.status !== 'uncertain';
  const decidedPairs = pairs.filter((pair) => terminal(pair.paper) && terminal(pair.live));
  let bothFilled = 0, paperOnlyFills = 0, liveOnlyFills = 0, neitherFilled = 0;
  let sameRoute = 0, sameRequestedQuantity = 0, bothFilledSameQuantity = 0;
  const priceDifferences: number[] = [];
  for (const pair of pairs) {
    if (route(pair.paper) !== undefined && route(pair.paper) === route(pair.live)) sameRoute += 1;
    if (Math.abs(requestedQuantity(pair.paper) - requestedQuantity(pair.live)) <= 1e-8) sameRequestedQuantity += 1;
  }
  for (const pair of decidedPairs) {
    const paperFilled = filled(pair.paper), liveFilled = filled(pair.live);
    if (paperFilled && liveFilled) {
      bothFilled += 1;
      if (Math.abs((pair.paper.filledCount ?? 0) - (pair.live.filledCount ?? 0)) <= 1e-8) bothFilledSameQuantity += 1;
      if (pair.paper.authoritativeFillPrice !== undefined && pair.live.authoritativeFillPrice !== undefined) {
        priceDifferences.push(pair.paper.authoritativeFillPrice - pair.live.authoritativeFillPrice);
      }
    } else if (paperFilled) paperOnlyFills += 1;
    else if (liveFilled) liveOnlyFills += 1;
    else neitherFilled += 1;
  }
  const liveFills = bothFilled + liveOnlyFills;
  return {
    version: ENTRY_EXECUTION_MIRROR_PAIR_VERSION,
    stampedIntents: stamped.length,
    pairedIntents: pairs.length,
    decidedPairs: decidedPairs.length,
    awaitingPairs: pairs.length - decidedPairs.length,
    paperOnlyIntents,
    liveOnlyIntents,
    ambiguousPairIds,
    bothFilled,
    paperOnlyFills,
    liveOnlyFills,
    neitherFilled,
    sameRoute,
    sameRequestedQuantity,
    bothFilledSameQuantity,
    fillAgreement: decidedPairs.length ? (bothFilled + neitherFilled) / decidedPairs.length : null,
    paperCaptureOfLiveFills: liveFills ? bothFilled / liveFills : null,
    meanPaperMinusLiveFillPrice: priceDifferences.length
      ? priceDifferences.reduce((sum, value) => sum + value, 0) / priceDifferences.length : null,
  };
}
