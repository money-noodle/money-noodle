// Unfilled live edge entries: count terminal routes, score accepted maker misses at their posted price,
// and compare their selected side with an always-UP control on the same rows.
// Reads durable orders plus public Kalshi settlement results; writes nothing and never places an order.
// Run: node scripts/analyze-unfilled-entries.mjs [hours] [end-iso]
// Deciding correction: means and selected-side-minus-UP differences cluster by settlement window. Biggest
// bias: a maker miss is selected by price moving away from its bid, so its hold return is not a capturable fill.
import { readExecutionLedgerSync } from './lib/read-execution-ledger.mjs';

const HOURS = Number(process.argv[2] ?? 18);
const endMs = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
if (!Number.isFinite(HOURS) || HOURS <= 0 || !Number.isFinite(endMs)) throw new Error('Expected positive hours and an optional valid end-iso.');
const cutoff = endMs - HOURS * 3_600_000;
const iso = (value) => new Date(value).toISOString();

const book = readExecutionLedgerSync();
const orders = book.orders;
const live = orders.filter((row) => row.executionMode === 'live'
  && row.providerId === 'kalshi'
  && row.strategyId === 'edge-binary-buy'
  && !row.id.includes(':exit:')
  && Date.parse(row.calculationAt || row.createdAt) >= cutoff
  && Date.parse(row.calculationAt || row.createdAt) <= endMs);
const unfilled = live.filter((row) => row.status === 'unfilled');
const filled = live.filter((row) => ['won', 'lost', 'sold'].includes(row.status));
const rested = unfilled.filter((row) => row.reason?.startsWith('Managed post-only maker limit rested')
  || row.reason?.startsWith('Reconciliation confirmed the venue order ended with no fill'));

const outcomes = new Map();
for (const row of orders) {
  if (!row.contractId) continue;
  if (row.counterfactualHoldOutcome === 'UP' || row.counterfactualHoldOutcome === 'DOWN') {
    outcomes.set(row.contractId, row.counterfactualHoldOutcome);
  } else if (row.status === 'won') {
    outcomes.set(row.contractId, row.side);
  } else if (row.status === 'lost') {
    outcomes.set(row.contractId, row.side === 'UP' ? 'DOWN' : 'UP');
  }
}

// Resolve only contracts absent from local authoritative outcomes. Public settlement reads are deduplicated,
// sequential, and permanent-failure: an unavailable contract remains excluded rather than being guessed.
const missingContracts = [...new Set(rested.map((row) => row.contractId).filter((id) => id && !outcomes.has(id)))];
for (const contractId of missingContracts) {
  try {
    const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(contractId)}`, {
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    });
    if (response.ok) {
      const body = await response.json();
      const result = body.market?.result?.toLowerCase();
      if (result === 'yes') outcomes.set(contractId, 'UP');
      if (result === 'no') outcomes.set(contractId, 'DOWN');
    }
  } catch { /* unavailable remains unavailable */ }
  await new Promise((resolve) => setTimeout(resolve, 120));
}

function cluster(rows, measure) {
  const windows = new Map();
  for (const row of rows) {
    const values = windows.get(row.closesAt) ?? [];
    values.push(measure(row));
    windows.set(row.closesAt, values);
  }
  const means = [...windows.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  if (!means.length) return { windows: 0, mean: Number.NaN, standardError: Number.NaN, t: Number.NaN, minimum: Number.NaN, maximum: Number.NaN };
  const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
  const variance = means.length > 1
    ? means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (means.length - 1) : 0;
  const standardError = Math.sqrt(variance / means.length);
  return {
    windows: means.length, mean, standardError,
    t: standardError > 0 ? mean / standardError : Number.NaN,
    minimum: Math.min(...means), maximum: Math.max(...means),
  };
}

const resolved = rested.filter((row) => outcomes.has(row.contractId)
  && Number.isFinite(row.initialSubmittedPrice)
  && Number.isFinite(row.requestedQuantity ?? row.quantity));
const quantityOf = (row) => row.requestedQuantity ?? row.quantity;
const hypotheticalStake = (row) => row.initialSubmittedPrice * quantityOf(row) * 100;
const hypotheticalPnl = (row) => outcomes.get(row.contractId) === row.side
  ? quantityOf(row) * 100 - hypotheticalStake(row)
  : -hypotheticalStake(row);
const hypotheticalReturn = (row) => hypotheticalPnl(row) / hypotheticalStake(row);
const selectedMinusUp = (row) => Number(outcomes.get(row.contractId) === row.side) - Number(outcomes.get(row.contractId) === 'UP');

const wins = resolved.filter((row) => outcomes.get(row.contractId) === row.side).length;
const pnl = resolved.reduce((sum, row) => sum + hypotheticalPnl(row), 0);
const stake = resolved.reduce((sum, row) => sum + hypotheticalStake(row), 0);
const returnCluster = cluster(resolved, hypotheticalReturn);
const controlCluster = cluster(resolved, selectedMinusUp);
const upPicks = resolved.filter((row) => row.side === 'UP');
const upWins = upPicks.filter((row) => outcomes.get(row.contractId) === 'UP').length;
const filledWins = filled.filter((row) => row.status === 'won'
  || (row.status === 'sold' && row.counterfactualHoldOutcome === row.side)).length;
const atCap = rested.filter((row) => Number.isFinite(row.initialSubmittedPrice)
  && Number.isFinite(row.approvedMaximumPrice)
  && Math.abs(row.initialSubmittedPrice - row.approvedMaximumPrice) < 1e-9).length;

console.log(`# Unfilled live edge entries, ${iso(cutoff)}..${iso(endMs)}\n`);
console.log(`live entries: ${live.length}; unfilled: ${unfilled.length}; filled/settled/sold: ${filled.length}`);
console.log(`unfilled routes: rested maker ${rested.length}; post-only create rejection ${unfilled.filter((row) => row.reason?.startsWith('Post-only acknowledgement')).length}; taker refusal ${unfilled.filter((row) => row.reason?.startsWith('Taker not submitted')).length}; other ${unfilled.length - rested.length - unfilled.filter((row) => row.reason?.startsWith('Post-only acknowledgement')).length - unfilled.filter((row) => row.reason?.startsWith('Taker not submitted')).length}\n`);
console.log(`resolved rested makers: ${resolved.length}/${rested.length}; public lookups attempted: ${missingContracts.length}`);
console.log(`would-win at posted price: ${wins}/${resolved.length} (${(wins / resolved.length * 100).toFixed(1)}%)`);
console.log(`hold PnL at posted price: ${pnl.toFixed(1)}c on ${stake.toFixed(1)}c = ${(pnl / stake * 100).toFixed(1)}% aggregate ROI`);
console.log(`clustered return: ${(returnCluster.mean * 100).toFixed(1)}% ±${(returnCluster.standardError * 100).toFixed(1)} over ${returnCluster.windows} windows (t=${returnCluster.t.toFixed(2)}, range ${(returnCluster.minimum * 100).toFixed(1)}%..${(returnCluster.maximum * 100).toFixed(1)}%)\n`);
console.log(`selected-side control: UP picks won ${upWins}/${upPicks.length}; clustered selected-side minus always-UP ${(controlCluster.mean * 100).toFixed(1)}pp ±${(controlCluster.standardError * 100).toFixed(1)} over ${controlCluster.windows} windows (t=${controlCluster.t.toFixed(2)})`);
console.log(`filled hold-would-win: ${filledWins}/${filled.length}; rested would-win: ${wins}/${resolved.length}`);
console.log(`rested at approved cap: ${atCap}/${rested.length}`);
