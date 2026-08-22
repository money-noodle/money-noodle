import type { PaperOrder } from '../../lib/types';

export interface ScriptExecutionLedger {
  version?: number;
  orders: PaperOrder[];
  [key: string]: unknown;
}

export function readExecutionLedger(dataDirectory?: string): Promise<ScriptExecutionLedger>;
export function readExecutionLedgerSync(dataDirectory?: string): ScriptExecutionLedger;
