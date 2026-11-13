// The ONE lease-fence barrier used by every hosted contract that needs to observe the
// final `for update` genuinely blocked on a live lease. It exists as a module so each
// contract reuses the same proven settle and deadline code instead of copying fragile
// timing logic; the two focused regressions below the proof in the coverage contract
// cover this file's failure paths.
//
// Synthetic fixtures only, loopback only, superuser the harnesses already use: no new
// role, grant, schema or production effect, and no production module is altered or
// fault-injected. `faults` are harness-only and default off.
//
// BOUNDING, STATED PRECISELY. Every wait here is bounded by a REAL elapsed deadline and
// by its own connection's `statement_timeout`, never by iteration count: an iteration
// budget says nothing about elapsed time once query duration and host scheduling are
// counted. The blocked span an adapter actually experiences is anchored to the fixture
// lease's ABSOLUTE expiry instant — `LEASE_BUDGET_MS` after the update that sets it —
// because the holder releases as soon as the DATABASE clock passes that instant; it is
// not the sum of the diagnostic deadlines. Those deadlines are fail-closed backstops
// for the case where that never happens, chosen to leave margin under the adapters'
// unchanged 3000ms `lock_timeout`. This is an engineered margin, NOT a hard real-time
// guarantee: host scheduling can stretch any of it, and the deliberate property is
// that when it does, the calling vector FAILS with these diagnostics rather than
// hanging or passing vacuously.
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

export const LEASE_BUDGET_MS = 1500;
export const OBSERVE_DEADLINE_MS = 900;
export const OBSERVE_STATEMENT_TIMEOUT_MS = 500;
export const HOLDER_STATEMENT_TIMEOUT_MS = 2000;
export const EXPIRY_DEADLINE_MS = 2500;
export const POLL_MS = 25;
// Well inside the adapter's unchanged 3000ms `lock_timeout`: an observation phase
// that ran past this could only end in a lock timeout, so the bound is asserted
// rather than assumed.
export const BLOCKED_SPAN_CEILING_MS = 2900;
export const HOLDER_FAULT = 'harness-holder-fault-before-lock';
// Captured in the SAME statement as the blocking relationship, so liveness and the
// block are observed together rather than inferred from two reads. Only positions
// are selected from `query`, never its text.
export const OBSERVER_QUERY =
  "select a.pid::text as pid, coalesce(array_to_string(pg_blocking_pids(a.pid),','),'') as blockers, a.state, a.wait_event_type, a.wait_event, position('for update' in a.query) as fence_marker, position('engine.job_lease' in a.query) as table_marker, clock_timestamp()::text as observed_at, (select l.expires_at > clock_timestamp() from engine.job_lease l where l.capability=$2) as lease_live, (select l.expires_at::text from engine.job_lease l where l.capability=$2) as expires_at from pg_stat_activity a where a.pid=$1";

/** One barrier factory bound to a cluster, a capability and the caller's own
 * `leaseLive()` reader. Returns `lockWaitBarrier(faults)`. */
