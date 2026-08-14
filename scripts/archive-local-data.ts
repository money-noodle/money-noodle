import path from 'node:path';
import { archiveLocalData, localArchiveConfig } from '../lib/local-data-archive';

// Next loads .env.local for the scheduler. The manual command has the same local-only behavior.
try { process.loadEnvFile(path.resolve(process.cwd(), '.env.local')); } catch { /* Scheduler credentials may already be inherited. */ }

async function main(): Promise<void> {
  const config = localArchiveConfig();
  if (!config) throw new Error('Local archive is disabled or missing its bucket credentials.');
  const { manifest, manifestKey } = await archiveLocalData(config, { onProgress: (message) => console.log(`Local archive: ${message}`) });
  console.log(`Local archive verified ${manifest.totals.files} files (${manifest.totals.sourceBytes} source bytes; ${manifest.totals.newBlobs} new, ${manifest.totals.reusedBlobs} reused) at ${manifestKey}.`);
}

// Some S3-compatible HTTP agents unref idle sockets between multipart steps. Keep the standalone
// worker alive until its top-level promise settles rather than allowing Node to exit with a lock held.
const keepAlive = setInterval(() => undefined, 60_000);
main().catch((error) => {
  console.error('Local archive failed:', error);
  process.exitCode = 1;
}).finally(() => clearInterval(keepAlive));
