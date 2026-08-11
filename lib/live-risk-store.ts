import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateLiveRisk } from './live-risk-policy';
import type { BudgetControl, LiveRiskStatus, PaperOrder } from './types';

const LEDGER_FILE = path.resolve(process.cwd(), 'data', 'paper-orders.json');

/** Reads the immutable live execution history without importing the execution engine into controls. */
export async function getLiveRiskStatus(control: BudgetControl): Promise<LiveRiskStatus> {
  try {
    const stored = JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as { orders?: PaperOrder[] };
    if (!Array.isArray(stored.orders)) throw new Error('Execution ledger orders are malformed.');
    return evaluateLiveRisk(control, stored.orders);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return evaluateLiveRisk(control, []);
    throw error;
  }
}
