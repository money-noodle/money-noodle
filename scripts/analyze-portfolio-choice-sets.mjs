/**
 * Prospective integrity and paired return for exact production portfolio choice sets.
 *
 *   npm run analyze:portfolio-choice-sets
 *
 * Measure and deciding correction are pre-registered in docs/portfolio-choice-set-journal-design.md §5.
 * Every issued record is scored; repeated records/assets are averaged inside settlement window before
 * uncertainty. The differing-choice cohort is diagnostic only. A claim requires 60 resolved independent
 * windows overall and 20 differing-choice windows. Read-only: writes no data and places no order.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const SNAPSHOT = path.join(DATA, 'portfolio-choice-sets.json');
const JOURNAL = path.join(DATA, 'portfolio-choice-sets.journal.jsonl');
const jiti = createJiti(import.meta.url);
const { buildPortfolioChoiceSetReport, replayPortfolioChoiceSetEvents } = await jiti.import('../src/lib/portfolio-choice-set.ts');

const readOptional = async (file) => {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
};
const snapshotRaw = await readOptional(SNAPSHOT);
const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : { startedAt: null, records: [] };
const journalRaw = await readOptional(JOURNAL);
const events = journalRaw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const records = replayPortfolioChoiceSetEvents(snapshot.records ?? [], events);
const report = buildPortfolioChoiceSetReport(records);
const ledger = await readExecutionLedger(DATA).catch((error) => {
  if (error?.code === 'ENOENT') return { orders: [] };
  throw error;
});
const startedMs = Date.parse(snapshot.startedAt ?? '');
const eligibleLedgerOrders = Number.isFinite(startedMs) ? (ledger.orders ?? []).filter((order) =>
  order.executionMode === 'live' && (order.strategyId ?? 'edge-binary-buy') === 'edge-binary-buy'
  && !order.id.includes(':exit:') && Date.parse(order.createdAt) + 1e-9 >= startedMs) : [];
const recordedOrderIds = new Set(records.map((record) => record.issuedOrderId));
const missingOrderRecords = eligibleLedgerOrders.filter((order) => !recordedOrderIds.has(order.id));

const pct = (value) => value === null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}%`;
const interval = report.differenceStandardError === null
  ? '—'
  : `${pct(report.differenceMean)} ±${(1.96 * report.differenceStandardError * 100).toFixed(1)}pp (95%)`;

console.log(`portfolio-choice-set-v1 · prospective start ${snapshot.startedAt ?? 'not initialized'}`);
console.log(`records ${report.records}; integrity failures ${report.integrityFailures}; unresolved ${report.unresolvedRecords}`);
console.log(`post-boundary live edge orders ${eligibleLedgerOrders.length}; missing choice-set records ${missingOrderRecords.length}`);
console.log(`scoreable ${report.scoreableRecords}; windows ${report.independentWindows}; same choice ${report.sameChoiceRecords}; differing ${report.differingChoiceRecords}`);
if (report.integrityFailures || missingOrderRecords.length) console.log('effect estimate BLOCKED by integrity coverage');
else console.log(`issued ${pct(report.issuedMean)}; production-preferred ${pct(report.preferredMean)}; paired difference ${interval}`);
console.log(`30-window diagnostic: ${report.diagnosticReviewReady ? 'open' : 'locked'}`);
console.log(`60-window / 20-differing review: ${report.differingChoiceReviewReady ? 'open' : 'locked'}`);
if (!report.records) console.log('No record exists yet. The built stateful runtime must initialize collection; historical orders are not backfilled.');
