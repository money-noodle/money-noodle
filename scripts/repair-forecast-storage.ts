import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireForecastWriterLeaseAt } from '../lib/forecast-write-lock';
import { loadForecastRecoverySource, recoverForecastRows } from '../lib/forecast-repair';
import { buildForecastStoragePlan, verifyForecastStoragePlan, writeForecastStoragePlan } from '../lib/forecast-storage';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ACTIVE_ROOT = path.join(DATA_DIR, 'forecast-history-shards');
const CURRENT_JOURNAL = path.join(DATA_DIR, 'forecast-history.journal.jsonl');
const argument = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const archiveRoot = path.resolve(argument('--archive-root', '/tmp/money-forecast-archive')!);
const archiveJournal = path.resolve(argument('--archive-journal', path.join(archiveRoot, 'forecast-history.journal.jsonl'))!);
const apply = process.argv.includes('--apply');
const confirmation = argument('--confirmation');
const generatedAt = new Date().toISOString();
const stamp = generatedAt.replace(/[:.]/g, '-');

async function atomicWrite(file: string, content: string) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function controlPreconditions() {
  const stored = JSON.parse(await readFile(path.join(DATA_DIR, 'trading-control.json'), 'utf8')) as {
    control?: { state?: string; operatorIntent?: string; reservedBudgetCents?: number; revision?: number; updatedAt?: string };
  };
  const control = stored.control;
  if (control?.state !== 'paused' || control.operatorIntent !== 'paused' || control.reservedBudgetCents !== 0) {
    throw new Error('Forecast repair requires operator-paused control with zero reserved budget.');
  }
  return control;
}

async function main() {
  const control = await controlPreconditions();
  const [archive, current] = await Promise.all([
    loadForecastRecoverySource({ label: 'verified archive', root: archiveRoot, journalFile: archiveJournal, strictIndex: true }),
    loadForecastRecoverySource({ label: 'corrupt current layout', root: ACTIVE_ROOT, journalFile: CURRENT_JOURNAL, strictIndex: false }),
  ]);
  const recovery = recoverForecastRows(archive, current);
  const plan = buildForecastStoragePlan(recovery.rows, generatedAt);
  const verification = verifyForecastStoragePlan(recovery.rows, plan);
  if (!verification.ok) throw new Error(`Recovered v3 plan failed verification: ${verification.errors.join(' ')}`);

  const manifest = {
    version: 'forecast-storage-repair-v1', generatedAt, applied: false,
    control: { revision: control.revision, updatedAt: control.updatedAt, state: control.state, operatorIntent: control.operatorIntent, reservedBudgetCents: control.reservedBudgetCents },
    sources: {
      archive: { root: archiveRoot, indexHash: archive.indexHash, journalHash: archive.journalHash, rows: archive.sealed.length + archive.open.length, events: archive.events.length, diagnostics: archive.diagnostics },
      current: { root: ACTIVE_ROOT, indexHash: current.indexHash, journalHash: current.journalHash, rows: current.sealed.length + current.open.length, events: current.events.length, diagnostics: current.diagnostics },
    },
    recovery: {
      archiveRowsAfterReplay: recovery.archiveRowsAfterReplay,
      currentRowsAfterReplay: recovery.currentRowsAfterReplay,
      ignoredStalePending: recovery.ignoredStalePending,
      canonicalizedTerminalCollisions: recovery.canonicalizedTerminalCollisions,
      restoredQualified: recovery.restoredQualifiedIds.length,
      restoredQualifiedIds: recovery.restoredQualifiedIds,
      prunedUnqualified: recovery.prunedUnqualified,
      unresolvedEvidenceGap: 'The archive journal ended near 2026-08-22T03:58Z and the surviving current journal began near 2026-08-22T05:22Z; rows lost by stale writers inside that interval have no surviving authoritative source.',
    },
    plan: {
      version: plan.index.version, generation: plan.index.generation, totalRows: plan.index.totalRows,
      terminalRows: plan.index.terminalRows, openRows: plan.index.openRows, shards: plan.index.shards.length,
      verification: verification.summary,
    },
  };

  if (!apply) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (confirmation !== 'REPAIR-FORECAST-STORAGE') throw new Error('Apply requires --confirmation REPAIR-FORECAST-STORAGE.');

  const lease = await acquireForecastWriterLeaseAt(DATA_DIR);
  const staging = path.join(DATA_DIR, `forecast-history-shards.repair-${process.pid}-${Date.now()}`);
  const corruptRoot = `${ACTIVE_ROOT}.corrupt-${stamp}`;
  const corruptJournal = `${CURRENT_JOURNAL}.corrupt-${stamp}`;
  try {
    // Refuse if anything changed after the dry reconstruction and before ownership was acquired.
    const currentIndexHash = (await import('node:crypto')).createHash('sha256').update(await readFile(path.join(ACTIVE_ROOT, 'index.json'))).digest('hex');
    const currentJournalHash = (await import('node:crypto')).createHash('sha256').update(await readFile(CURRENT_JOURNAL)).digest('hex');
    if (currentIndexHash !== current.indexHash || currentJournalHash !== current.journalHash) throw new Error('Current forecast sources changed during repair; refusing publication.');

    await mkdir(staging, { recursive: true });
    await writeForecastStoragePlan(staging, plan);
    // Preserve a second byte copy of the journal before switching. The directory and original journal are
    // subsequently moved to their required .corrupt-* names, never edited in place.
    await copyFile(CURRENT_JOURNAL, `${staging}.source-journal`);
    await rename(ACTIVE_ROOT, corruptRoot);
    await rename(staging, ACTIVE_ROOT);
    await rename(CURRENT_JOURNAL, corruptJournal);
    await atomicWrite(CURRENT_JOURNAL, '');
    await rename(`${staging}.source-journal`, `${corruptRoot}.journal-copy`);

    manifest.applied = true;
    Object.assign(manifest, { installedRoot: ACTIVE_ROOT, quarantinedRoot: corruptRoot, quarantinedJournal: corruptJournal });
    const manifestFile = path.join(DATA_DIR, `forecast-history-repair-${stamp}.json`);
    await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify({ ...manifest, manifestFile }, null, 2));
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await lease.release();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
