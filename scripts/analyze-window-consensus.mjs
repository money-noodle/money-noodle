// Window-consensus direction gate: exploratory screen (non-promotable).
// Reads durable data only. Run: npm run analyze:window-consensus [days]
// Rerun every ~500 resolved windows per docs/edge-window-consensus-evaluation-design.md §6.
import fs from 'node:fs';
import { readExecutionLedgerSync } from './lib/read-execution-ledger.mjs';
const fk = new Map();
function addRows(rows) {
  for (const r of rows) {
    if (!r || !r.symbol || !r.closesAt || !r.issuedAt) continue;
    const k = r.symbol + '|' + r.closesAt;
    if (!fk.has(k)) fk.set(k, []);
    fk.get(k).push(r);
  }
}
// all shards + journal + megafile as fallback
for (const f of fs.readdirSync('data/forecast-history-shards').filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  try { addRows(JSON.parse(fs.readFileSync('data/forecast-history-shards/' + f, 'utf8'))); } catch {}
}
for (const l of fs.readFileSync('data/forecast-history.journal.jsonl', 'utf8').trim().split('\n')) { try { addRows([JSON.parse(l)]); } catch {} }
addRows(JSON.parse(fs.readFileSync('data/forecast-history.json', 'utf8')));
for (const v of fk.values()) v.sort((a, b) => a.issuedAt < b.issuedAt ? -1 : 1);
function forecastAsk(rows, side, tMs) {
  let best = null;
  for (const r of rows) {
    const t = Date.parse(r.issuedAt); if (t > tMs) break;
    const hit = (r.actionableVenuePrices || []).find(a => a.side === side);
    if (hit) best = hit.price;
  }
  return best;
}
const book = readExecutionLedgerSync();
const orders = book.orders.filter(x => x.executionMode === 'live' && !x.id.includes(':exit:'));
const isWin = x => x.status === 'won' || (x.status === 'sold' && x.counterfactualHoldOutcome === x.side);
const holdView = x => x.counterfactualHoldPnlCents ?? (x.actualPnlCents ?? x.pnlCents ?? 0);
const W = [30, 60, 120, 240, 360, 480, 600];
const rows = [];
for (const x of orders) {
  const series = fk.get(x.symbol + '|' + x.closesAt) || [];
  if (series.length < 2) continue;
  const buyMs = Date.parse(x.createdAt || x.calculatedAt);
  const nowAsk = forecastAsk(series, x.side, buyMs);
  if (nowAsk == null) continue;
  const moves = {};
  let ok = true;
  for (const w of W) {
    const pa = forecastAsk(series, x.side, buyMs - w * 1000);
    if (pa == null) { ok = false; break; }
    moves[w] = (nowAsk - pa) * 100;
  }
  if (!ok) continue;
  const d = x.entryDirectionObservation?.preSubmit;
  moves[2] = d?.movementCents ?? null;
  rows.push({ sym: x.symbol, side: x.side, status: x.status, closesAt: x.closesAt, createdAt: x.createdAt,
    win: isWin(x), pnl: holdView(x), moves });
}
console.log('orders with full 30s..600s windows:', rows.length,
  ' winners:', rows.filter(r => r.win).length, ' base win:', (rows.filter(r => r.win).length / rows.length * 100).toFixed(1) + '%');
console.log('with 2s:', rows.filter(r => r.moves[2] != null).length);
console.log('\ncoverage by day:');
const byDay = {};
for (const r of rows) { const d = (r.closesAt || '').slice(0, 10); byDay[d] = byDay[d] || { n: 0, w: 0, two: 0 };
  byDay[d].n++; if (r.win) byDay[d].w++; if (r.moves[2] != null) byDay[d].two++; }
for (const d of Object.keys(byDay).sort()) console.log(`  ${d} n=${byDay[d].n} win=${byDay[d].w}(${(byDay[d].w / byDay[d].n * 100).toFixed(0)}%) 2s=${byDay[d].two}`);
console.log('\n=== per-window: win rate by direction (all history) ===');
for (const w of [2, 30, 60, 120, 240, 360, 480, 600]) {
  const g = rows.filter(r => r.moves[w] != null); if (!g.length) continue;
  const up = g.filter(r => r.moves[w] > 0.5), dn = g.filter(r => r.moves[w] < -0.5), fl = g.filter(r => Math.abs(r.moves[w]) <= 0.5);
  const pct = a => a.length ? (a.filter(r => r.win).length / a.length * 100).toFixed(0) + '%' : '-';
  console.log(`  ${String(w).padStart(3)}s up n=${String(up.length).padStart(3)} ${pct(up)}  flat n=${String(fl.length).padStart(3)} ${pct(fl)}  dn n=${String(dn.length).padStart(3)} ${pct(dn)}`);
}

