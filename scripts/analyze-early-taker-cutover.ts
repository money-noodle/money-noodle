/**
 * Measure: what a 2-second cancel-and-take-in-parallel rule would have returned on the v9 live
 * cohort, versus what the live rule actually returned.
 *
 * Rule under test: at the first management poll (~2s) a maker that has not filled is cancelled and a
 * taker IOC is placed at the then-current ask advanced by two venue ticks, assumed to fill at that
 * ask. Sizing, fees and rounding use the production functions (estimatePaperFill, venueFeeCents), so
 * the arithmetic matches the desk. Positions are held to settlement.
 *
 * Deciding correction: returns are clustered on the settlement window (clusterByWindow), because rows
 * closing in one window share a single market move. Reported for two cohorts: the 39 makers that
 * actually missed (the question as asked), and every maker still resting at the 2s poll (the honest
 * cohort, which forfeits the maker fills the rule would have cancelled).
 *
 * Known biases, stated up front: (0) only the earliest windows of the interval have resolved in
 * forecast-history, so the settled subsample is a contiguous block of time rather than a random one;
 * (1) settlement outcomes are read from the Kalshi venue outcome by
 * contract id, not the cross-venue top-level field; (2) holding to settlement is NOT the live rule,
 * which exits on strict-value and profit-reversal, so the comparison flatters the candidate wherever
 * an exit would have cut a loss; (3) the IOC is assumed to fill in full at the observed ask, checked
 * against recorded best-ask depth; (4) this is retroactive screening over one 8.7-hour interval and
 * can promote nothing.
 *
 * The exit replay walks the forecast-history observation series after entry and applies the production
 * evaluateExitPolicy with carried peak state, selling at the owned-side bid (derived as 1 - the
 * opposite side's ask, the binary complement). That series runs at ~30-60s while production evaluates
 * on every collector cycle (~17s), so the replay UNDER-triggers exits and is a lower bound on exit
 * activity.
 *
 * Read-only: touches no file under data/ and places no orders.
 */
import { estimatePaperFill, venueFeeCents } from '../src/lib/venue-fill';
import { evaluateExitPolicy } from '../src/lib/exit-policy';
import type { ExitObservationState } from '../src/lib/exit-policy';
import { clusterByWindow } from '../src/lib/action-counterfactual';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';
// @ts-expect-error -- untyped sibling helper; it is the sanctioned forecast-history read path.
import { readForecastHistory } from './lib/forecast-history.mjs';
import type { PaperOrder } from '../src/lib/types';

const V9 = 'maker-then-positive-edge-taker2-terminal-refusal-v9';
/**
 * The fixed interval this review reports. The desk keeps trading, so an unbounded cohort silently grows
 * and the published figures stop reproducing. Set MONEY_NOODLE_EARLY_TAKER_UNTIL to extend the window.
 */
const REVIEW_UNTIL = process.env.MONEY_NOODLE_EARLY_TAKER_UNTIL ?? '2026-08-28T01:48:47.193Z';
const CUTOVER_SECONDS = 2;
const TICK = 0.01;
const CUSHION_TICKS = 2;

// Both reads go through the sanctioned script helpers: the ledger reader hydrates archived v9 evidence,
// and the forecast-history reader replays sealed shards, the open shard, then the journal's upserts and
// patches. Reading the shards alone shows recently settled windows as permanently pending.
const ledger = await readExecutionLedger();
/** The subset of a tracked forecast this analysis reads. The helper is untyped JavaScript. */
interface HistoryRow {
  symbol?: string;
  closesAt?: string;
  issuedAt?: string;
  status?: string;
  probabilityUp?: number;
  confidence?: number;
  actionableVenuePrices?: { venue?: string; side?: string; price?: number }[];
  venueOutcomes?: { kalshi?: { contractId?: string; outcome?: string } };
}
const history = (await readForecastHistory('data')) as HistoryRow[];

// ---- settlement outcomes, keyed by Kalshi contract id ----------------------------------------
const outcomes = new Map<string, 'UP' | 'DOWN'>();
for (const row of history) {
  const k = row?.venueOutcomes?.kalshi;
  if (row.status === 'resolved' && k?.contractId && (k.outcome === 'UP' || k.outcome === 'DOWN')) outcomes.set(k.contractId, k.outcome);
}
console.log(`Kalshi settlements loaded: ${outcomes.size}`);
console.log(`Fixed interval: v9 live entries created through ${REVIEW_UNTIL}\n`);

