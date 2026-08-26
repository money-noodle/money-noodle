import 'server-only';
import { getExecutionLedgerRuntime } from './execution-ledger-runtime';
import { readExecutionLedgerFile } from './execution-ledger-storage';
import { evaluateLiveRisk } from './live-risk-policy';
import type { BudgetControl, LiveRiskStatus, PaperOrder } from './types';

/** Reads compact immutable control rows without importing the execution engine or hydrating audit evidence. */
export async function getLiveRiskStatus(control: BudgetControl): Promise<LiveRiskStatus> {
  try {
    const runtime = getExecutionLedgerRuntime<{ orders: PaperOrder[] }>();
    // Outside a mutation, independently bundled control code shares the owner's immutable committed
    // snapshot. During a mutation it reads the latest durable compact generation: the working clone may
    // contain an uncommitted pre-wire change and must never leak into a control decision.
    const orders = !runtime.activeMutation && runtime.committed
      ? runtime.committed.orders
      : (await readExecutionLedgerFile(undefined, { verifyEvidence: false })).orders as PaperOrder[];
    return evaluateLiveRisk(control, orders);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return evaluateLiveRisk(control, []);
    throw error;
  }
}