console.log('\n=== combination grid (ALL-of-set positive, all history) ===');
const combos = [
  ['30,60,120', [30, 60, 120]],
  ['60,120,240', [60, 120, 240]],
  ['120,240,360', [120, 240, 360]],
  ['240,360,480', [240, 360, 480]],
  ['360,480,600', [360, 480, 600]],
  ['30..240 all', [30, 60, 120, 240]],
  ['60..360 all', [60, 120, 240, 360]],
  ['120..480 all', [120, 240, 360, 480]],
  ['240..600 all', [240, 360, 480, 600]],
  ['30..600 all', [30, 60, 120, 240, 360, 480, 600]],
];
for (const [name, set] of combos) {
  const g = rows.filter(r => set.every(w => r.moves[w] > 0.5));
  if (!g.length) continue;
  const w = g.filter(r => r.win), net = g.reduce((s, r) => s + r.pnl, 0);
  console.log(`  ${name.padEnd(14)} n=${String(g.length).padStart(3)} win ${w.length} (${(w.length / g.length * 100).toFixed(0)}%)  net ${net >= 0 ? '+' : ''}${net.toFixed(0)}c`);
}
console.log('\n=== negative consensus (ALL-of-set negative) ===');
for (const [name, set] of [['30,60,120', [30, 60, 120]], ['120,240,360', [120, 240, 360]], ['240,360,480', [240, 360, 480]], ['360,480,600', [360, 480, 600]]]) {
  const g = rows.filter(r => set.every(w => r.moves[w] < -0.5));
  if (!g.length) continue;
  const w = g.filter(r => r.win), net = g.reduce((s, r) => s + r.pnl, 0);
  console.log(`  ${name.padEnd(14)} n=${String(g.length).padStart(3)} win ${w.length} (${(w.length / g.length * 100).toFixed(0)}%)  net ${net >= 0 ? '+' : ''}${net.toFixed(0)}c`);
}
console.log('\n=== >=k of {30,60,120,240} positive ===');
for (const k of [1, 2, 3, 4]) {
  const g = rows.filter(r => [30, 60, 120, 240].filter(w => r.moves[w] > 0.5).length >= k);
  if (!g.length) continue;
  console.log(`  >=${k}: n=${g.length} win ${g.filter(r => r.win).length} (${(g.filter(r => r.win).length / g.length * 100).toFixed(0)}%)  net ${g.reduce((s, r) => s + r.pnl, 0).toFixed(0)}c`);
}
console.log('\n=== with-2s subset: all-of {2,30,60,120} positive ===');
const two = rows.filter(r => r.moves[2] != null);
console.log('  base of with-2s subset:', two.length, 'orders, win', two.filter(r => r.win).length, '(' + (two.filter(r => r.win).length / two.length * 100).toFixed(0) + '%)');
const a4 = two.filter(r => [2, 30, 60, 120].every(w => r.moves[w] > 0.5));
console.log('  all 2,30,60,120 pos: n=' + a4.length, 'win', a4.filter(r => r.win).length, 'net', a4.reduce((s, r) => s + r.pnl, 0).toFixed(0) + 'c');
const b4 = two.filter(r => [2, 30, 60, 120].every(w => r.moves[w] < -0.5));
console.log('  all 2,30,60,120 neg: n=' + b4.length, 'win', b4.filter(r => r.win).length, 'net', b4.reduce((s, r) => s + r.pnl, 0).toFixed(0) + 'c');

console.log('\n=== per-window NET pnl by direction (all history) ===');
for (const w of [30, 60, 120, 240, 360, 480, 600]) {
  const g = rows.filter(r => r.moves[w] != null); if (!g.length) continue;
  const up = g.filter(r => r.moves[w] > 0.5), dn = g.filter(r => r.moves[w] < -0.5);
  const net = a => a.length ? a.reduce((s, r) => s + r.pnl, 0).toFixed(0) + 'c' : '-';
  console.log(`  ${String(w).padStart(3)}s  up(n=${String(up.length).padStart(3)}) net ${net(up).padStart(8)}  dn(n=${String(dn.length).padStart(3)}) net ${net(dn).padStart(8)}`);
}
// cost of the "buy only 30..600 all positive" gate on full book
console.log('\n=== gate cost: buy only if 30..600 all positive ===');
const gAll = rows.filter(r => [30,60,120,240,360,480,600].every(w => r.moves[w] > 0.5));
const skipped = rows.filter(r => !gAll.includes(r));
const kNet = gAll.reduce((s, r) => s + r.pnl, 0), sNet = skipped.reduce((s, r) => s + r.pnl, 0);
console.log(`  kept n=${gAll.length} net ${kNet.toFixed(0)}c | skipped n=${skipped.length} net ${sNet.toFixed(0)}c | all-book net ${(kNet + sNet).toFixed(0)}c`);
console.log('  freq: trades/day ≈ ' + (gAll.length / 12).toFixed(1) + ' (vs ' + (rows.length / 12).toFixed(1) + ' all)');
