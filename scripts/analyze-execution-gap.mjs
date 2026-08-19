/**
 * Does the desk buy what its own gate admits? The admitted -> ordered -> filled funnel, over time.
 *
 *   npm run analyze:execution-gap            # last 24h, hourly
 *   npm run analyze:execution-gap -- 6       # last 6h
 *
 * **What it measures.** The gate admits a median of three simultaneous decisions and the desk held no
 * live position 75% of the time, so the interesting quantity is not whether the gate is right — it is how
 * much of what the gate admits ever becomes a position. This counts, per hour:
 *
 *   admitted   distinct (symbol, window, side) decisions the live rule admits inside the execution window
 *   ordered    of those, how many the desk actually submitted
 *   filled     of those orders, how many the venue filled
 *
 * **The correction that decides the answer.** A decision is one `(symbol, closesAt, side)`, not one
 * calculation row. The forecast history records a row every few seconds, so counting rows would measure
 * how long a contract stayed qualified rather than how many opportunities there were, and would make the
 * conversion rate arbitrarily small.
 *
 * **Biases, worst first.**
 *   - "Admitted" is reconstructed from recorded quotes, so it includes decisions the desk could not have
 *     taken for reasons this script cannot see — an unfunded window, a stale snapshot, a venue outage.
 *     The conversion rate is therefore a floor, and its *trend* is the readable part.
 *   - Persistence is reconstructed from forecast-history samples, which are slower than the dashboard
 *     observations production persists against. The persistent count is therefore a floor. Requirements
 *     are selected by the row's stamped buy-policy version; an unknown version is excluded and reported.
 *   - Settlement is not needed here: this is about conversion, not profit.
 *   - Read-only. Places no order and writes nothing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readForecastHistory } from './lib/forecast-history.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const HOURS = Number(process.argv[2] ?? 24);
const CYCLE_SECONDS = 900;
const WARMUP = 90;
const feeRate = (price) => 0.07 * price * (1 - price);

/**
 * Production requirements by immutable policy identity, never inferred from a deployment timestamp.
 * A new policy fails closed in this monitor until its requirements are stated here.
 */
const POLICY_REQUIREMENTS = new Map([
  ['buy-binary-edge-net5to35-quality50-owned55-price5to97-v17', { floor: 0.05, ceiling: 0.35, lateCutoff: 120, snapshots: 3, spanMs: 30_000 }],
  ['buy-binary-edge-net5to35-quality50-owned55-price5to97-fresh2pp-v18', { floor: 0.05, ceiling: 0.35, lateCutoff: 120, snapshots: 3, spanMs: 30_000 }],
  ['buy-binary-edge-net5to35-quality50-owned55-price5to97-v19', { floor: 0.05, ceiling: 0.35, lateCutoff: 120, snapshots: 3, spanMs: 30_000 }],
  ['buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-v20', { floor: -0.05, ceiling: 1, lateCutoff: 30, snapshots: 3, spanMs: 30_000 }],
  ['buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21', { floor: -0.05, ceiling: 1, lateCutoff: 30, snapshots: 2, spanMs: 15_000 }],
]);

const since = Date.now() - HOURS * 3_600_000;
const admitted = new Map();
const unknownPolicies = new Set();
for (const row of await readForecastHistory(DATA)) {
  const quotes = row.actionableVenuePrices?.filter((q) => q.venue === 'kalshi');
  if (!quotes?.length) continue;
  const issued = Date.parse(row.issuedAt);
  if (!Number.isFinite(issued) || issued < since) continue;
  const requirements = POLICY_REQUIREMENTS.get(row.policyVersion);
  if (!requirements) { unknownPolicies.add(row.policyVersion ?? 'missing'); continue; }
  const elapsed = CYCLE_SECONDS - (row.secondsRemaining ?? 0);
  if (elapsed < WARMUP) continue;
  if ((row.secondsRemaining ?? 0) < requirements.lateCutoff) continue;
  for (const { side, price } of quotes) {
    if (!(price > 0) || price >= 1) continue;
    const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
    const netEdge = probability - price - feeRate(price);
    if (price < 0.05 || price > 0.97) continue;
    if (probability < 0.55 || (row.confidence ?? 0) < 0.5) continue;
    if (netEdge < requirements.floor || netEdge >= requirements.ceiling) continue;
    const key = `${row.policyVersion}|${row.symbol}|${row.closesAt}|${side}`;
    const prior = admitted.get(key);
    // Every qualifying instant, not just the first: a decision that qualified once and vanished was
    // never executable at all. Requirements are carried on the decision so policy eras cannot blend.
    const entry = prior ?? {
      issued, policyVersion: row.policyVersion, symbol: row.symbol, closesAt: row.closesAt, side, netEdge,
      snapshots: requirements.snapshots, spanMs: requirements.spanMs, instants: [],
    };
    entry.instants.push(issued);
    if (issued < entry.issued) { entry.issued = issued; entry.netEdge = netEdge; }
    admitted.set(key, entry);
  }
}