// ---- post-entry observation series, for the exit replay ---------------------------------------
interface Obs { at: string; probUp: number; confidence: number; askUp?: number; askDown?: number }
const series = new Map<string, Obs[]>();
for (const e of history) {
  if (!e?.symbol || !e?.closesAt || !e?.issuedAt) continue;
  // typeof narrows the optional fields; Number.isFinite alone does not.
  const { probabilityUp, confidence } = e;
  if (typeof probabilityUp !== 'number' || !Number.isFinite(probabilityUp)) continue;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;
  const prices = e.actionableVenuePrices ?? [];
  const k = (side: string) => prices.find((p) => p.venue === 'kalshi' && p.side === side)?.price;
  const key = `${e.symbol}|${e.closesAt}`;
  series.set(key, [...(series.get(key) ?? []), { at: e.issuedAt, probUp: probabilityUp, confidence, askUp: k('UP'), askDown: k('DOWN') }]);
}
for (const list of series.values()) list.sort((a, b) => a.at.localeCompare(b.at));
console.log(`observation series: ${series.size} symbol-windows, ${history.length} history rows\n`);

const exitUncertainty = (confidence: number) => Math.max(0.03, Math.min(0.15, (1 - confidence) * 0.25));

// ---- cohort ------------------------------------------------------------------------------------
const evs = (o: PaperOrder) => o.entryExecutionObservations ?? [];
const term = (o: PaperOrder) => [...evs(o)].reverse().find((e) => e.event === 'terminal_fill');
const acc = (o: PaperOrder) => evs(o).find((e) => e.event === 'accepted');
const live = ledger.orders.filter((o) =>
  o.entryDecision?.executionPolicyVersion === V9 && o.executionMode === 'live' && o.attemptNumber === 1
  && o.createdAt <= REVIEW_UNTIL && acc(o) && term(o));

interface Row {
  order: PaperOrder; closesAt: string; label: string; wouldHaveFilledAsMaker: boolean;
  ask2: number; depth2: number | undefined; limit: number;
  quantity: number; costCents: number; feeCents: number; stakeCents: number;
  won: boolean; pnlCents: number; actualCents: number;
  exitAt?: string; exitBid?: number; exitPolicy?: string; exitPnlCents: number; exitObs: number;
}

const rows: Row[] = [];
const skipped: string[] = [];
for (const o of live) {
  const t0 = Date.parse(acc(o)!.at);
  const restedSeconds = term(o)!.restingDurationMs! / 1000;
  if (restedSeconds <= CUTOVER_SECONDS) { skipped.push(`${o.symbol} ${o.side} filled before the cutover`); continue; }
  const poll = evs(o).find((e) => Number.isFinite(e.selectedAsk) && (Date.parse(e.at) - t0) / 1000 >= CUTOVER_SECONDS);
  if (!poll) { skipped.push(`${o.symbol} ${o.side} no quote at the cutover`); continue; }
  const outcome = outcomes.get(o.contractId!);
  if (!outcome) { skipped.push(`${o.symbol} ${o.side} ${o.closesAt} unsettled`); continue; }

  const ask2 = poll.selectedAsk!;
  const limit = Math.min(0.75, Number((ask2 + CUSHION_TICKS * TICK).toFixed(2)));
  const stakeLimit = o.entrySizingDecision?.stakeLimitCents ?? 30;
  // Size and reserve at the worst submittable price, exactly as the desk does.
  const reserve = estimatePaperFill(stakeLimit, limit, 'kalshi');
  if (!reserve) { skipped.push(`${o.symbol} ${o.side} cannot size at ${limit}`); continue; }
  const quantity = reserve.quantity;
  // The IOC crosses and pays the offer, not the limit.
  const costCents = Math.ceil(quantity * ask2 * 100 - 1e-9);
  const feeCents = venueFeeCents('kalshi', ask2 * 100, quantity, 'taker');
  const won = outcome === o.side;
  const payoutCents = won ? Math.floor(quantity * 100 + 1e-9) : 0;
  // ---- exit replay: production policy, carried peak state, owned-side bid --------------------
  const entryAt = poll.at;
  const exactCost = quantity * ask2 * 100 + feeCents;
  const obs = (series.get(`${o.symbol}|${o.closesAt}`) ?? []).filter((x) => x.at > entryAt && x.at < o.closesAt);
  let state: ExitObservationState = {};
  let exitAt: string | undefined, exitBid: number | undefined, exitPolicy: string | undefined;
  for (const x of obs) {
    const ownedAsk = o.side === 'UP' ? x.askUp : x.askDown;
    const oppositeAsk = o.side === 'UP' ? x.askDown : x.askUp;
    if (!Number.isFinite(ownedAsk) || !Number.isFinite(oppositeAsk)) continue;
    const bid = Number((1 - oppositeAsk!).toFixed(4));
    if (!(bid > 0 && bid < 1 && bid <= ownedAsk! + 1e-9)) continue;
    const decision = evaluateExitPolicy({
      observedAt: x.at, side: o.side, quantity,
      exactCostCents: exactCost,
      executableBid: bid,
      exitFeeCents: venueFeeCents('kalshi', bid * 100, quantity, 'taker'),
      ownedSideProbability: o.side === 'UP' ? x.probUp : 1 - x.probUp,
      uncertainty: exitUncertainty(x.confidence),
      ...state,
    });
    if (!decision) continue;
    state = {
      profitLockArmedAt: decision.profitLockArmedAt, peakNetLiquidationCents: decision.peakNetLiquidationCents,
      peakNetProfitPercent: decision.peakNetProfitPercent, peakOwnedSideProbability: decision.peakOwnedSideProbability,
      peakObservedAt: decision.peakObservedAt,
    };
    if (decision.action === 'SELL') { exitAt = x.at; exitBid = bid; exitPolicy = decision.policy; break; }
  }
  // Whole-cent budget view, rounding against us on both legs (AGENTS.md section 1).
  const holdPnl = payoutCents - costCents - feeCents;
  const exitPnl = exitBid === undefined ? holdPnl
    : Math.floor(quantity * 100 * exitBid + 1e-9) - venueFeeCents('kalshi', exitBid * 100, quantity, 'taker') - costCents - feeCents;

  rows.push({
    order: o, closesAt: o.closesAt, label: `${o.symbol} ${o.side} ${o.closesAt.slice(11, 16)}`,
    wouldHaveFilledAsMaker: term(o)!.filledCount! > 0,
    ask2, depth2: poll.bestAskDepth, limit, quantity, costCents, feeCents,
    stakeCents: costCents + feeCents, won,
    pnlCents: holdPnl,
    actualCents: quantity * 100 * (won ? 1 : 0) - quantity * ask2 * 100 - feeCents,
    exitAt, exitBid, exitPolicy, exitPnlCents: exitPnl, exitObs: obs.length,
  });
}

