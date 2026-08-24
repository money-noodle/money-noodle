import path from 'node:path';
import { localArchiveConfig, readLocalArchiveState, restoreLocalArchive } from '../lib/local-data-archive';

try { process.loadEnvFile(path.resolve(process.cwd(), '.env.local')); } catch { /* Credentials may already be inherited. */ }

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const config = localArchiveConfig();
  if (!config) throw new Error('Local archive is disabled or missing its bucket credentials.');
  const requestedDestination = argument('--destination');
  if (!requestedDestination) throw new Error('Pass a new restore directory with --destination <path>.');
  const destination = path.resolve(requestedDestination);
  const relativeToActiveData = path.relative(config.dataDirectory, destination);
  if (!relativeToActiveData || (!relativeToActiveData.startsWith('..') && !path.isAbsolute(relativeToActiveData))) {
    throw new Error('Refusing to restore into or below the active data directory.');
  }
  const state = await readLocalArchiveState(config.dataDirectory);
  const manifestKey = argument('--manifest-key') ?? state?.lastManifestKey;
  if (!manifestKey) throw new Error('No manifest key was supplied and archive state has no successful manifest.');

  const result = await restoreLocalArchive(config, manifestKey, destination, {
    onProgress: (message) => console.log(`Local restore: ${message}`),
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

const keepAlive = setInterval(() => undefined, 60_000);
main().catch((error) => {
  console.error('Local archive restore failed:', error);
  process.exitCode = 1;
}).finally(() => clearInterval(keepAlive));
