/**
 * Why the contract the desk picks loses to the ones it passes over.
 *
 *   npm run analyze:contract-selection
 *
 * **What it measures.** `analyze:loss-decomposition` prices contract selection at −21.8pp under v19: the
 * contracts the desk orders return that much less than the admitted population in the same windows. This
 * splits that leak into the three things it could be, because they call for different fixes:
 *
 *   ranking   a better candidate was already admitted when the desk chose, and it chose the other one
 *   timing    the better candidate was not admitted yet, and by the time it was the slots were full
 *   capacity  there was no better candidate; the desk took what there was
 *
 * Only the second is a switching problem, and only the third is a position-limit problem. The first is
 * free to fix — it needs no extra capital, no extra churn, and no change to what is admitted.
 *
 * **The correction that decides the answer.** Everything is scored **at the ask, held to settlement**, for
 * chosen and passed-over alike. Realized returns cannot be used: the chosen contract is the only one that
 * was ever filled, so comparing its realized result against a counterfactual would fold fill selection —
 * separately worth −8.4pp — into a number about ranking. A decision is one `(symbol, closesAt, side)`.
 *
 * **Biases, worst first.**
 *   - Fill-optimistic and exit-free on both sides of every comparison, so the *difference* is the readable
 *     quantity and the level is not.
 *   - "Admitted before the desk ordered" uses the first calculation at which the gate admits that
 *     decision, which the desk sees at its own cadence; a candidate admitted seconds earlier was not
 *     necessarily visible in the snapshot the desk chose from.
 *   - Correlation and same-window constraints mean the best-scoring alternative is not always takeable.
 *     `takeable` reports the subset that violates no constraint against what the desk already held.
 *   - Settlement is authoritative; windows without an outcome are dropped.
 *   - Read-only. Places no order and writes nothing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readForecastHistory } from './lib/forecast-history.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const CYCLE_SECONDS = 900;
const WARMUP = 90, CUTOFF = 120;
const feeRate = (price) => 0.07 * price * (1 - price);
/** `cryptoExposureGroup` in lib/portfolio-policy.ts. */
const group = (symbol) => (symbol === 'BTC' || symbol === 'ETH' ? 'majors'
  : ['SOL', 'BNB', 'HYPE'].includes(symbol) ? 'layer1-beta' : 'alt-beta');
const LIVE = { minEdge: 0.05, maxEdge: 0.35, minQuality: 0.5, minSideProbability: 0.55, minPrice: 0.05, maxPrice: 0.97 };
const admits = (o) => o.price >= LIVE.minPrice && o.price <= LIVE.maxPrice && o.probability >= LIVE.minSideProbability
  && o.netEdge >= LIVE.minEdge && o.netEdge < LIVE.maxEdge && o.confidence >= LIVE.minQuality;

// ---------------------------------------------------------------- admitted decisions
const windows = new Map();
for (const row of await readForecastHistory(DATA)) {
  if (row.status !== 'resolved' || !row.outcome) continue;
  const quotes = row.actionableVenuePrices?.filter((q) => q.venue === 'kalshi');
  if (!quotes?.length) continue;
  const asks = {};
  for (const { side, price } of quotes) if (price > 0 && price < 1) asks[side] = price;
  if (asks.UP === undefined || asks.DOWN === undefined) continue;
  const key = `${row.symbol}|${row.closesAt}`;
  const w = windows.get(key) ?? { key, symbol: row.symbol, closesAt: row.closesAt, outcome: row.outcome, rows: [] };
  w.rows.push({ t: CYCLE_SECONDS - (row.secondsRemaining ?? 0), issuedAt: Date.parse(row.issuedAt), p: row.probabilityUp, c: row.confidence ?? 0, asks, policyVersion: row.policyVersion });
  windows.set(key, w);
}
for (const w of windows.values()) w.rows.sort((a, b) => a.t - b.t);

/** First moment the gate admits this side, inside the execution window. */
const admissions = [];
for (const w of windows.values()) {
  for (const side of ['UP', 'DOWN']) {
    for (const row of w.rows) {
      const price = row.asks[side];
      if (!(price > 0) || price >= 1) continue;
      const probability = side === 'UP' ? row.p : 1 - row.p;
      const option = { probability, price, confidence: row.c, netEdge: probability - price - feeRate(price) };
      if (!admits(option)) continue;
      if (row.t < WARMUP) continue;
      if (CYCLE_SECONDS - row.t < CUTOFF) break;
      const cost = price + feeRate(price);
      admissions.push({
        key: `${w.key}|${side}`, symbol: w.symbol, closesAt: w.closesAt, side,
        admittedAt: row.issuedAt, netEdge: option.netEdge, confidence: row.c, cost,
        ret: (w.outcome === side ? 1 : 0) / cost - 1,
        policyVersion: row.policyVersion,
      });
      break;
    }
  }
}
const byClose = new Map();
for (const a of admissions) byClose.set(a.closesAt, [...(byClose.get(a.closesAt) ?? []), a]);

// ---------------------------------------------------------------- what the desk ordered
const ledger = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8'));
const orders = ledger.orders.filter((o) => o.strategyId !== 'long-shot-round-trip' && !o.id.includes(':exit:'));

