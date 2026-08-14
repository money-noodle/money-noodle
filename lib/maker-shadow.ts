import { venueFeeRate } from './prediction-policy';
import type { ExecutionMode, PaperOrder } from './types';

/**
 * What paper would have returned under maker execution instead of its immediate-ask fill.
 *
 * Paper enters at the ask and always fills, which is conservative on price and unrealistically certain
 * on execution. Live rests a post-only limit at the bid: cheaper when it fills, nothing when it does
 * not. Roughly half of live maker attempts never fill, so paper's fill certainty is the single largest
 * way the two tracks diverge, and it is invisible in paper's own numbers.
 *
 * The shadow separates the two effects rather than blending them:
 *   price improvement — the same settled outcome bought at the bid rather than the ask
 *   fill risk         — the chance the resting order never traded, earning nothing
 *
 * Observation only. It changes no gate and places no order.
 */

export interface MakerShadowRow {
  id: string;
  closesAt: string;
  /** Return entering at the ask: realized for ask-filled orders, re-priced for maker-executed ones. */
  askReturn: number;
  /** Return entering at the bid: re-priced for ask-filled orders, realized for maker-executed ones. */
  makerReturn: number | null;
  /** Fill chance applied to the maker counterfactual. Null once the order actually rested and filled. */
  fillProbability: number | null;
  /** makerReturn including fill risk; equal to makerReturn when the order already survived that risk. */
  expectedMakerReturn: number | null;
}

export interface ShadowCohort {
  label: string;
  windows: number;
  askReturn: number | null;
  expectedMakerReturn: number | null;
}

export interface TailConcentration {
  totalWindowReturn: number;
  /** Absolute contribution of the best window and the best three, always meaningful. */
  topWindowContribution: number;
  topThreeContribution: number;
  /**
   * Share of the total carried by the best window / best three. Null when the total is not positive,
   * because a share of a negative total inverts its sign and reads as the opposite of what it means.
   */
  topWindowShare: number | null;
  topThreeShare: number | null;
  /** What remains after removing the best three. Below the total means those windows carried the book. */
  withoutTopThree: number;
}

export interface MakerShadowReport {
  mode: ExecutionMode;
  settled: number;
  /** Orders carrying a recorded fill estimate, which is what the weighted figures are computed from. */
  modelled: number;
  meanAskReturn: number | null;
  meanMakerReturnWhenFilled: number | null;
  meanExpectedMakerReturn: number | null;
  meanFillProbability: number | null;
  /** Clustered by settlement window, the independent unit for this book. */
  windows: number;
  clusteredAskReturn: number | null;
  clusteredExpectedMakerReturn: number | null;
  /** Recent versus earlier halves, so a decaying edge is visible rather than averaged away. */
  cohorts: ShadowCohort[];
  tail: TailConcentration;
  bySymbol: Array<ShadowCohort & { symbol: string }>;
  rows: MakerShadowRow[];
}

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);
const stake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents ?? 0;
const pnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/**
 * The same settled contract re-priced at a different entry, holding quantity and outcome fixed so only
 * the entry price and its fee move. This isolates price improvement from any difference in what traded.
 */
function returnAtPrice(order: PaperOrder, price: number): number | null {
  if (!(price > 0) || !(price < 1) || !(order.quantity > 0)) return null;
  const feeRate = venueFeeRate(order.venue, price);
  const stakeCents = order.quantity * (price + feeRate) * 100;
  if (!(stakeCents > 0)) return null;
  // Payout is a property of the settled outcome, not of the entry price.
  const payoutCents = order.payoutCents ?? (stake(order) + pnl(order));
  return (payoutCents - stakeCents) / stakeCents;
}

/**
 * Which side of the comparison actually happened.
 *
 * Since 2026-08-14 paper executes as a maker, so its realized return *is* the maker return and the
 * always-fills benchmark is the counterfactual. Before that, paper filled at the ask and the maker side
 * was the counterfactual. Both eras are scored into the same two columns — `askReturn` always means
 * "filled at the ask" and `expectedMakerReturn` always means "resting at the bid, fill risk included" —
 * so the series stays readable across the change instead of inverting halfway through.
 *
 * One caveat the numbers cannot remove: for maker-executed orders this population is conditioned on
 * having filled, because an unfilled attempt never settles and has no payout to re-price. The
 * always-fills column is therefore optimistic for that era until unfilled attempts are joined to their
 * forecast outcomes.
 */
const executedAsMaker = (order: PaperOrder) => order.liquidityRole === 'maker';
const askPriceFor = (order: PaperOrder): number => order.issuanceAskPrice
  ?? order.entryDecision?.actionableAsk
  ?? (executedAsMaker(order) ? order.bidPrice + (order.spread ?? 0) : order.askPrice);

