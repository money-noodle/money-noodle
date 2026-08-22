import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  compactExecutionLedgerAt, restoreExecutionLedgerMonolithAt, verifyExecutionLedgerAt,
} from '../lib/execution-ledger-compaction';
import { releaseForecastWriterLeaseForShutdown, serializeForecastMutation } from '../lib/forecast-write-lock';

const DATA_DIR = path.resolve(process.cwd(), 'data');

async function serverIsReachable(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(1_500) });
    return response.status > 0;
  } catch { return false; }
}

async function assertPaused(): Promise<void> {
  const stored = JSON.parse(await readFile(path.join(DATA_DIR, 'trading-control.json'), 'utf8')) as {
    control?: { state?: string; operatorIntent?: string; reservedBudgetCents?: number };
  };
  if (stored.control?.state !== 'paused' || stored.control.operatorIntent !== 'paused'
    || stored.control.reservedBudgetCents !== 0) {
    throw new Error('Execution-ledger compaction requires operator-paused control with zero reserved budget.');
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const restore = process.argv.includes('--restore-monolith');
  if (restore && !write) throw new Error('--restore-monolith requires --write.');
  if (!write) {
    console.log(JSON.stringify({ plan: await compactExecutionLedgerAt(DATA_DIR), verification: await verifyExecutionLedgerAt(DATA_DIR) }, null, 2));
    return;
  }
  await assertPaused();
  if (await serverIsReachable()) throw new Error('Execution-ledger migration refused while the local server is reachable.');
  const result = await serializeForecastMutation(async () => restore
    ? { restored: true, ...(await restoreExecutionLedgerMonolithAt(DATA_DIR)) }
    : { compacted: true, ...(await compactExecutionLedgerAt(DATA_DIR, { write: true })) });
  await releaseForecastWriterLeaseForShutdown();
  console.log(JSON.stringify({ ...result, verification: await verifyExecutionLedgerAt(DATA_DIR) }, null, 2));
}

main().catch(async (error) => {
  await releaseForecastWriterLeaseForShutdown().catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