const report = (title: string, set: Row[], useExits = false) => {
  if (!set.length) return console.log(`${title}: no rows`);
  const wins = set.filter((r) => r.won).length;
  const pnl = (r: Row) => useExits ? r.exitPnlCents : r.pnlCents;
  const gross = set.reduce((s, r) => s + pnl(r), 0);
  const exact = set.reduce((s, r) => s + r.actualCents, 0);
  const staked = set.reduce((s, r) => s + r.stakeCents, 0);
  const fees = set.reduce((s, r) => s + r.feeCents, 0);
  const cents = clusterByWindow(set, (r) => r.closesAt, pnl);
  const ret = clusterByWindow(set.filter((r) => r.stakeCents > 0), (r) => r.closesAt, (r) => pnl(r) / r.stakeCents);
  const sold = set.filter((r) => r.exitAt).length;
  console.log(`\n===== ${title}`);
  console.log(`  orders ${set.length} across ${cents.windows} independent settlement windows`);
  console.log(`  won ${wins} / lost ${set.length - wins}  (${(100 * wins / set.length).toFixed(0)}% hit rate)`);
  console.log(`  staked ${staked}c  fees ${fees}c`);
  console.log(`  whole-cent P&L ${gross >= 0 ? '+' : ''}${gross}c` + (useExits ? `   (exits fired on ${sold}/${set.length})` : `    exact-hold P&L ${exact >= 0 ? '+' : ''}${exact.toFixed(2)}c`));
  console.log(`  return on stake ${(100 * gross / staked).toFixed(1)}%`);
  console.log(`  per-window mean ${cents.mean?.toFixed(2)}c  SE ${cents.standardError?.toFixed(2) ?? 'n/a'}` +
    (cents.mean !== null && cents.standardError ? `  t=${(cents.mean / cents.standardError).toFixed(2)}` : ''));
  console.log(`  per-window mean return ${((ret.mean ?? 0) * 100).toFixed(2)}%  SE ${ret.standardError ? (ret.standardError * 100).toFixed(2) + '%' : 'n/a'}` +
    (ret.mean !== null && ret.standardError ? `  t=${(ret.mean / ret.standardError).toFixed(2)}` : ''));
};

const missed = rows.filter((r) => !r.wouldHaveFilledAsMaker);
console.log('################ HELD TO SETTLEMENT (no exits) ################');
report('COHORT A - only the makers that actually missed (the question as asked)', missed);
report('COHORT B - every maker still resting at 2s (the honest cohort)', rows);
report('  of which: the ones that would have filled as makers, taken instead', rows.filter((r) => r.wouldHaveFilledAsMaker));
console.log('\n################ WITH THE PRODUCTION EXIT POLICY REPLAYED ################');
report('COHORT A with exits', missed, true);
report('COHORT B with exits', rows, true);