const stat = (values) => {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const se = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) / values.length) : 0;
  return { n: values.length, mean, se, t: se ? mean / se : 0 };
};
const show = (label, s) => console.log(`${label.padEnd(42)} ${s ? `n=${String(s.n).padStart(4)}  ${(s.mean >= 0 ? '+' : '')}${(100 * s.mean).toFixed(1)}% ±${(196 * s.se).toFixed(1)}  t=${s.t.toFixed(2)}` : 'none'}`);

for (const [eraLabel, eraTest] of [['v17 onward', (v) => /-(v1[6-9]|fresh2pp-v18)$/.test(v ?? '')], ['v19 only', (v) => (v ?? '').endsWith('-v19')]]) {
  const mode = 'live';
  const mine = orders.filter((o) => o.executionMode === mode && eraTest(o.entryDecision?.policyVersion));
  if (!mine.length) continue;
  console.log(`\n================ ${eraLabel}, ${mode} — ${mine.length} orders ================`);

  const chosen = [], sooner = [], later = [], soonerBetter = [], laterBetter = [];
  const blocked = { sameAsset: [], sameGroup: [], windowFull: [], takeable: [] };
  // How long a takeable better candidate had been admitted when the desk chose something else. Under 30s
  // it had not yet earned persistence (3 snapshots spanning 30s) and was not executable — the benign case.
  const takeableAge = [];
  let atCapacity = 0, hadAlternative = 0, windowsSeen = 0;

  for (const order of mine) {
    const pool = byClose.get(order.closesAt);
    if (!pool) continue;
    const orderedAt = Date.parse(order.createdAt);
    const mineKey = `${order.symbol}|${order.closesAt}|${order.side}`;
    const self = pool.find((a) => a.key === mineKey);
    if (!self) continue;
    windowsSeen += 1;
    chosen.push(self.ret);
    const others = pool.filter((a) => a.key !== mineKey);
    if (others.length) hadAlternative += 1;
    // Concurrent live positions at the moment of this order, from the ledger itself.
    const openThen = mine.filter((o) => o !== order && Date.parse(o.createdAt) <= orderedAt
      && Date.parse(o.closesAt) > orderedAt).length;
    if (openThen >= 3) atCapacity += 1;

    // Positions held in this settlement window at order time, for the constraint check below.
    const heldSameWindow = mine.filter((o) => o !== order && o.closesAt === order.closesAt
      && Date.parse(o.createdAt) <= orderedAt);
    for (const other of others) {
      const outranks = other.netEdge * other.confidence > self.netEdge * self.confidence;
      if (other.admittedAt <= orderedAt) {
        sooner.push(other.ret);
        if (outranks) {
          soonerBetter.push(other.ret);
          // Would a constraint have refused it, given what the desk already held in this window?
          const sameAsset = heldSameWindow.some((o) => o.symbol === other.symbol) || other.symbol === order.symbol;
          const sameGroup = [...heldSameWindow, order].some((o) => group(o.symbol) === group(other.symbol));
          const windowFull = heldSameWindow.length + 1 >= 2;
          if (sameAsset) blocked.sameAsset.push(other.ret);
          else if (sameGroup) blocked.sameGroup.push(other.ret);
          else if (windowFull) blocked.windowFull.push(other.ret);
          else { blocked.takeable.push(other.ret); takeableAge.push((orderedAt - other.admittedAt) / 1000); }
        }
      } else {
        later.push(other.ret);
        if (outranks) laterBetter.push(other.ret);
      }
    }
  }

  console.log(`orders matched to an admitted decision: ${windowsSeen}; with at least one alternative: ${hadAlternative}; at 3 open positions: ${atCapacity}\n`);
  show('the contract the desk chose', stat(chosen));
  show('  alternatives already admitted then', stat(sooner));
  show('    ... that also outranked it', stat(soonerBetter));
  console.log('  of those better-ranked and already available, why they were not taken:');
  show('      refused: same asset this window', stat(blocked.sameAsset));
  show('      refused: correlation group limit', stat(blocked.sameGroup));
  show('      refused: same-window limit of 2', stat(blocked.windowFull));
  show('      TAKEABLE — no constraint refused it', stat(blocked.takeable));
  if (takeableAge.length) {
    const sorted = [...takeableAge].sort((a, b) => a - b);
    const under = takeableAge.filter((age) => age < 30).length;
    console.log(`      of those takeable, seconds already admitted: median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)}s, `
      + `min ${sorted[0].toFixed(0)}s, max ${sorted.at(-1).toFixed(0)}s`);
    console.log(`      under 30s (not yet persistent, so not executable): ${under} of ${takeableAge.length}`);
  }
  show('  alternatives admitted later', stat(later));
  show('    ... that also outranked it', stat(laterBetter));
  const c = stat(chosen), s = stat(sooner), l = stat(later);
  if (c && s) console.log(`\n  RANKING gap  (chosen − already-available):  ${((c.mean - s.mean) >= 0 ? '+' : '')}${(100 * (c.mean - s.mean)).toFixed(1)}pp`);
  if (c && l) console.log(`  TIMING gap   (chosen − later-arriving):     ${((c.mean - l.mean) >= 0 ? '+' : '')}${(100 * (c.mean - l.mean)).toFixed(1)}pp`);
}

console.log('\nA negative RANKING gap means a better contract was already on the board and the desk took the');
console.log('worse one: that is fixed by changing the ranking, not by more slots or easier switching.');
console.log('A negative TIMING gap means the better contract arrived after the desk had committed: that is');
console.log('what an easier switch buys. Both being flat would mean the leak is elsewhere.');