const ledger = JSON.parse(await readFile(path.join(DATA, 'paper-orders.json'), 'utf8'));
const orders = (ledger.orders ?? []).filter((o) => o.strategyId !== 'long-shot-round-trip' && !o.id.includes(':exit:'));
const orderKeys = new Map();
for (const o of orders) {
  if (Date.parse(o.createdAt) < since) continue;
  const policyVersion = o.entryDecision?.policyVersion;
  if (!POLICY_REQUIREMENTS.has(policyVersion)) continue;
  const key = `${o.executionMode}|${policyVersion}|${o.symbol}|${o.closesAt}|${o.side}`;
  const prior = orderKeys.get(key);
  if (!prior || (o.filledCount ?? 0) > (prior.filledCount ?? 0)) orderKeys.set(key, o);
}

/**
 * Whether this decision could ever have been executed under the persistence requirements stamped by its
 * policy version. Without this the funnel counts transient spikes as missed buys. Forecast history samples
 * more slowly than the dashboard observations production uses, so this remains a strict lower bound.
 */
const persisted = (decision) => {
  const t = [...decision.instants].sort((a, b) => a - b);
  return t.length >= decision.snapshots && t.at(-1) - t[0] >= decision.spanMs;
};

const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);
const buckets = new Map();
for (const [key, decision] of admitted) {
  const h = hourOf(decision.issued);
  const b = buckets.get(h) ?? { admitted: 0, persistent: 0, ordered: 0, filled: 0 };
  b.admitted += 1;
  if (persisted(decision)) b.persistent += 1;
  const order = orderKeys.get(`live|${decision.policyVersion}|${decision.symbol}|${decision.closesAt}|${decision.side}`);
  if (order) { b.ordered += 1; if ((order.filledCount ?? 0) > 0) b.filled += 1; }
  buckets.set(h, b);
  void key;
}

console.log(`admitted -> ordered -> filled, live track, last ${HOURS}h`);
console.log('"persistent" uses each row’s stamped policy requirements (v17-v20: 3 over 30s; v21: 2 over 15s).');
console.log('The gap between admitted and persistent is transient signals that were never buyable, not misses.');
if (unknownPolicies.size) console.log(`excluded unknown policy versions: ${[...unknownPolicies].sort().join(', ')}`);
console.log(`${'hour (UTC)'.padEnd(15)} ${'admitted'.padStart(9)} ${'persist'.padStart(8)} ${'ordered'.padStart(8)} ${'filled'.padStart(7)} ${'ord/persist'.padStart(12)}`);
let totals = { admitted: 0, persistent: 0, ordered: 0, filled: 0 };
for (const [h, b] of [...buckets].sort()) {
  totals = { admitted: totals.admitted + b.admitted, persistent: totals.persistent + b.persistent,
    ordered: totals.ordered + b.ordered, filled: totals.filled + b.filled };
  console.log(`${h.padEnd(15)} ${String(b.admitted).padStart(9)} ${String(b.persistent).padStart(8)} ${String(b.ordered).padStart(8)} ${String(b.filled).padStart(7)} `
    + `${(b.persistent ? `${(100 * b.ordered / b.persistent).toFixed(0)}%` : '-').padStart(12)}`);
}
console.log(`${'TOTAL'.padEnd(15)} ${String(totals.admitted).padStart(9)} ${String(totals.persistent).padStart(8)} ${String(totals.ordered).padStart(8)} ${String(totals.filled).padStart(7)} `
  + `${(totals.persistent ? `${(100 * totals.ordered / totals.persistent).toFixed(0)}%` : '-').padStart(12)}`);
console.log(`\nof ${totals.admitted} admitted, ${totals.persistent} could have been executed; the desk ordered ${totals.ordered} and filled ${totals.filled}.`);

// The decisions the desk never ordered, which is the population Rai is asking about.
const missed = [...admitted.values()].filter((d) => persisted(d)
  && !orderKeys.has(`live|${d.policyVersion}|${d.symbol}|${d.closesAt}|${d.side}`));
console.log(`\nexecutable but never ordered: ${missed.length}`);
const byWindow = new Map();
for (const d of missed) byWindow.set(d.closesAt, (byWindow.get(d.closesAt) ?? 0) + 1);
const counts = [...byWindow.values()].sort((a, b) => b - a);
console.log(`spread over ${byWindow.size} settlement windows; worst window missed ${counts[0] ?? 0}`);
const recent = missed.sort((a, b) => b.issued - a.issued).slice(0, 12);
console.log('\nmost recent executable misses (edge at first admission):');
for (const d of recent) {
  console.log(`  ${new Date(d.issued).toISOString().slice(11, 19)}  ${d.symbol.padEnd(5)} ${d.side.padEnd(4)} `
    + `edge ${(100 * d.netEdge).toFixed(1).padStart(5)}pp  closes ${d.closesAt.slice(11, 16)}`);
}
