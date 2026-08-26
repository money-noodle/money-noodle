import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { releaseForecastWriterLeaseForShutdown, serializeForecastMutation } from '../src/lib/forecast-write-lock';
import { sealForecastStorage } from '../src/lib/forecast-store';
import { pruneForecastRetention, readFullForecastHistory } from '../src/lib/forecast-tracker';

const DATA_DIR = path.resolve(process.cwd(), 'data');

async function main() {
  const stored = JSON.parse(await readFile(path.join(DATA_DIR, 'trading-control.json'), 'utf8')) as {
    control?: { state?: string; operatorIntent?: string; reservedBudgetCents?: number };
  };
  if (stored.control?.state !== 'paused' || stored.control.operatorIntent !== 'paused' || stored.control.reservedBudgetCents !== 0) {
    throw new Error('Forecast compaction requires operator-paused control with zero reserved budget.');
  }
  const result = await serializeForecastMutation(async () => {
    const rows = pruneForecastRetention(await readFullForecastHistory());
    const index = await sealForecastStorage(rows);
    return { index, rows: rows.length };
  });
  await releaseForecastWriterLeaseForShutdown();
  console.log(JSON.stringify({ compacted: true, ...result }, null, 2));
}

main().catch(async (error) => {
  await releaseForecastWriterLeaseForShutdown().catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
