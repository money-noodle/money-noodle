/**
 * Repairs the approved HYPE repeated-episode identity incident without hand-editing durable state.
 *
 *   npm run correct:live-order-identity            # report only
 *   npm run correct:live-order-identity -- --write # apply while the local server is stopped
 *
 * The ledger projection is atomic and written first; trading control is atomic and written second. Both
 * carry one stable correction ID, so a rerun completes only a missing projection after an interrupted run.
 * See docs/live-order-identity-correction-design.md.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyHypeIdentityControlCorrection, applyHypeIdentityLedgerCorrection,
  type CorrectableLiveLedger, type CorrectableTradingControl,
} from '../lib/live-order-identity-correction';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'paper-orders.json');
const CONTROL_FILE = path.join(DATA_DIR, 'trading-control.json');

async function serverIsReachable(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(1_500) });
    return response.status > 0;
  } catch { return false; }
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const [ledgerRaw, controlRaw] = await Promise.all([
    readFile(LEDGER_FILE, 'utf8'), readFile(CONTROL_FILE, 'utf8'),
  ]);
  const ledger = JSON.parse(ledgerRaw) as CorrectableLiveLedger;
  if (ledger.version === 9) throw new Error('This historical correction refuses execution-ledger v9. Restore a verified monolith through compact:execution-ledger -- --write --restore-monolith first.');
  const control = JSON.parse(controlRaw) as CorrectableTradingControl;
  const before = {
    ledgerVersion: ledger.version,
    liveCorrections: ledger.liveCorrections?.length ?? 0,
    availableBudgetCents: control.control.availableBudgetCents,
    realizedPnlCents: control.control.realizedPnlCents,
    controlRevision: control.control.revision,
  };
  const at = new Date().toISOString();
  const ledgerResult = applyHypeIdentityLedgerCorrection(ledger, at);
  const controlResult = applyHypeIdentityControlCorrection(control, at);
  const after = {
    ledgerVersion: ledger.version,
    liveCorrections: ledger.liveCorrections?.length ?? 0,
    availableBudgetCents: control.control.availableBudgetCents,
    realizedPnlCents: control.control.realizedPnlCents,
    controlRevision: control.control.revision,
  };

  console.log(JSON.stringify({ write, ledgerChanged: ledgerResult.changed, controlChanged: controlResult.changed,
    exactPnlDeltaCents: ledgerResult.correction.exactPnlDeltaCents,
    wholeCentControlDeltaCents: controlResult.amountCents, before, after,
  }, null, 2));
  if (!ledgerResult.changed && !controlResult.changed) {
    console.log('\nNothing to correct; both projections already carry the stable correction ID.');
    return;
  }
  if (!write) {
    console.log('\nReport only. Stop the local server, then rerun with --write.');
    return;
  }
  if (await serverIsReachable()) throw new Error('Local server is reachable; stop it before correcting files it owns.');

  if (ledgerResult.changed) await atomicWrite(LEDGER_FILE, ledger);
  if (controlResult.changed) await atomicWrite(CONTROL_FILE, control);
  console.log('\nApplied the idempotent ledger and trading-control projections. Rerun report-only to verify.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
