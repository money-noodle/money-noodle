/**
 * Returns to the paper bankroll the taker fees it was charged on maker fills.
 *
 * Kalshi charges effectively nothing on a resting fill: across every live fill the desk has taken, the
 * 497 the venue reported as `maker` carry a mean fee of 0.000c and a maximum of 0.02c, while the 5 it
 * reported as `taker` carry 0.682c. Live reads the real figure from `average_fee_paid` and releases the
 * unused reserve. Paper recomputes the conservative taker reserve at simulated-fill time and keeps it, so
 * every paper maker fill since the 2026-08-14 mirror alignment has been charged a fee live did not pay.
 *
 * Cause, blast radius, and the fix are in docs/paper-maker-fee-design.md. **The fee model was corrected
 * on 2026-08-17**: `venueFeeCents` now takes a required liquidity role and a Kalshi maker fill is charged
 * nothing, so no new phantom fee accrues. This script remains for the historical charge and as the way to
 * settle any that a future regression reintroduces — a non-zero reading here means the model broke again.
 *
 *   npx jiti scripts/correct-paper-maker-fee.ts            # report only
 *   npx jiti scripts/correct-paper-maker-fee.ts --write    # apply
 *
 * Stop the collector first: this is a read-modify-write of a file the engine rewrites every cycle.
 *
 * Append-only. No order record is touched — those are evidence of what the desk actually did, and §3 of
 * the agent rules forbids rewriting them. The two bankroll counters move by exactly the appended amount,
 * so the audit entry fully explains the delta and a second run cannot double-correct.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LEDGER_FILE = path.resolve(process.cwd(), 'data', 'paper-orders.json');
const EDGE = 'edge-binary-buy';

interface Correction {
  at: string;
  reason: string;
  orderIds: string[];
  availableCents: number;
  realizedPnlCents: number;
}

interface Order {
  id: string;
  executionMode: string;
  strategyId?: string;
  status: string;
  liquidityRole?: string;
  feeCents?: number;
  actualFeeCents?: number;
}

interface Ledger {
  paperBudget: {
    startingCents: number;
    availableCents: number;
    realizedPnlCents: number;
    makerFeeCorrections?: Correction[];
  };
  orders: Order[];
}

const feeOf = (order: Order): number => order.actualFeeCents ?? order.feeCents ?? 0;

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const ledger = JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as Ledger;
  const budget = ledger.paperBudget;
  const alreadyCorrected = new Set((budget.makerFeeCorrections ?? []).flatMap((entry) => entry.orderIds));

  /**
   * Settled paper entries on the edge policy that the fill simulation recorded as maker fills.
   *
   * - `liquidityRole === 'maker'` is the authoritative statement of how the order filled, and is what
   *   decides the fee schedule. Ordering by commit date or a policy-version string would misclassify the
   *   transition cohort either side of the alignment.
   * - Settled only. An unfilled or rejected order had its whole reservation returned, so no fee was ever
   *   charged; an open one has its fee inside a reservation that has not yet reached `realizedPnlCents`,
   *   and crediting it now would double-correct when it settles. Those are picked up by a later run.
   * - The edge policy only. The long-shot round trip enters with a price-capped taker IOC, so its fees
   *   are correct, and it derives its equity from its own orders rather than this bankroll.
   */
  const overcharged = ledger.orders.filter((order) => order.executionMode === 'paper'
    && !order.id.includes(':exit:')
    && (order.strategyId ?? EDGE) === EDGE
    && order.liquidityRole === 'maker'
    && ['won', 'lost', 'sold'].includes(order.status)
    && feeOf(order) > 0
    && !alreadyCorrected.has(order.id));

  let reclaimCents = 0;
  for (const order of overcharged) {
    const fee = feeOf(order);
    // Durable money is integer cents. Paper fees come from `venueFeeCents`, which returns a whole
    // number, so a fractional value here means the ledger is not what this correction assumes.
    if (!Number.isInteger(fee)) throw new Error(`${order.id} has a non-integer fee of ${fee}c; refusing to correct a ledger this script does not understand.`);
    reclaimCents += fee;
  }
  if (!Number.isSafeInteger(reclaimCents)) throw new Error(`Reclaim total ${reclaimCents} is not a safe integer.`);

  // The bankroll is a plain roll-forward with no epoch reset, so every fee ever charged is still in the
  // balance. Verifying that here rather than assuming it: if the identity ever stops holding, the
  // adjustment below would be applied to a counter that no longer means what this script thinks.
  const identityHolds = budget.availableCents === budget.startingCents + budget.realizedPnlCents;

  console.log(`overcharged settled maker fills   ${overcharged.length}`);
  console.log(`reclaimable entry fees            ${reclaimCents}c`);
  console.log(`already corrected in prior runs   ${alreadyCorrected.size}`);
  console.log();
  console.log(`availableCents                    ${budget.availableCents} -> ${budget.availableCents + reclaimCents}`);
  console.log(`realizedPnlCents                  ${budget.realizedPnlCents} -> ${budget.realizedPnlCents + reclaimCents}`);
  console.log(`startingCents + realizedPnl == available?  ${identityHolds ? 'yes' : 'NO'}`);

  if (!overcharged.length) { console.log('\nNothing to correct.'); return; }
  if (!identityHolds) throw new Error('Paper bankroll no longer satisfies startingCents + realizedPnlCents == availableCents; correct that before applying this.');
  if (!write) { console.log('\nReport only. Re-run with --write to apply.'); return; }

  budget.availableCents += reclaimCents;
  budget.realizedPnlCents += reclaimCents;
  budget.makerFeeCorrections = [...(budget.makerFeeCorrections ?? []), {
    at: new Date().toISOString(),
    reason: 'Returned taker fees charged on paper maker fills. Kalshi charges no maker fee; live reads the venue figure and releases the reserve, paper kept it. See docs/paper-maker-fee-design.md.',
    orderIds: overcharged.map((order) => order.id),
    availableCents: reclaimCents,
    realizedPnlCents: reclaimCents,
  }];

  const temporary = `${LEDGER_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2));
  await rename(temporary, LEDGER_FILE);
  console.log('\nApplied and recorded in paperBudget.makerFeeCorrections.');
  console.log('The fee model was corrected on 2026-08-17, so this should now find nothing on a re-run.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