function makerReturnFor(order: PaperOrder): number | null {
  const bid = order.bidPrice;
  if (!(bid > 0) || !(bid < 1) || !(order.quantity > 0)) return null;
  const feeRate = venueFeeRate(order.venue, bid);
  const makerStakeCents = order.quantity * (bid + feeRate) * 100;
  if (!(makerStakeCents > 0)) return null;
  // Payout is a property of the settled outcome, not of the entry price.
  const payoutCents = order.payoutCents ?? (stake(order) + pnl(order));
  return (payoutCents - makerStakeCents) / makerStakeCents;
}

export function buildMakerShadow(orders: PaperOrder[], mode: ExecutionMode): MakerShadowReport {
  const settled = orders.filter((order) => order.executionMode === mode && settledStatuses.has(order.status)
    && !order.id.includes(':exit:'));
  const symbolOf = new Map<string, string>();
  const rows: MakerShadowRow[] = settled.map((order) => {
    symbolOf.set(order.id, order.symbol);
    const realized = pnl(order) / Math.max(1, stake(order));
    const maker = executedAsMaker(order);
    // A maker order that filled carries no residual fill risk, so its expected return is what it did.
    const askReturn = maker ? (returnAtPrice(order, askPriceFor(order)) ?? realized) : realized;
    const makerReturn = maker ? realized : makerReturnFor(order);
    const fillProbability = maker ? null : (order.makerFillEstimate?.probability ?? null);
    const expectedMakerReturn = maker
      ? makerReturn
      : makerReturn === null || fillProbability === null ? null : makerReturn * fillProbability;
    return { id: order.id, closesAt: order.closesAt, askReturn, makerReturn, fillProbability, expectedMakerReturn };
  });
  const modelledRows = rows.filter((row) => row.expectedMakerReturn !== null);

  const byWindow = new Map<string, MakerShadowRow[]>();
  for (const row of modelledRows) byWindow.set(row.closesAt, [...(byWindow.get(row.closesAt) ?? []), row]);
  const windowPairs = [...byWindow.values()].map((group) => ({
    ask: mean(group.map((row) => row.askReturn)) ?? 0,
    expected: mean(group.map((row) => row.expectedMakerReturn!)) ?? 0,
  }));

  // Windows in chronological order, so cohorts split on time rather than on outcome.
  const orderedWindows = [...byWindow.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const cohortOf = (entries: typeof orderedWindows, label: string): ShadowCohort => ({
    label, windows: entries.length,
    askReturn: mean(entries.map(([, group]) => mean(group.map((row) => row.askReturn)) ?? 0)),
    expectedMakerReturn: mean(entries.map(([, group]) => mean(group.map((row) => row.expectedMakerReturn!)) ?? 0)),
  });
  const half = Math.floor(orderedWindows.length / 2);
  const cohorts = orderedWindows.length >= 4
    ? [cohortOf(orderedWindows.slice(0, half), 'earlier half'), cohortOf(orderedWindows.slice(half), 'recent half')]
    : [];

  // Tail concentration on the ask-return series, which is what actually happened rather than a model.
  const windowTotals = orderedWindows.map(([, group]) => mean(group.map((row) => row.askReturn)) ?? 0);
  const totalWindowReturn = windowTotals.reduce((sum, value) => sum + value, 0);
  const ranked = [...windowTotals].sort((a, b) => b - a);
  const contribution = (count: number) => ranked.slice(0, count).reduce((sum, value) => sum + value, 0);
  const share = (count: number) => totalWindowReturn > 0 ? contribution(count) / totalWindowReturn : null;
  const tail: TailConcentration = {
    totalWindowReturn,
    topWindowContribution: contribution(1),
    topThreeContribution: contribution(3),
    topWindowShare: share(1),
    topThreeShare: share(3),
    withoutTopThree: totalWindowReturn - contribution(3),
  };

  const symbols = [...new Set(rows.map((row) => symbolOf.get(row.id)!).filter(Boolean))];
  const bySymbol = symbols.map((symbol) => {
    const own = modelledRows.filter((row) => symbolOf.get(row.id) === symbol);
    const ownWindows = new Map<string, MakerShadowRow[]>();
    for (const row of own) ownWindows.set(row.closesAt, [...(ownWindows.get(row.closesAt) ?? []), row]);
    return { symbol, ...cohortOf([...ownWindows.entries()], symbol) };
  }).sort((a, b) => (b.expectedMakerReturn ?? 0) - (a.expectedMakerReturn ?? 0));

  return {
    mode, settled: rows.length, modelled: modelledRows.length,
    meanAskReturn: mean(rows.map((row) => row.askReturn)),
    meanMakerReturnWhenFilled: mean(rows.map((row) => row.makerReturn).filter((value): value is number => value !== null)),
    meanExpectedMakerReturn: mean(modelledRows.map((row) => row.expectedMakerReturn!)),
    meanFillProbability: mean(rows.map((row) => row.fillProbability).filter((value): value is number => value !== null)),
    windows: windowPairs.length,
    clusteredAskReturn: mean(windowPairs.map((pair) => pair.ask)),
    clusteredExpectedMakerReturn: mean(windowPairs.map((pair) => pair.expected)),
    cohorts, tail, bySymbol,
    rows,
  };
}
