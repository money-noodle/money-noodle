/**
 * Restart the persistent worker safely.
 *
 * Hand-restarting this desk produced three separate surprises in one evening, every one of them from a step
 * that looks trivial until it fails:
 *
 *   1. A shell wait loop with no sleep spins instantly, so the stop is declared complete while the old
 *      process is still alive. That started a second server on top of the first: two background collectors
 *      against one funded state, and only the forecast writer lease standing between them and a corrupted
 *      history.
 *   2. SIGTERM is not always enough. Next can sit in shutdown well past fifteen seconds; the old process
 *      here had to be escalated.
 *   3. The forecast writer lease is held for the process lifetime. It self-heals only once the previous
 *      owner is genuinely dead, so a restart that leaves the old process running silently loses every
 *      forecast write on the new one.
 *
 * This script refuses rather than forces: it will not stop a desk holding a position or a reservation, and
 * it fails loudly if more than one server survives. Building first is part of the operation, because a
 * restart onto a stale build is how a fix appears to be live when it is not.
 *
 * The ordering exists to bound one specific hazard: the interval where the desk is stopped. Everything slow
 * happens before the stop, the start follows it immediately, and every check after the start only reports.
 * A first version of this script was itself killed mid-run and left the desk down, which is worse than the
 * problem it set out to solve, so an interrupted or failing run now restarts the worker on its way out.
 *
 * Read-only with respect to durable state: it places no order and writes no ledger.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readExecutionLedgerSync } from './lib/read-execution-ledger.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const LOG = path.join(ROOT, '.next-server.log');
const PORT = Number(process.env.PORT ?? 3000);
const FORCE = process.argv.includes('--force');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (message) => console.log(message);

/** True once the stop has happened and the replacement has not yet been spawned. */
let deskIsDown = false;

function spawnWorker() {
  const out = openSync(LOG, 'a');
  spawn('npm', ['run', 'start'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] }).unref();
  deskIsDown = false;
}

/**
 * Never exit leaving the desk stopped. An interrupted restart that has already killed the old worker must
 * put one back, even on its way out under a signal.
 */
function rescue(why) {
  if (!deskIsDown) return;
  console.error(`${why} after the worker was stopped; starting a replacement before exiting.`);
  try { spawnWorker(); } catch (error) { console.error('Replacement start failed:', error); }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { rescue(`Received ${signal}`); process.exit(130); });
}
process.on('uncaughtException', (error) => { rescue(`Uncaught ${error?.message ?? error}`); process.exit(1); });