// ---- what the live rule actually did on the same interval --------------------------------------
const actual = ledger.orders.filter((o) =>
  o.entryDecision?.executionPolicyVersion === V9 && o.executionMode === 'live' &&
  o.createdAt <= REVIEW_UNTIL && ['won', 'lost', 'sold'].includes(o.status));
const aGross = actual.reduce((s, o) => s + (o.pnlCents ?? 0), 0);
const aStake = actual.reduce((s, o) => s + (o.stakeCents ?? 0), 0);
const aCents = clusterByWindow(actual, (o) => o.closesAt, (o) => o.pnlCents ?? 0);
console.log(`\n===== THE LIVE RULE, same interval (what actually happened, with its exits)`);
console.log(`  settled orders ${actual.length} across ${aCents.windows} windows`);
console.log(`  staked ${aStake}c   whole-cent P&L ${aGross >= 0 ? '+' : ''}${aGross}c   return ${(100 * aGross / aStake).toFixed(1)}%`);
console.log(`  per-window mean ${aCents.mean?.toFixed(2)}c  SE ${aCents.standardError?.toFixed(2) ?? 'n/a'}`);

const reason = (s: string) => s.includes('unsettled') ? 'window not yet resolved in forecast-history'
  : s.includes('no quote') ? 'no venue quote at the cutover'
  : s.includes('cannot size') ? 'cannot size at the cutover price' : 'filled before the cutover';
const skipTally: Record<string, number> = {};
for (const s of skipped) skipTally[reason(s)] = (skipTally[reason(s)] ?? 0) + 1;
console.log(`\nskipped ${skipped.length}:`);
for (const [k, v] of Object.entries(skipTally).sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);

// ---- break-even arithmetic: sample-size independent -------------------------------------------
const breakEven = (set: Row[], price: (r: Row) => number) => {
  const need = set.map((r) => {
    const cost = Math.ceil(r.quantity * price(r) * 100 - 1e-9) + venueFeeCents('kalshi', price(r) * 100, r.quantity, 'taker');
    const win = Math.floor(r.quantity * 100 + 1e-9) - cost;
    return cost / (win + cost);
  });
  return need.reduce((a, b) => a + b, 0) / need.length;
};
const makerLimit = (r: Row) => {
  const o = r.order;
  return [...(o.entryExecutionObservations ?? [])].reverse().find((e) => Number.isFinite(e.limitPrice))!.limitPrice!;
};
console.log('\nBREAK-EVEN HIT RATE (what fraction must settle in our favour just to return zero)');
console.log(`  taking the offer at the 2s ask : ${(100 * breakEven(missed, (r) => r.ask2)).toFixed(1)}%`);
console.log(`  making at the maker's own limit: ${(100 * breakEven(missed, makerLimit)).toFixed(1)}%`);
console.log(`  realised on this subsample     : ${(100 * missed.filter((r) => r.won).length / missed.length).toFixed(1)}%`);
// The forecast itself, not the data-quality score: this is the number that must clear break-even.
const probs = missed.map((r) => r.order.side === 'UP' ? r.order.modelProbabilityUp : 1 - r.order.modelProbabilityUp)
  .sort((a, b) => a - b);
console.log(`  model's own forecast (median)  : ${(100 * probs[Math.floor(probs.length / 2)]).toFixed(1)}%  <- must exceed the taker break-even`);
const quals = missed.map((r) => r.order.confidence ?? 0).sort((a, b) => a - b);
console.log(`  (data-quality score, separate) : ${(100 * quals[Math.floor(quals.length / 2)]).toFixed(1)}%`);

console.log('\nPer-order detail, cohort A:');
console.log('contract'.padEnd(20), 'ask@2s  limit   qty   cost  fee  depth | outcome | P&L');
for (const r of missed.sort((a, b) => a.closesAt.localeCompare(b.closesAt)))
  console.log(r.label.padEnd(20),
    String(Math.round(r.ask2 * 100)).padStart(5) + 'c',
    String(Math.round(r.limit * 100)).padStart(5) + 'c',
    String(r.quantity).padStart(6),
    String(r.costCents).padStart(5) + 'c',
    String(r.feeCents).padStart(3) + 'c',
    String(r.depth2 ?? '-').padStart(6),
    '|', (r.won ? 'WON ' : 'lost').padEnd(5),
    '|', (r.pnlCents >= 0 ? '+' : '') + r.pnlCents + 'c');
