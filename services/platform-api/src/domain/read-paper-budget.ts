// The budget row and its executions, as the API publishes them.
//
// The projection's own shape arrives already typed — `postgres-paper-projection`
// reads every column through an explicit reader — so this file is not validating
// a document. It is doing the one conversion a JSON response forces: exact cents
// and exact decimals become JSON numbers, and a value that cannot be carried
// exactly is refused rather than rounded (`readExactNumber`).
//
// Two parity rules worth seeing in the code rather than only in the contract:
//
//   * A nullable execution column becomes an **absent key**, not `null`. That is
//     the source's own distinction between "not known yet" and "known to be
//     nothing", and a client that treats the two differently is reading it
//     correctly.
//   * `sourceUpdatedAt` is published although v1 hid it. Freshness is disclosed,
//     never judged: no threshold is applied here and no record is withheld for
//     being old (#210).

import type { PaperBudgetRow, PaperExecutionRow } from './paper-projection.js';
import type { PublishedBudget, PublishedExecution } from './paper-dashboard.js';
import { readExactNumber } from './read-record.js';

function publishedExecution(row: PaperExecutionRow, path: string): PublishedExecution {
  return Object.freeze({
    askPrice: readExactNumber(row.askPrice, `${path}.askPrice`),
    closesAt: row.closesAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    executionKey: row.executionKey,
    feeCents: readExactNumber(row.feeCents, `${path}.feeCents`),
    // Spread-on-condition rather than `: undefined`, so the key is genuinely
    // absent from the JSON rather than present and undefined.
    ...(row.liquidityRole === null ? {} : { liquidityRole: row.liquidityRole }),
    ...(row.noFillReason === null ? {} : { noFillReason: row.noFillReason }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.pnlCents === null
      ? {}
      : { pnlCents: readExactNumber(row.pnlCents, `${path}.pnlCents`) }),
    quantity: readExactNumber(row.quantity, `${path}.quantity`),
    side: row.side,
    stakeCents: readExactNumber(row.stakeCents, `${path}.stakeCents`),
    status: row.status,
    symbol: row.symbol,
    venue: row.venue,
  });
}

export function readPaperBudget(
  budget: PaperBudgetRow,
  executions: readonly PaperExecutionRow[],
): PublishedBudget {
  return Object.freeze({
    availableCents: readExactNumber(budget.availableCents, 'availableCents'),
    bankrollResets: budget.bankrollResets,
    depleted: budget.depleted,
    durable: true as const,
    equityCents: readExactNumber(budget.equityCents, 'equityCents'),
    openOrders: budget.openOrders,
    proposedStakeCents: readExactNumber(budget.proposedStakeCents, 'proposedStakeCents'),
    realizedPnlCents: readExactNumber(budget.realizedPnlCents, 'realizedPnlCents'),
    recentExecutions: Object.freeze(
      executions.map((row, index) => publishedExecution(row, `recentExecutions[${index}]`)),
    ),
    reservedCents: readExactNumber(budget.reservedCents, 'reservedCents'),
    running: budget.running,
    settledOrders: budget.settledOrders,
    sourceUpdatedAt: budget.sourceUpdatedAt.toISOString(),
    startingCents: readExactNumber(budget.startingCents, 'startingCents'),
  });
}