function listeningPids() {
  try {
    return [...new Set(execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      // Must be > 0, not merely an integer: an empty trailing line parses to 0, and process.kill(0, …)
      // signals the whole process group. That is not a hypothetical -- it killed two runs of this script.
      .split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  } catch { return []; }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Present funded state comes from the durable control file and the ledger, never from an assumption. */
function deskState() {
  // Through the sanctioned reader rather than the raw file, so this shares one definition of the ledger
  // with every analysis; reporting-read-path.test.ts pins that nothing else opens paper-orders.json.
  const ledger = readExecutionLedgerSync(DATA);
  const control = JSON.parse(readFileSync(path.join(DATA, 'trading-control.json'), 'utf8'));
  const settings = control.control ?? control;
  const working = ledger.orders.filter((order) => order.executionMode === 'live'
    && ['open', 'pending_reservation', 'uncertain'].includes(order.status));
  return { working, reservedCents: settings.reservedBudgetCents ?? 0, state: settings.state };
}

/**
 * A single sample can land mid-cycle: an order goes uncertain and the reserve is held for a second or two
 * before reconciliation clears it. Two consecutive clean samples skip that transient.
 */
async function waitForQuiescence(attempts = 20) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const first = deskState();
    if (!first.working.length && first.reservedCents === 0) {
      await sleep(400);
      const second = deskState();
      if (!second.working.length && second.reservedCents === 0) return { attempt, state: second.state };
    }
    await sleep(1500);
  }
  return null;
}

async function stop(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;   // never signal a process group
  say(`Stopping pid ${pid}…`);
  try { process.kill(pid, 'SIGTERM'); } catch { return true; }
  for (let second = 1; second <= 20; second += 1) {
    await sleep(1000);
    if (!alive(pid)) { say(`  exited after ${second}s`); return true; }
  }
  say('  still alive after 20s; escalating to SIGKILL');
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  for (let second = 1; second <= 10; second += 1) {
    await sleep(1000);
    if (!alive(pid)) { say(`  killed after a further ${second}s`); return true; }
  }
  return false;
}

async function main() {
  say('1/5  Building…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  say('     build complete');

  say('2/5  Waiting for a quiescent desk…');
  const quiet = await waitForQuiescence();
  if (!quiet) {
    const now = deskState();
    console.error(`REFUSED: the desk did not reach a quiescent window. ${now.working.length} live position(s) working, ${now.reservedCents}c reserved.`);
    console.error('Nothing was stopped. Resolve the position or pause and drain first.');
    process.exit(1);
  }
  say(`     clean on attempt ${quiet.attempt} (control state: ${quiet.state})`);

  say('3/5  Stopping the running worker…');
  const running = listeningPids();
  if (!running.length) say('     nothing listening; starting fresh');
  for (const pid of running) {
    deskIsDown = true;
    if (!await stop(pid)) {
      // Two collectors against one funded state is the worse outcome, so this is the one path that
      // deliberately leaves nothing running rather than stacking a second worker on a survivor.
      deskIsDown = false;
      console.error(`REFUSED: pid ${pid} would not die. Not starting a second worker on top of it.`);
      process.exit(1);
    }
  }
  // The lease is held for the process lifetime, so a survivor silently breaks the new worker's writes.
  const survivors = running.filter(alive);
  if (survivors.length && !FORCE) {
    console.error(`REFUSED: ${survivors.join(', ')} still alive after stop.`);
    process.exit(1);
  }

  say('4/5  Starting detached…');
  spawnWorker();

  // Everything below only reports. The worker is already running, so a failure here must not exit in a way
  // that suggests the desk is down, and must never stop it.
  say('5/5  Verifying…');
  let httpOk = false;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    await sleep(1000);
    try {
      const response = await fetch(`http://localhost:${PORT}/`, { redirect: 'manual' });
      if (response.status > 0) { httpOk = true; break; }
    } catch { /* not up yet */ }
  }
  if (!httpOk) { console.error('WARNING: the worker did not answer within 40s. It was started; check .next-server.log.'); process.exit(1); }

  const listeners = listeningPids();
  if (listeners.length !== 1) {
    console.error(`WARNING: ${listeners.length} processes are listening on ${PORT}: ${listeners.join(', ')}. Expected exactly one.`);
    process.exit(1);
  }

  // The failure that actually bit: writes fail silently while a dead owner's lease is still on disk.
  let leaseOk = false;
  const lockOwner = path.join(DATA, 'forecast-history.write.lock', 'owner.json');
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await sleep(1000);
    if (!existsSync(lockOwner)) continue;
    try {
      const owner = JSON.parse(readFileSync(lockOwner, 'utf8'));
      if (owner.pid === listeners[0]) { leaseOk = true; say(`     forecast writer lease held by the new worker (pid ${owner.pid})`); break; }
    } catch { /* mid-write */ }
  }
  if (!leaseOk) {
    console.error('WARNING: the new worker has not taken the forecast writer lease. Forecast writes may be failing silently.');
    console.error(`Inspect ${lockOwner} and .next-server.log.`);
    process.exit(1);
  }

  say(`\nRestarted. One worker on port ${PORT}, pid ${listeners[0]}, desk state ${deskState().state}.`);
}

main().catch((error) => { console.error('Restart failed:', error); process.exit(1); });
