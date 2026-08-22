/**
 * Brings the paper bankroll counters into agreement with the order records they are meant to summarise.
 *
 * `paperBudget.realizedPnlCents` is a running accumulator: `settleDueOrders` and
 * `executePaperStandaloneExit` each add `payoutCents - stakeCents` as positions resolve. Every order
 * stores the same expression as `pnlCents` at the same moment, so the accumulator and the sum over
 * records must agree. They do not — the accumulator is **16c less negative** than the records.
 *
 * **The origin is unknown and this script does not claim otherwise.** What has been ruled out:
 *
 *   - Not the exact-versus-whole-cent split. Both sides are compared in whole-cent `pnlCents`, the units
 *     the accumulator actually moves in.
 *   - Not a missing or extra record. No order carries a P&L outside a bankroll-mutating state, no settled
 *     order is missing one, and no edge-policy sale bypassed the standalone exit path.
 *   - Not the strategy leak or the maker-fee correction. Both are applied explicitly and net out.
 *   - Not a post-settlement rewrite. The paths that rewrite `pnlCents` after the fact (`executeSwitch`,
 *     `executeLiveStandaloneExit`) never ran on a paper order: zero paper orders carry `switchedToOrderId`.
 *   - Not the 2026-08-14 duplicate-order-id incident, which is otherwise the only period the paper ledger
 *     is known to have been inconsistent. That would have stranded reservations, and stranded fees total
 *     77c while `availableCents` reconciles to the cent.
 *
 * The records are the evidence — each carries a venue-resolved payout, a stake and a status — so they are
 * treated as authoritative and the accumulator is moved to match, not the other way round. Both counters
 * move by the same amount so `startingCents + realizedPnlCents - openStake == availableCents` still holds.
 *
 *   npx jiti scripts/correct-paper-bankroll-drift.ts            # report only
 *   npx jiti scripts/correct-paper-bankroll-drift.ts --write    # apply
 *
 * Stop the collector first: this is a read-modify-write of a file the engine rewrites every cycle.
 *
 * Append-only. No order record is touched. The adjustment is appended with its amount and its reason, so
 * the delta is fully explained as an adjustment even though its cause is not.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LEDGER_FILE = path.resolve(process.cwd(), 'data', 'paper-orders.json');
const EDGE = 'edge-binary-buy';

interface Correction { at: string; reason: string; orderIds: string[]; availableCents: number; realizedPnlCents: number }

interface Order {
  id: string; executionMode: string; strategyId?: string; status: string;
  stakeCents: number; pnlCents?: number; standaloneExitPolicy?: string;
}

interface Ledger {
  version?: number;
  paperBudget: {
    startingCents: number; availableCents: number; realizedPnlCents: number;
    makerFeeCorrections?: Correction[];
    strategyLeakCorrections?: Correction[];
    reconciliationCorrections?: Correction[];
  };
  orders: Order[];
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const ledger = JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as Ledger;
  if (ledger.version === 9) throw new Error('This historical correction refuses execution-ledger v9. Restore a verified monolith through compact:execution-ledger -- --write --restore-monolith first.');
  const budget = ledger.paperBudget;
  const strategyOf = (order: Order) => order.strategyId ?? EDGE;
  const paper = ledger.orders.filter((order) => order.executionMode === 'paper' && !order.id.includes(':exit:'));

  /**
   * Exactly the orders that moved `realizedPnlCents`: the edge policy's own settlements, plus any sale
   * made through the standalone exit path, which is not strategy-scoped and is how the long-shot leak
   * reached this counter in the first place.
   */
  const contributing = paper.filter((order) => (strategyOf(order) === EDGE && ['won', 'lost', 'invalid', 'sold'].includes(order.status))
    || (strategyOf(order) !== EDGE && order.status === 'sold' && Boolean(order.standaloneExitPolicy)));

  const fromRecords = contributing.reduce((sum, order) => sum + (order.pnlCents ?? 0), 0);
  /**
   * `reconciliationCorrections` is deliberately excluded. The other two adjust what the *records* imply —
   * the maker fee is still baked into them, and the leak's organic credit is still summed above — so they
   * belong in the expectation. This one adjusts the *counter* to match that expectation, so folding it
   * back in would lower the target by exactly what was just applied and the drift would never close.
   */
  const applied = [budget.makerFeeCorrections, budget.strategyLeakCorrections]
    .flatMap((entries) => entries ?? []).reduce((sum, entry) => sum + entry.realizedPnlCents, 0);
  const expected = fromRecords + applied;
  const driftCents = budget.realizedPnlCents - expected;

  // The edge paper bankroll never funds long-shot positions. Counting their independently funded open
  // stake here manufactures a residual whenever that strategy has exposure, even though both counters
  // are correct. Historical leaked long-shot sales remain handled explicitly in `contributing` above.
  const openStake = paper.filter((order) => strategyOf(order) === EDGE
    && ['open', 'pending_reservation', 'uncertain'].includes(order.status))
    .reduce((sum, order) => sum + (order.stakeCents ?? 0), 0);
  const availableResidual = budget.availableCents - (budget.startingCents + budget.realizedPnlCents - openStake);

  console.log(`contributing order records        ${contributing.length}`);
  console.log(`P&L summed from records           ${fromRecords}c`);
  console.log(`adjustments already applied       ${applied}c`);
  console.log(`expected realizedPnlCents         ${expected}c`);
  console.log(`actual   realizedPnlCents         ${budget.realizedPnlCents}c`);
  console.log(`DRIFT to remove                   ${driftCents}c`);
  console.log();
  console.log(`availableCents residual           ${availableResidual}c ${Math.abs(availableResidual) < 0.5 ? '(counters agree with each other)' : '(counters disagree — investigate before applying)'}`);
  console.log(`  ${budget.availableCents} -> ${budget.availableCents - driftCents}`);
  console.log(`  ${budget.realizedPnlCents} -> ${budget.realizedPnlCents - driftCents}`);

  if (driftCents === 0) { console.log('\nNothing to correct.'); return; }
  if (!Number.isInteger(driftCents)) throw new Error(`Drift ${driftCents} is not a whole number of cents; the two sides are being compared in different units.`);
  // Both counters move together, so a pre-existing disagreement between them would survive this and be
  // silently carried forward. Refuse rather than bake it in.
  if (Math.abs(availableResidual) >= 0.5) throw new Error(`availableCents is already out by ${availableResidual}c; reconcile that before adjusting realizedPnlCents.`);
  if (!write) { console.log('\nReport only. Re-run with --write to apply.'); return; }

  budget.realizedPnlCents -= driftCents;
  budget.availableCents -= driftCents;
  budget.reconciliationCorrections = [...(budget.reconciliationCorrections ?? []), {
    at: new Date().toISOString(),
    reason: `Removed a ${driftCents}c unexplained drift between the paper bankroll accumulator and the sum of the order records it summarises. Origin unknown; see the header of scripts/correct-paper-bankroll-drift.ts for what was ruled out. The records are treated as authoritative because each carries a venue-resolved payout, stake and status.`,
    orderIds: [],
    availableCents: -driftCents,
    realizedPnlCents: -driftCents,
  }];

  const temporary = `${LEDGER_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2));
  await rename(temporary, LEDGER_FILE);
  console.log('\nApplied and recorded in paperBudget.reconciliationCorrections.');
  console.log('This adjusts a figure; it does not explain it. A recurrence means something is still wrong.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
