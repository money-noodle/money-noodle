import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupNextBuildCaches } from '../src/lib/next-cache-cleanup';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  if (process.env.VERCEL === '1' || process.env.MONEY_NOODLE_STATELESS === 'true') {
    throw new Error('Next cache cleanup is local-worker housekeeping only.');
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'command='], { maxBuffer: 4 * 1024 * 1024 });
  const result = await cleanupNextBuildCaches(process.cwd(), stdout);
  console.log(JSON.stringify({
    ...result,
    reclaimedMiB: Number((result.reclaimedBytes / 1024 / 1024).toFixed(2)),
  }, null, 2));
}

main().catch((error) => {
  console.error('Next cache cleanup failed:', error);
  process.exitCode = 1;
});
