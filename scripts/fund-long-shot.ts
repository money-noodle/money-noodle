/**
 * Funds the long-shot round-trip policy inside the Kalshi `crypto-15m` allocation.
 *
 * A budget change is a real-money control, so this refuses unless the same preconditions the spec requires
 * of every other budget mutation hold: automation paused, no reserved budget, and no open or uncertain live
 * position. It writes through `updateProviderBudget` rather than editing the file, so the allocation is
 * validated and the revision is bumped.
 *
 *   npx tsx --env-file=.env.local scripts/fund-long-shot.ts            # report only
 *   npx tsx --env-file=.env.local scripts/fund-long-shot.ts --write    # apply
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getProviderBudgets, providerBudget, updateProviderBudget } from '../lib/provider-budget-store';
import { strategyStartingCents } from '../lib/strategy-budget-policy';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from '../lib/strategy-registry';
import { LONG_SHOT_DEFAULT_ALLOCATION_PERCENT } from '../lib/long-shot-execution';
import type { MarketAllocation, PaperOrder } from '../lib/types';

const MARKET_ID = 'crypto-15m';
const PROVIDER_ID = 'kalshi';
const LONG_SHOT_PERCENT = LONG_SHOT_DEFAULT_ALLOCATION_PERCENT;
const EDGE_PERCENT = 100 - LONG_SHOT_PERCENT;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), 'data', file), 'utf8')) as T;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');

  const { control } = await readJson<{ control: Record<string, number | string> }>('trading-control.json');
  const { orders } = await readJson<{ orders: PaperOrder[] }>('paper-orders.json');
  const openLive = orders.filter((order) => order.executionMode === 'live'
    && ['open', 'pending_reservation', 'uncertain'].includes(order.status));

  const blockers: string[] = [];
  if (control.state !== 'paused') blockers.push(`Automation is ${control.state}; budget changes require a paused, quiescent engine.`);
  if (Number(control.reservedBudgetCents) > 0) blockers.push(`${control.reservedBudgetCents}¢ is still reserved.`);
  if (openLive.length) blockers.push(`${openLive.length} live position(s) are still open or uncertain.`);

  const marketCapCents = Number(control.startingBudgetCents);
  const longShotCents = strategyStartingCents(marketCapCents, LONG_SHOT_PERCENT);
  const edgeCents = strategyStartingCents(marketCapCents, EDGE_PERCENT);

  console.log(`market cap            ${marketCapCents}¢ (${PROVIDER_ID} ${MARKET_ID})`);
  console.log(`edge-binary-buy       ${EDGE_PERCENT}% -> ${edgeCents}¢`);
  console.log(`long-shot-round-trip  ${LONG_SHOT_PERCENT}% -> ${longShotCents}¢  (ticket ${Math.floor(longShotCents / 30)}¢, halts below 300¢)`);
  console.log(`preconditions         ${blockers.length ? `BLOCKED\n  - ${blockers.join('\n  - ')}` : 'clear'}`);

  if (!write) {
    console.log('\nReport only. Re-run with --write to apply.');
    return;
  }
  if (blockers.length) {
    console.error('\nRefusing to write while the preconditions above are unmet.');
    process.exitCode = 1;
    return;
  }

  const budgets = await getProviderBudgets();
  const existing = providerBudget(budgets, PROVIDER_ID);
  if (!existing) throw new Error(`No ${PROVIDER_ID} budget to fund.`);

  const fundedAt = new Date().toISOString();
  const allocations: MarketAllocation[] = existing.allocations.map((allocation) => allocation.marketId !== MARKET_ID
    ? allocation
    : {
      ...allocation,
      strategies: [
        { strategyId: EDGE_BINARY_BUY, percent: EDGE_PERCENT, startingCents: edgeCents, fundedAt },
        { strategyId: LONG_SHOT_ROUND_TRIP, percent: LONG_SHOT_PERCENT, startingCents: longShotCents, fundedAt },
      ],
    });

  const next = await updateProviderBudget(PROVIDER_ID, { allocations });
  console.log(`\nWritten. provider-budget revision ${next.revision}.`);
  console.log(JSON.stringify(providerBudget(next, PROVIDER_ID)?.allocations, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
