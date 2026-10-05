// The simulated bankroll, and the executions recorded beside it.
//
// Simulation only: none of these amounts is money, and this platform has no real-money
// authority at all. The source time is at the top rather than the bottom because the
// system that writes these records is stopped — the record is genuine and old, and an old
// record read as a current one would be the one misreading this page could cause.
//
// Two figures here are computed by this site, both of them stated as such: the reconciliation
// residual the API's own description tells a client to compute, and the status line. Every
// other number is the API's, converted from cents to dollars and nothing else.

import type { PaperBudget, PaperExecution } from '@money-noodle/platform-api-client';

import {
  DASH,
  formatCents,
  formatContractPrice,
  formatCount,
  formatLifecycle,
  formatNumber,
  formatSignedCents,
} from './format';
import { Panel, SourceTime } from './page-shell';

/** The reconciliation the API's description hands to a client, and its tolerance. */
export const RECONCILIATION_TOLERANCE_CENTS = 0.5;

export function reconciliationResidualCents(budget: PaperBudget): number {
  return budget.equityCents - (budget.startingCents + budget.realizedPnlCents);
}

/**
 * The bankroll's state, in the source's own precedence.
 *
 * Depleted wins over running: a bankroll with nothing left and nothing open is depleted
 * even though the two flags are independent in the record.
 */
export function budgetStatusLabel(budget: PaperBudget): string {
  if (budget.depleted) return 'Depleted';
  return budget.running ? 'Running' : 'Idle';
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ExecutionRow({ execution }: { readonly execution: PaperExecution }) {
  return (
    <tr>
      <th scope="row">{execution.symbol}</th>
      <td>{execution.venue}</td>
      <td>{execution.side}</td>
      <td>{formatLifecycle(execution.status, execution.noFillReason)}</td>
      <td>
        <time dateTime={execution.createdAt}>{execution.createdAt}</time>
      </td>
      <td>
        <time dateTime={execution.closesAt}>{execution.closesAt}</time>
      </td>
      <td>{formatContractPrice(execution.askPrice)}</td>
      <td>{formatNumber(execution.quantity, 6)}</td>
      <td>{formatCents(execution.stakeCents)}</td>
      <td>{formatCents(execution.feeCents)}</td>
      <td>{formatSignedCents(execution.pnlCents)}</td>
      <td>{execution.outcome ?? DASH}</td>
      <td>{execution.liquidityRole ?? DASH}</td>
    </tr>
  );
}

/**
 * The budget's headline figures, for a page that is not about the budget.
 *
 * The source time comes with them. A balance without the time it was recorded is the one
 * thing this record must never be shown as, because the system that writes it is stopped.
 */
export function PaperBudgetHeadline({ budget }: { readonly budget: PaperBudget }) {
  return (
    <Panel heading="Simulated bankroll" headingId="budget-headline-heading">
      <SourceTime label="Recorded by the simulation at" value={budget.sourceUpdatedAt} />
      <p className="panel__state">
        {budgetStatusLabel(budget)}. Next stake the simulation would commit:{' '}
        {formatCents(budget.proposedStakeCents)}.
      </p>
      <dl className="figures">
        <Row label="Equity" value={formatCents(budget.equityCents)} />
        <Row label="Available" value={formatCents(budget.availableCents)} />
        <Row
          label="Realized profit and loss, this funding"
          value={formatSignedCents(budget.realizedPnlCents)}
        />
        <Row label="Open positions" value={formatCount(budget.openOrders)} />
        <Row label="Settled positions" value={formatCount(budget.settledOrders)} />
      </dl>
      <p className="panel__note">
        The <a href="/paper/budget">simulated budget</a> view carries the full record and its recent
        executions.
      </p>
    </Panel>
  );
}

export function PaperBudgetView({ budget }: { readonly budget: PaperBudget }) {
  const residual = reconciliationResidualCents(budget);
  const reconciles = Math.abs(residual) < RECONCILIATION_TOLERANCE_CENTS;

  return (
    <>
      <Panel heading="Simulated bankroll" headingId="budget-heading">
        <SourceTime label="Recorded by the simulation at" value={budget.sourceUpdatedAt} />
        <p className="panel__state">
          {budgetStatusLabel(budget)}
          {budget.bankrollResets > 0
            ? ` after ${formatCount(budget.bankrollResets)} bankroll resets`
            : ''}
          . Next stake the simulation would commit: {formatCents(budget.proposedStakeCents)}.
        </p>

        <dl className="figures">
          <Row label="Starting balance" value={formatCents(budget.startingCents)} />
          <Row label="Available (uncommitted)" value={formatCents(budget.availableCents)} />
          <Row label="Reserved across open positions" value={formatCents(budget.reservedCents)} />
          <Row label="Equity (available plus reserved)" value={formatCents(budget.equityCents)} />
          <Row
            label="Realized profit and loss, this funding"
            value={formatSignedCents(budget.realizedPnlCents)}
          />
          <Row label="Open positions" value={formatCount(budget.openOrders)} />
          <Row label="Settled positions" value={formatCount(budget.settledOrders)} />
        </dl>

        <p className={reconciles ? 'panel__note' : 'panel__warning'}>
          {reconciles
            ? 'Equity reconciles with the starting balance plus realized profit and loss.'
            : `Equity does not reconcile with the starting balance plus realized profit and loss: a difference of ${formatCents(
                Math.abs(residual),
              )}.`}{' '}
          This difference is computed here from the three figures above. The realized figure on this
          record is whole-cent and covers the current funding only, so it is a different number from
          the exact lifetime figure on the full record; neither is wrong.
        </p>
      </Panel>

      <Panel heading="Recent simulated executions" headingId="executions-heading">
        {budget.recentExecutions.length === 0 ? (
          <p className="panel__state">
            The record carries no recent executions. An empty list beside a present budget record is
            a real answer, not a missing one.
          </p>
        ) : (
          <table className="executions">
            <caption>
              The {formatCount(budget.recentExecutions.length)} most recent simulated executions,
              newest first, as the source published them. Prices are cents of a one-dollar
              settlement; amounts are simulated.
            </caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Venue</th>
                <th scope="col">Side</th>
                <th scope="col">State</th>
                <th scope="col">Taken</th>
                <th scope="col">Settles</th>
                <th scope="col">Price paid</th>
                <th scope="col">Contracts</th>
                <th scope="col">Stake</th>
                <th scope="col">Fee</th>
                <th scope="col">Profit and loss</th>
                <th scope="col">Outcome</th>
                <th scope="col">Order role</th>
              </tr>
            </thead>
            <tbody>
              {budget.recentExecutions.map((execution) => (
                <ExecutionRow execution={execution} key={execution.executionKey} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
