/**
 * Removes another strategy's payouts from the edge policy's paper bankroll.
 *
 * On 2026-08-15 `observeAndExecuteStandaloneExits` was not scoped by strategy, so the edge policy's
 * `strict-value-v1` exit closed long-shot paper positions and `executePaperStandaloneExit` credited the
 * proceeds into `ledger.paperBudget` — the counter behind the published paper track record. The long-shot
 * orders never debited that bankroll, because that strategy derives its paper equity from its own orders,
 * so the credit is pure inflation.
 *
 * The amount is derived from the ledger rather than typed in, and every corrected order is recorded so a
 * second run cannot double-correct.
 *
 *   npx tsx scripts/correct-paper-bankroll-leak.ts            # report only
 *   npx tsx scripts/correct-paper-bankroll-leak.ts --write    # apply
 *
 * Stop the collector first: this is a read-modify-write of a file the engine writes every cycle.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LEDGER_FILE = path.resolve(process.cwd(), 'data', 'paper-orders.json');
const EDGE = 'edge-binary-buy';

interface Correction {
  at: string; reason: string; orderIds: string[];
  availableCents: number; realizedPnlCents: number;
}

interface Order {
  id: string; executionMode: string; strategyId?: string; status: string;
  stakeCents: number; pnlCents?: number; standaloneExitPolicy?: string;
}

interface Ledger {
  version?: number;
  paperBudget: { availableCents: number; realizedPnlCents: number; strategyLeakCorrections?: Correction[] };
  orders: Order[];
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const ledger = JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as Ledger;
  if (ledger.version === 9) throw new Error('This historical correction refuses execution-ledger v9. Restore a verified monolith through compact:execution-ledger -- --write --restore-monolith first.');
  const alreadyCorrected = new Set((ledger.paperBudget.strategyLeakCorrections ?? []).flatMap((entry) => entry.orderIds));

  // A paper position belonging to another strategy, closed by the edge policy's own exit machinery. Those
  // are exactly the orders whose proceeds reached this bankroll without a matching debit.
  const leaked = ledger.orders.filter((order) => order.executionMode === 'paper'
    && (order.strategyId ?? EDGE) !== EDGE
    && order.status === 'sold'
    && Boolean(order.standaloneExitPolicy)
    && !alreadyCorrected.has(order.id));

  let availableCents = 0;
  let realizedPnlCents = 0;
  for (const order of leaked) {
    // Exactly what `executePaperStandaloneExit` added: whole-cent payout, and payout minus stake.
    const pnl = order.pnlCents ?? 0;
    availableCents += pnl + order.stakeCents;
    realizedPnlCents += pnl;
    console.log(`  ${order.id} · ${order.standaloneExitPolicy} · credited ${pnl + order.stakeCents}¢, P&L ${pnl}¢`);
  }

  console.log(`\nleaked orders            ${leaked.length}`);
  console.log(`availableCents           ${ledger.paperBudget.availableCents} -> ${ledger.paperBudget.availableCents - availableCents}`);
  console.log(`realizedPnlCents         ${ledger.paperBudget.realizedPnlCents} -> ${ledger.paperBudget.realizedPnlCents - realizedPnlCents}`);

  if (!leaked.length) { console.log('\nNothing to correct.'); return; }
  if (!write) { console.log('\nReport only. Re-run with --write to apply.'); return; }

  ledger.paperBudget.availableCents -= availableCents;
  ledger.paperBudget.realizedPnlCents -= realizedPnlCents;
  ledger.paperBudget.strategyLeakCorrections = [...(ledger.paperBudget.strategyLeakCorrections ?? []), {
    at: new Date().toISOString(),
    reason: 'Removed long-shot paper payouts credited into the edge bankroll by unscoped strict-value exits.',
    orderIds: leaked.map((order) => order.id),
    availableCents: -availableCents,
    realizedPnlCents: -realizedPnlCents,
  }];

  const temporary = `${LEDGER_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2));
  await rename(temporary, LEDGER_FILE);
  console.log('\nApplied and recorded in paperBudget.strategyLeakCorrections.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
