/**
 * Can the historical "contract-selection leak" be attributed to production choosing a lower-ranked
 * contract from the choice set it actually had?
 *
 *   npm run analyze:contract-selection
 *
 * Deciding correction, 2026-08-19:
 * - compare candidates at the exact calculation timestamp of an issued live order, not every contract
 *   that qualified earlier or later in the settlement window;
 * - reconstruct the stamped policy's persistence, classified-regime, re-entry cooldown, one-attempt
 *   retry state, and authoritative active exposures before ranking;
 * - size every candidate with production `estimatePaperFill` at the chosen snapshot's all-in ceiling and
 *   rank with production `selectPortfolio` under the historical 3/2/1 constraints;
 * - compare paired chosen-versus-replay-preferred returns and cluster on settlement window. Repeated
 *   snapshots and assets in one window are not independent trials.
 *
 * Scope fails closed at v19. V17-v19 have known policy rules, one live attempt, and 3/2/1 caps. Later
 * runtime cap overrides were not stamped on decisions, so today's environment cannot be projected back
 * onto them honestly.
 *
 * Most threatening limitation: forecast history does not retain every failed dashboard observation and
 * `portfolioDecisions` is overwritten, not journaled. Persistence and the alternative choice set are
 * therefore issuance-near reconstructions, not authoritative historical execution state. The script
 * reports chosen-order reproduction and may withdraw the old leak claim; it cannot promote a ranking
 * change from a reconstructed alternative.
 *
 * Ask-and-hold economics are used on both sides to isolate selection from fills and exits. Read-only:
 * this script writes no durable data and places no order.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { readForecastHistory } from './lib/forecast-history.mjs';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const jiti = createJiti(import.meta.url);
const { analyzeContractSelection, clusterSnapshotPairs } = await jiti.import('../lib/contract-selection-analysis.ts');

const forecasts = await readForecastHistory(DATA);
const ledger = await readExecutionLedger(DATA);
let transitions = [];
try {
  const regime = JSON.parse(await readFile(path.join(DATA, 'regime-gate.json'), 'utf8'));
  transitions = regime.transitions ?? [];
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const analysis = analyzeContractSelection({
  forecasts,
  orders: ledger.orders ?? [],
  transitions,
  generatedAt: new Date().toISOString(),
});

const pct = (value) => value === null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}%`;
const interval = (result) => result.differenceStandardError === null
  ? '—'
  : `${pct(result.differenceMean)} ±${(196 * result.differenceStandardError).toFixed(1)}pp (95%)`;
const line = (label, result, same) => {
  console.log(`${label.padEnd(12)} snapshots=${String(result.snapshots).padStart(3)}  windows=${String(result.windows).padStart(3)}  `
    + `same=${String(same).padStart(3)}  chosen=${pct(result.chosenMean).padStart(7)}  `
    + `replay=${pct(result.preferredMean).padStart(7)}  paired Δ=${interval(result)}`);
};

console.log(`contract-selection decision-state replay · ${analysis.generatedAt}`);
console.log(`input: ${forecasts.length} forecasts, ${(ledger.orders ?? []).length} orders`);
console.log(`scope: v17-v19 only; exact issued-order terms plus reconstructed issuance-near alternatives`);
console.log(`coverage: ${analysis.replayedSnapshots}/${analysis.orderSnapshots} order snapshots replayed; `
  + `${analysis.verifiedSnapshots} passed the positive control; `
  + `${analysis.chosenAdmittedByReplay}/${analysis.chosenOrders} chosen orders admitted by reconstructed portfolio state`);
console.log('');
line('v17-v19', analysis.overall, analysis.sameChoiceSnapshots);
for (const cohort of analysis.byPolicy) line(cohort.label, cohort.result, cohort.sameChoiceSnapshots);

const differing = analysis.snapshots.filter((snapshot) => snapshot.chosenAdmittedByReplay && !snapshot.sameChoice);
line('different', clusterSnapshotPairs(differing), 0);

console.log('\nreconstruction exclusions (candidate looks, not independent observations):');
for (const [reason, count] of Object.entries(analysis.exclusions).sort((left, right) => right[1] - left[1])) {
  console.log(`  ${reason.padEnd(24)} ${count}`);
}

console.log('\ninterpretation:');
console.log('- The old chosen-versus-every-ever-admitted gap is withdrawn: those alternatives were not a decision-time choice set.');
console.log('- A replay difference is a hypothesis, not a demonstrated ranking defect, because failed observations and historical portfolio decisions were not durably retained.');
console.log('- A ranking change requires prospective committed choice sets, or a replay whose exact chosen state reproduces and whose alternatives carry the same decision-time gates.');
console.log('\nlimitations:');
for (const limitation of analysis.limitations) console.log(`- ${limitation}`);