export function createLeaseFenceHarness({ port, capability, leaseLive }) {
  // ONE barrier implementation, shared by the real proof below and by the two focused
  // failure-path regressions after it, so those regressions exercise the SAME settle
  // and deadline code the proof depends on instead of a look-alike copy. `faults` are
  // harness-only and default off: nothing is injected into the adapter, the domain or
  // any other production module, and with no faults the behaviour is exactly the
  // proof's.
  //
  // The harness's `admin` handle is a SINGLE connection. The holder keeps a
  // transaction open while the observer must query concurrently, so each needs its own
  // connection or the holder would occupy `admin` and the observer would queue behind
  // it forever. Same superuser the harness already uses; no new role or grant.
  const lockWaitBarrier = (faults = {}) => {
    const holderSql = postgres('postgres://postgres@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
      connection: {
        statement_timeout: HOLDER_STATEMENT_TIMEOUT_MS,
        // The holder transaction is deliberately idle between its own statements while
        // it waits; this bound only has to outlast the whole hold.
        idle_in_transaction_session_timeout: 20000,
      },
    });
    const observerSql = postgres('postgres://postgres@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
      // Caps a SINGLE observation query, so one slow read cannot silently spend the
      // whole elapsed deadline.
      connection: { statement_timeout: OBSERVE_STATEMENT_TIMEOUT_MS },
    });
    // Takes the handle explicitly: inside the holder it MUST be that transaction's own
    // `tx`, because the pool holds a single connection which the open transaction
    // occupies, and a pool-level query would queue behind itself forever.
    const leaseLiveOn = async (sql) => {
      const [row] = await sql.unsafe(
        'select (expires_at>clock_timestamp()) as live from engine.job_lease where capability=$1',
        [capability],
      );
      return row.live === true;
    };
    const evidence = { observations: 0 };
    // Compact, non-sensitive diagnostics for any failure message: pids, states, wait
    // events, elapsed milliseconds and synthetic fixture timestamps only. No query
    // text, no connection string, no credential, no account or money value.
    evidence.diagnostics = () =>
      JSON.stringify({
        blockedWhileLive: evidence.blockedWhileLive,
        expiredBeforeRelease: evidence.expiredBeforeRelease,
        expiryWaitMs: evidence.expiryWaitMs,
        expiryWaitSkipped: evidence.expiryWaitSkipped,
        holderError: evidence.holderError,
        holderErrorMessage: evidence.holderErrorMessage,
        holderPid: evidence.holderPid,
        lastRow: evidence.lastRow,
        lockAcquired: evidence.lockAcquired,
        observations: evidence.observations,
        observeMs: evidence.observeMs,
        observerError: evidence.observerError,
        observerTimedOut: evidence.observerTimedOut,
        readerPid: evidence.readerPid,
      });
    let ran = false;
    const barrier = async ({ backendPid }) => {
      if (ran) return;
      ran = true;
      evidence.ran = true;
      evidence.readerPid = backendPid;
      // No UPDATE anywhere in this barrier: the expiry is set BEFORE the read begins,
      // so nothing commits over the lease row and the 40001 path cannot fire or mask
      // this one. Owner, token, expiry and the row version are all left untouched.
      evidence.liveBeforeBlock = await leaseLive();
      let signalLocked;
      const locked = new Promise((resolve) => {
        signalLocked = resolve;
      });
      let signalObserved;
      const observed = new Promise((resolve) => {
        signalObserved = resolve;
      });
      evidence.holder = holderSql
        .begin(async (tx) => {
          const holderSelf = await tx.unsafe('select pg_backend_pid()::text as pid');
          evidence.holderPid = Number(holderSelf[0].pid);
          // Harness-only fault, default off: fail BEFORE the lock is acquired. That is
          // exactly the path that used to leave the barrier's `await locked` pending
          // forever, hanging the adapter's open transaction with no diagnosis.
          if (faults.failBeforeLock === true) throw new Error(HOLDER_FAULT);
          await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 for update',
            [capability],
          );
          evidence.lockAcquired = true;
          signalLocked(undefined);
          // Hold the row lock, unchanged, until the observer has seen the adapter
          // blocked while the lease was still live AND the lease has since expired.
          await observed;
          if (evidence.blockedWhileLive === undefined) {
            // Nothing was observed, so this vector has already failed and there is
            // nothing left to hold the lock for. Release promptly instead of spending
            // the expiry budget and risking the adapter's lock timeout on top.
            evidence.expiryWaitSkipped = true;
            return;
          }
          const expiryStartedAt = Date.now();
          while (Date.now() - expiryStartedAt < EXPIRY_DEADLINE_MS) {
            if (!(await leaseLiveOn(tx))) break;
            await delay(POLL_MS);
          }
          evidence.expiryWaitMs = Date.now() - expiryStartedAt;
          evidence.expiredBeforeRelease = !(await leaseLiveOn(tx));
        })
        .catch((error) => {
          evidence.holderError = error.code ?? String(error);
          evidence.holderErrorMessage = error.message ?? String(error);
          // Settle BOTH gates on EVERY holder failure path. A holder that fails BEFORE
          // `signalLocked` must not leave `await locked` below pending: that hung the
          // adapter's open transaction with no diagnosis and no failure. The original
          // error is preserved and handed back through `locked`, so the barrier fails
          // PROMPTLY with it rather than continuing into an observation that can no
          // longer happen and then passing or failing for the wrong reason.
          signalLocked(error);
          signalObserved();
        });
      const lockFailure = await locked;
      if (lockFailure !== undefined) {
        evidence.lockedSettledWithFailure = true;
        throw lockFailure;
      }
      // The observer runs while this barrier's caller is blocked, so it is started and
      // deliberately NOT awaited here; its promise is awaited after the read resolves.
      const expectedBlocker = faults.impossibleBlocker === true ? -1 : String(evidence.holderPid);
      evidence.observer = (async () => {
        const observeStartedAt = Date.now();
        try {
          // A REAL elapsed deadline. The previous loop bounded iterations only: 200
          // polls at 25ms is 5000ms of sleep BEFORE query duration, which outlives the
          // adapter's 3000ms lock_timeout, so a non-matching run could end in a lock
          // timeout instead of this vector's own diagnosis.
          while (Date.now() - observeStartedAt < OBSERVE_DEADLINE_MS) {
            const [row] = await observerSql.unsafe(OBSERVER_QUERY, [
              String(evidence.readerPid),
              capability,
            ]);
            evidence.observations += 1;
            evidence.lastRow = row;
            if (
              row !== undefined &&
              row.blockers === String(expectedBlocker) &&
              row.fence_marker > 0 &&
              row.table_marker > 0 &&
              row.lease_live === true
            ) {
              evidence.blockedWhileLive = {
                blockers: row.blockers,
                expiresAt: row.expires_at,
                leaseLiveAtObservation: row.lease_live,
                observedAt: row.observed_at,
                state: row.state,
                waitEvent: row.wait_event,
                waitEventType: row.wait_event_type,
              };
              break;
            }
            await delay(POLL_MS);
          }
        } catch (error) {
          evidence.observerError = error.code ?? String(error);
        } finally {
          evidence.observeMs = Date.now() - observeStartedAt;
          evidence.observerTimedOut = evidence.blockedWhileLive === undefined;
          // Always release the holder, on the match path, the deadline path and the
          // error path alike, so no failure can strand the open transaction.
          signalObserved();
        }
      })();
    };
    return {
      barrier,
      evidence,
      // Never leave the holder or observer dangling, whatever failed, and always
      // release both dedicated connections so a failure cannot hang the contract.
      dispose: async () => {
        await Promise.allSettled([evidence.observer, evidence.holder]);
        await Promise.allSettled([holderSql.end({ timeout: 5 }), observerSql.end({ timeout: 5 })]);
      },
    };
  };
  return lockWaitBarrier;
}
