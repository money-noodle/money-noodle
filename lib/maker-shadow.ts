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
  /** Return actually achieved by the immediate-ask paper fill. */
  askReturn: number;
  /** Return the same outcome would have produced entering at the bid. */
  makerReturn: number | null;
  /** Modelled chance the resting order traded at all, from the recorded first-passage estimate. */
  fillProbability: number | null;
  /** makerReturn weighted by fill chance; an unfilled order returns nothing and risks nothing. */
  expectedMakerReturn: number | null;
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
  rows: MakerShadowRow[];
}

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);
const stake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents ?? 0;
const pnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/**
 * The same settled contract bought at the bid. Quantity and outcome are held fixed: only the entry price
 * and its fee change, which isolates price improvement from any difference in what was traded.
 */
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
  const rows: MakerShadowRow[] = settled.map((order) => {
    const askReturn = pnl(order) / Math.max(1, stake(order));
    const makerReturn = makerReturnFor(order);
    const fillProbability = order.makerFillEstimate?.probability ?? null;
    return {
      id: order.id, closesAt: order.closesAt, askReturn, makerReturn, fillProbability,
      expectedMakerReturn: makerReturn === null || fillProbability === null ? null : makerReturn * fillProbability,
    };
  });
  const modelledRows = rows.filter((row) => row.expectedMakerReturn !== null);

  const byWindow = new Map<string, MakerShadowRow[]>();
  for (const row of modelledRows) byWindow.set(row.closesAt, [...(byWindow.get(row.closesAt) ?? []), row]);
  const windowPairs = [...byWindow.values()].map((group) => ({
    ask: mean(group.map((row) => row.askReturn)) ?? 0,
    expected: mean(group.map((row) => row.expectedMakerReturn!)) ?? 0,
  }));

  return {
    mode, settled: rows.length, modelled: modelledRows.length,
    meanAskReturn: mean(rows.map((row) => row.askReturn)),
    meanMakerReturnWhenFilled: mean(rows.map((row) => row.makerReturn).filter((value): value is number => value !== null)),
    meanExpectedMakerReturn: mean(modelledRows.map((row) => row.expectedMakerReturn!)),
    meanFillProbability: mean(rows.map((row) => row.fillProbability).filter((value): value is number => value !== null)),
    windows: windowPairs.length,
    clusteredAskReturn: mean(windowPairs.map((pair) => pair.ask)),
    clusteredExpectedMakerReturn: mean(windowPairs.map((pair) => pair.expected)),
    rows,
  };
}
