/**
 * One-off durable housekeeping: reclaim orphaned atomic-write `.tmp` files under `data/` and `.cache/`.
 *
 * Reads nothing, writes nothing except removing a temp whose rename target already exists and whose age
 * exceeds `STALE_TMP_MS`. Never archives, never touches a ledger, never runs on a stateless host. The same
 * work runs automatically at persistent-worker startup via `cleanupStaleTmpFiles` in `src/instrumentation.ts`;
 * this script exists for an explicit invoker who cannot or will not restart the server.
 */
import path from 'node:path';
import { cleanupStaleTmpFiles } from '../src/lib/local-data-archive';

const roots = [
  path.resolve(process.cwd(), 'data'),
  path.resolve(process.cwd(), '.cache'),
];

const counts = await Promise.all(roots.map((root) =>
  cleanupStaleTmpFiles(root).catch((error) => {
    console.error(`Stale temp cleanup failed under ${root}:`, error);
    return 0;
  }),
));

for (let i = 0; i < roots.length; i += 1) {
  console.log(`${roots[i]}: ${counts[i]} stale temp file(s) reclaimed.`);
}