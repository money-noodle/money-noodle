import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeCycleStore, type FakeLease } from './adapters/engine-store/fake-cycle-store.js';
import {
  CYCLE_CAPABILITY,
  CYCLE_JOB_RUN_CAPABILITY,
  runCycleJob,
  type CycleJobInput,
  type PaperAuthorityReader,
} from './application/cycle.js';
import type {
  PaperAuthorityEvidence,
  PaperAuthorityFence,
  PaperAuthorityReadResult,
  PaperAuthorityScope,
} from './domain/paper-authority-evidence.js';
import type { PaperAuthorityDecision } from './domain/paper-authority.js';
import {
  CYCLE_REASONS,
  DEFAULT_TICKS,
  FencingTokenRejectedError,
  isCycleMode,
  leaseExpiry,
  leaseIsLive,
  leaseWindowMs,
  LEASE_GRACE_MS,
  TICK_INTERVAL_MS,
} from './domain/cycle-store.js';
import {
  compareIntents,
  evaluateIntent,
  latestIntent,
  MAX_INTENT_CLOCK_SKEW_MS,
  type ControlAction,
  type IntentRow,
} from './domain/intent.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const intent = (overrides: Partial<IntentRow> = {}): IntentRow => ({
  action: 'resume',
  capability: CYCLE_CAPABILITY,
  epoch: 1,
  id: 'intent-1',
  recordedAt: new Date('2026-10-09T11:00:00.000Z'),
  ...overrides,
});

function job(overrides: Partial<CycleJobInput> & { intents?: readonly IntentRow[] } = {}): {
  input: CycleJobInput;
  store: FakeCycleStore;
  slept: number[];
} {
  const store = overrides.store ?? new FakeCycleStore(overrides.intents ?? [intent()]);
  const slept: number[] = [];
  const input: CycleJobInput = {
    controlEpoch: 1,
    mode: 'dry',
    now: () => NOW,
    runId: 'execution-1',
    sleep: async (ms) => {
      slept.push(ms);
    },
    store,
    ticks: 2,
    ...overrides,
  };
  return { input, slept, store: store as FakeCycleStore };
}

describe('the intent rule (ADR-0013 §3)', () => {
  it('orders rows by (epoch, recorded_at, id) and takes the latest', () => {
    const older = intent({ epoch: 1, id: 'a', recordedAt: new Date('2026-10-09T10:00:00.000Z') });
    const newer = intent({ epoch: 1, id: 'b', recordedAt: new Date('2026-10-09T11:00:00.000Z') });
    const nextEpoch = intent({
      epoch: 2,
      id: 'a',
      recordedAt: new Date('2026-10-09T09:00:00.000Z'),
    });
    expect(compareIntents(newer, older)).toBeGreaterThan(0);
    // Epoch outranks time: a row from a later epoch is later, whenever it was recorded.
    expect(compareIntents(nextEpoch, newer)).toBeGreaterThan(0);
    // The id is the last tiebreak, so the ordering is total.
    expect(compareIntents(intent({ id: 'b' }), intent({ id: 'a' }))).toBeGreaterThan(0);
    expect(latestIntent([older, newer, nextEpoch], CYCLE_CAPABILITY)).toBe(nextEpoch);
    expect(latestIntent([], CYCLE_CAPABILITY)).toBeUndefined();
  });

  it('reads only its own capability, whatever the store handed it', () => {
    const other = intent({ capability: 'budget:live', id: 'live-1', action: 'resume' });
    expect(latestIntent([other], CYCLE_CAPABILITY)).toBeUndefined();
    expect(
      evaluateIntent([other], { capability: CYCLE_CAPABILITY, epoch: 1, now: NOW }),
    ).toMatchObject({ reason: 'intent-missing', run: false });
  });

  it('runs on resume and on configure, and pauses on everything else', () => {
    const grid: readonly [ControlAction, boolean][] = [
      ['resume', true],
      ['configure', true],
      ['pause', false],
      ['reset', false],
      // Fail closed: an action this job was never taught about leaves it paused.
      ['provider-enable', false],
    ];
    for (const [action, shouldRun] of grid) {
      const decision = evaluateIntent([intent({ action })], {
        capability: CYCLE_CAPABILITY,
        epoch: 1,
        now: NOW,
      });
      expect(decision.run, action).toBe(shouldRun);
      if (!decision.run) expect(decision.reason, action).toBe('intent-paused');
    }
  });

  it('refuses a row from another epoch, and one recorded too far ahead', () => {
    expect(
      evaluateIntent([intent({ epoch: 2 })], { capability: CYCLE_CAPABILITY, epoch: 1, now: NOW }),
    ).toMatchObject({ reason: 'intent-stale-epoch', run: false });
    // An epoch *behind* the configured one is just as stale as one ahead.
    expect(
      evaluateIntent([intent({ epoch: 1 })], { capability: CYCLE_CAPABILITY, epoch: 3, now: NOW }),
    ).toMatchObject({ reason: 'intent-stale-epoch', run: false });

    const justInside = new Date(NOW.getTime() + MAX_INTENT_CLOCK_SKEW_MS);
    const justOutside = new Date(NOW.getTime() + MAX_INTENT_CLOCK_SKEW_MS + 1);
    expect(
      evaluateIntent([intent({ recordedAt: justInside })], {
        capability: CYCLE_CAPABILITY,
        epoch: 1,
        now: NOW,
      }).run,
    ).toBe(true);
    expect(
      evaluateIntent([intent({ recordedAt: justOutside })], {
        capability: CYCLE_CAPABILITY,
        epoch: 1,
        now: NOW,
      }),
    ).toMatchObject({ reason: 'intent-future', run: false });
  });

  it('checks the epoch before the clock, so a stale row is stale whatever its time', () => {
    const decision = evaluateIntent(
      [intent({ epoch: 9, recordedAt: new Date(NOW.getTime() + 3_600_000) })],
      { capability: CYCLE_CAPABILITY, epoch: 1, now: NOW },
    );
    expect(decision).toMatchObject({ reason: 'intent-stale-epoch', run: false });
  });

  it('names the row it evaluated, and nothing when there was none', () => {
    const paused = evaluateIntent([intent({ action: 'pause', id: 'intent-7' })], {
      capability: CYCLE_CAPABILITY,
      epoch: 1,
      now: NOW,
    });
    expect(paused.run).toBe(false);
    expect(paused.intent?.id).toBe('intent-7');
    expect(
      evaluateIntent([], { capability: CYCLE_CAPABILITY, epoch: 1, now: NOW }).intent,
    ).toBeUndefined();
  });
});

describe('the lease window', () => {
  it('is every tick plus grace, and is derived rather than configured', () => {
    expect(leaseWindowMs(DEFAULT_TICKS)).toBe(DEFAULT_TICKS * TICK_INTERVAL_MS + LEASE_GRACE_MS);
    expect(leaseExpiry(NOW, 4).getTime()).toBe(NOW.getTime() + leaseWindowMs(4));
    // A nonsensical tick budget still takes a bounded lease rather than none.
    expect(leaseWindowMs(0)).toBe(TICK_INTERVAL_MS + LEASE_GRACE_MS);
    expect(leaseIsLive(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(leaseIsLive(NOW, NOW)).toBe(false);
  });
});

describe('the cycle job, stage 1', () => {
  it('runs dry on a resume: ticks at the v1 cadence and records one applied outcome', async () => {
    const { input, store, slept } = job({ ticks: 3 });
    const result = await runCycleJob(input);

    expect(result).toMatchObject({
      capability: CYCLE_CAPABILITY,
      intentId: 'intent-1',
      mode: 'dry',
      outcome: 'applied',
      reason: 'dry-run',
      ticksCompleted: 3,
    });
    expect(result.fencingToken).toBe(1);
    // Three heartbeats, and two 15-second gaps: the spacing is between ticks, so a
    // run does not sleep after its last one and outlive its scheduled minute.
    expect(store.heartbeats).toHaveLength(3);
    expect(slept).toEqual([TICK_INTERVAL_MS, TICK_INTERVAL_MS]);

    // Exactly one outcome row, against the intent that was evaluated.
    expect(store.outcomes).toEqual([
      {
        appliedAt: NOW,
        appliedRunId: 'execution-1',
        intentId: 'intent-1',
        outcome: 'applied',
        reason: 'dry-run',
      },
    ]);
    // The job-health row carries the job's own key, not the paper budget's.
    expect(store.jobRuns.get(CYCLE_JOB_RUN_CAPABILITY)).toEqual({
      capability: 'engine-cycle',
      lastOutcome: 'applied',
      lastRunAt: NOW,
      lastRunId: 'execution-1',
    });
    expect(store.jobRuns.has(CYCLE_CAPABILITY)).toBe(false);

    // The record is closed with what the run did, and the lease is handed back.
    expect(store.runRecords.get('execution-1')).toMatchObject({
      finishedAt: NOW,
      mode: 'dry',
      outcome: 'applied',
      reason: 'dry-run',
      ticks: 3,
    });
    expect(leaseIsLive(store.leases.get(CYCLE_CAPABILITY)!.expiresAt, NOW)).toBe(false);
  });

  it('runs paused when there is no intent at all, and references no intent row', async () => {
    const { input, store } = job({ intents: [] });
    const result = await runCycleJob(input);

    expect(result).toMatchObject({ outcome: 'refused', reason: 'intent-missing' });
    expect(result.intentId).toBeNull();
    // No intent id exists, and `control_outcome.intent_id` is a foreign key, so
    // the refusal is recorded on the job-health row and in the run record.
    expect(store.outcomes).toEqual([]);
    expect(store.jobRuns.get(CYCLE_JOB_RUN_CAPABILITY)?.lastOutcome).toBe('refused');
    expect(store.runRecords.get('execution-1')).toMatchObject({
      reason: 'intent-missing',
      ticks: 0,
    });
  });

  for (const [name, rows, reason] of [
    ['an epoch that is not the configured one', [intent({ epoch: 2 })], 'intent-stale-epoch'],
    [
      'a row recorded too far in the future',
      [intent({ recordedAt: new Date(NOW.getTime() + MAX_INTENT_CLOCK_SKEW_MS + 1_000) })],
      'intent-future',
    ],
    ['a pause as the latest row', [intent({ action: 'pause' })], 'intent-paused'],
    [
      'a reset after a resume',
      [
        intent({ action: 'resume', id: 'a', recordedAt: new Date('2026-10-09T10:00:00.000Z') }),
        intent({ action: 'reset', id: 'b', recordedAt: new Date('2026-10-09T11:00:00.000Z') }),
      ],
      'intent-paused',
    ],
  ] as const) {
    it(`runs paused on ${name}, recording one outcome against that row`, async () => {
      const { input, store } = job({ intents: rows });
      const result = await runCycleJob(input);

      expect(result).toMatchObject({ outcome: 'refused', reason, ticksCompleted: 0 });
      expect(store.heartbeats).toEqual([]);
      expect(store.outcomes).toHaveLength(1);
      expect(store.outcomes[0]).toMatchObject({ outcome: 'refused', reason });
      // The outcome names the row the job actually evaluated: the latest one.
      expect(store.outcomes[0]?.intentId).toBe(result.intentId);
      expect(store.jobRuns.get(CYCLE_JOB_RUN_CAPABILITY)?.lastOutcome).toBe('refused');
    });
  }

  for (const mode of ['forecast', 'paper'] as const) {
    it(`accepts --mode ${mode} and refuses it at run start`, async () => {
      const { input, store, slept } = job({ mode });
      const result = await runCycleJob(input);

      expect(result).toMatchObject({
        mode,
        outcome: 'refused',
        reason: 'mode-not-implemented',
        ticksCompleted: 0,
      });
      // Nothing ran: no tick body exists for the lane yet, so a premature
      // `cycle.tfvars` change cannot execute one.
      expect(store.heartbeats).toEqual([]);
      expect(slept).toEqual([]);
      expect(store.outcomes[0]).toMatchObject({ reason: 'mode-not-implemented' });
      expect(store.runRecords.get('execution-1')?.mode).toBe(mode);
    });
  }

  describe('the paper lane, wired and fail-closed (2026-10-19)', () => {
    // A reader that answers from a script and records exactly what it was asked. The
    // evidence this job reads is one field, so the rest of the (large) evidence shape is
    // not fabricated here: only `decisionUnderProductionBundle` is supplied, which is all
    // `runCycleJob` touches.
    const asked: { fence: PaperAuthorityFence; scope: PaperAuthorityScope }[] = [];
    const reader = (result: PaperAuthorityReadResult | (() => never)): PaperAuthorityReader => ({
      readAuthority: async (scope, fence) => {
        asked.push({ fence, scope });
        if (typeof result === 'function') return result();
        return result;
      },
    });
    const decided = (decision: PaperAuthorityDecision): PaperAuthorityReadResult => ({
      evidence: {
        decisionUnderProductionBundle: decision,
      } as unknown as PaperAuthorityEvidence,
      kind: 'read',
    });
    const paperJob = (authority: PaperAuthorityReader, intents?: readonly IntentRow[]) =>
      job({
        intents: intents ?? [intent({ action: 'resume' })],
        mode: 'paper',
        paper: { authority },
      });

    it('records the production bundle refusal instead of a mode problem', async () => {
      asked.length = 0;
      const { input, store, slept } = paperJob(
        reader(decided({ allowed: false, reason: 'bundle-unavailable' })),
      );
      const result = await runCycleJob(input);

      expect(result).toMatchObject({
        mode: 'paper',
        outcome: 'refused',
        reason: 'paper-bundle-unavailable',
        ticksCompleted: 0,
      });
      // It asked under THIS run's own fence, for the capability and epoch it is
      // governed by — never a token or owner from a caller.
      const lease = store.leases.get(CYCLE_CAPABILITY);
      expect(asked).toHaveLength(1);
      expect(asked[0]?.scope).toEqual({ capability: CYCLE_CAPABILITY, epoch: 1 });
      expect(asked[0]?.fence).toEqual({
        capability: CYCLE_CAPABILITY,
        fencingToken: BigInt(lease?.fencingToken ?? -1),
        owner: lease?.owner,
      });
      // Control-plane bookkeeping happened exactly once; nothing paper-side ran.
      expect(store.outcomes).toHaveLength(1);
      expect(store.outcomes[0]).toMatchObject({
        outcome: 'refused',
        reason: 'paper-bundle-unavailable',
      });
      expect(store.jobRuns.get(CYCLE_JOB_RUN_CAPABILITY)).toMatchObject({ lastOutcome: 'refused' });
      expect(store.runRecords.get('execution-1')).toMatchObject({
        outcome: 'refused',
        reason: 'paper-bundle-unavailable',
      });
      // No tick, no heartbeat, no sleep, and the lease handed back.
      expect(store.heartbeats).toEqual([]);
      expect(slept).toEqual([]);
      expect(leaseIsLive(store.leases.get(CYCLE_CAPABILITY)?.expiresAt ?? NOW, NOW)).toBe(false);
    });

    it('separates a refused READ from a refused decision', async () => {
      asked.length = 0;
      const { input, store } = paperJob(
        reader({ detail: 'start-boundary', kind: 'refused', reason: 'lease-lost' }),
      );
      expect(await runCycleJob(input)).toMatchObject({
        outcome: 'refused',
        reason: 'paper-authority-unreadable',
      });
      expect(store.outcomes[0]).toMatchObject({ reason: 'paper-authority-unreadable' });
    });

    it('records any other authority refusal without re-coding its reason', async () => {
      asked.length = 0;
      const { input, store } = paperJob(
        reader(decided({ allowed: false, reason: 'resume-reference-invalid' })),
      );
      expect(await runCycleJob(input)).toMatchObject({
        outcome: 'refused',
        reason: 'paper-authority-refused',
      });
      expect(store.outcomes[0]).toMatchObject({ reason: 'paper-authority-refused' });
    });

    it('still refuses when admission is GRANTED, because no producer exists', async () => {
      // Unreachable while `COMPILED_PAPER_BUNDLE_AVAILABLE` is false — the adapter
      // computes that decision with the build's own constant — and asserted anyway, so an
      // allowed decision can never be mistaken for a performed run.
      asked.length = 0;
      const { input, store, slept } = paperJob(
        reader(
          decided({
            allowed: true,
            config: {} as unknown as PaperAuthorityDecision & { allowed: true },
            configIntentId: 'configure-1',
            latestIntentId: 'resume-1',
          } as unknown as PaperAuthorityDecision),
        ),
      );
      const result = await runCycleJob(input);

      expect(result).toMatchObject({
        outcome: 'refused',
        reason: 'paper-admission-unimplemented',
        ticksCompleted: 0,
      });
      expect(store.outcomes[0]).toMatchObject({ outcome: 'refused' });
      expect(store.heartbeats).toEqual([]);
      expect(slept).toEqual([]);
    });

    it('asks nothing at all when the control row is paused', async () => {
      // Order preserved: intent is still evaluated first, and a paused engine reports
      // `intent-paused` without any authority read happening.
      asked.length = 0;
      const { input } = paperJob(
        reader(decided({ allowed: false, reason: 'bundle-unavailable' })),
        [intent({ action: 'pause' })],
      );
      expect(await runCycleJob(input)).toMatchObject({ reason: 'intent-paused' });
      expect(asked).toEqual([]);
    });

    it('does not turn a driver failure into a refusal', async () => {
      asked.length = 0;
      const { input, store } = paperJob(
        reader(() => {
          throw new Error('connection terminated');
        }),
      );
      await expect(runCycleJob(input)).rejects.toThrow('connection terminated');
      // Nothing was recorded as an outcome: the run record stays open and the lease
      // expires on its own, which is the same self-healing path every other unexpected
      // failure in this job takes.
      expect(store.outcomes).toEqual([]);
      expect(store.runRecords.get('execution-1')).toMatchObject({ reason: 'run-incomplete' });
    });

    it('answers exactly as before when no reader is wired', async () => {
      const { input, store } = job({ intents: [intent({ action: 'resume' })], mode: 'paper' });
      expect(await runCycleJob(input)).toMatchObject({ reason: 'mode-not-implemented' });
      expect(store.outcomes[0]).toMatchObject({ reason: 'mode-not-implemented' });
    });
  });

  it('reports paused rather than a mode problem when both are true', async () => {
    // Paused is the stronger statement about an engine, and the mode gate still
    // sits before every tick.
    const { input } = job({ intents: [intent({ action: 'pause' })], mode: 'paper' });
    expect(await runCycleJob(input)).toMatchObject({ reason: 'intent-paused' });
  });

  it('refuses a run id that already has a record, and writes nothing further', async () => {
    const { input, store } = job();
    expect((await runCycleJob(input)).outcome).toBe('applied');
    const outcomesAfterFirst = store.outcomes.length;
    const recordAfterFirst = { ...store.runRecords.get('execution-1')! };

    // The platform's own retry of the same execution.
    const retry = await runCycleJob(input);
    expect(retry).toMatchObject({
      outcome: 'refused',
      reason: 'run-already-recorded',
      ticksCompleted: 0,
    });
    expect(retry.intentId).toBeNull();
    expect(store.outcomes).toHaveLength(outcomesAfterFirst);
    expect(store.runRecords.get('execution-1')).toEqual(recordAfterFirst);
    expect(store.runRecords.size).toBe(1);
    // The job-health row still describes the run that actually ran.
    expect(store.jobRuns.get(CYCLE_JOB_RUN_CAPABILITY)?.lastOutcome).toBe('applied');
  });

  it('refuses while another owner holds a live lease, and writes nothing at all', async () => {
    const store = new FakeCycleStore([intent()]);
    const held: FakeLease = {
      acquiredAt: new Date(NOW.getTime() - 10_000),
      capability: CYCLE_CAPABILITY,
      expiresAt: new Date(NOW.getTime() + 60_000),
      fencingToken: 7,
      heartbeatAt: new Date(NOW.getTime() - 10_000),
      owner: 'execution-other',
    };
    store.seedLease(held);
    const { input } = job({ store });

    const result = await runCycleJob(input);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'lease-held', ticksCompleted: 0 });
    // Every write is fenced by a token this run does not hold, so there is
    // nothing it may legitimately say in the store.
    expect(result.fencingToken).toBeNull();
    expect(store.runRecords.size).toBe(0);
    expect(store.outcomes).toEqual([]);
    expect(store.jobRuns.size).toBe(0);
    // The holder's lease is untouched.
    expect(store.leases.get(CYCLE_CAPABILITY)).toEqual(held);
  });

  it('takes over an expired lease and increments the fencing token', async () => {
    const store = new FakeCycleStore([intent()]);
    store.seedLease({
      acquiredAt: new Date(NOW.getTime() - 600_000),
      capability: CYCLE_CAPABILITY,
      expiresAt: new Date(NOW.getTime() - 1),
      fencingToken: 7,
      heartbeatAt: new Date(NOW.getTime() - 600_000),
      owner: 'execution-crashed',
    });
    const { input } = job({ store });

    const result = await runCycleJob(input);
    expect(result).toMatchObject({ outcome: 'applied', reason: 'dry-run' });
    // Monotonic across a takeover, which is what makes the crashed run's writes
    // refusable rather than merely unlikely.
    expect(result.fencingToken).toBe(8);
    expect(store.leases.get(CYCLE_CAPABILITY)?.owner).toBe('execution-1');
  });

  it('refuses a write made under a token the lease no longer carries', async () => {
    const store = new FakeCycleStore([intent()]);
    const first = await store.acquireLease({
      capability: CYCLE_CAPABILITY,
      expiresAt: new Date(NOW.getTime() - 1),
      now: NOW,
      owner: 'execution-crashed',
    });
    expect(first.acquired).toBe(true);
    const stale = first.acquired ? first.grant : undefined;

    // A second run takes over, because the first lease has expired.
    const second = await store.acquireLease({
      capability: CYCLE_CAPABILITY,
      expiresAt: leaseExpiry(NOW, 2),
      now: NOW,
      owner: 'execution-2',
    });
    expect(second.acquired).toBe(true);

    // The first run wakes up and tries to finish writing.
    await expect(store.heartbeat(stale!, NOW, leaseExpiry(NOW, 1))).rejects.toThrow(
      FencingTokenRejectedError,
    );
    await expect(
      store.appendOutcome(stale!, {
        appliedAt: NOW,
        appliedRunId: 'execution-crashed',
        intentId: 'intent-1',
        outcome: 'applied',
        reason: 'dry-run',
      }),
    ).rejects.toThrow(FencingTokenRejectedError);
    await expect(
      store.upsertJobRun(stale!, {
        at: NOW,
        capability: CYCLE_JOB_RUN_CAPABILITY,
        outcome: 'applied',
        runId: 'execution-crashed',
      }),
    ).rejects.toThrow(FencingTokenRejectedError);
    await expect(store.releaseLease(stale!, NOW)).rejects.toThrow(FencingTokenRejectedError);
    expect(store.outcomes).toEqual([]);
    expect(store.jobRuns.size).toBe(0);
  });

  it('never releases a lease to an instant before it was acquired', async () => {
    // Parity with the real adapter, whose SQL clamps `expires_at` and `heartbeat_at` up
    // to `acquired_at`: `acquired_at` comes from the DATABASE clock in microseconds while
    // a release carries a millisecond `Date`, so a run that acquires and releases inside
    // one millisecond offers an instant BEFORE its own acquisition and 0004's
    // `check (expires_at >= acquired_at)` rejected the update, leaving the lease held.
    const store = new FakeCycleStore([intent()]);
    const taken = await store.acquireLease({
      capability: CYCLE_CAPABILITY,
      expiresAt: leaseExpiry(NOW, 1),
      now: NOW,
      owner: 'execution-1',
    });
    expect(taken.acquired).toBe(true);
    if (!taken.acquired) return;
    const earlier = new Date(NOW.getTime() - 1);
    await store.releaseLease(taken.grant, earlier);
    const lease = store.leases.get(CYCLE_CAPABILITY)!;
    expect(lease.expiresAt.getTime()).toBe(NOW.getTime());
    expect(lease.heartbeatAt.getTime()).toBe(NOW.getTime());
    // Released, not extended: the clamped instant is the acquisition, already past.
    expect(leaseIsLive(lease.expiresAt, NOW)).toBe(false);
    // Distinct objects, so no later mutation of one field can move another.
    expect(lease.expiresAt).not.toBe(lease.acquiredAt);
    expect(lease.heartbeatAt).not.toBe(lease.expiresAt);
    // The capability is free: a different owner takes it with the next token.
    const next = await store.acquireLease({
      capability: CYCLE_CAPABILITY,
      expiresAt: leaseExpiry(NOW, 1),
      now: NOW,
      owner: 'execution-2',
    });
    expect(next.acquired).toBe(true);
    if (!next.acquired) return;
    expect(next.grant.fencingToken).toBe(taken.grant.fencingToken + 1);
    // A release that is genuinely later still records that later instant.
    const later = new Date(NOW.getTime() + 5000);
    await store.releaseLease(next.grant, later);
    expect(store.leases.get(CYCLE_CAPABILITY)!.expiresAt.getTime()).toBe(later.getTime());
  });

  it('refuses an outcome against an intent row that does not exist', async () => {
    // The real table has a foreign key to `engine.control_intent`; the double
    // models it, so a reason code invented for a row nobody recorded cannot pass.
    const store = new FakeCycleStore([intent()]);
    const taken = await store.acquireLease({
      capability: CYCLE_CAPABILITY,
      expiresAt: leaseExpiry(NOW, 1),
      now: NOW,
      owner: 'execution-1',
    });
    expect(taken.acquired).toBe(true);
    await expect(
      store.appendOutcome(taken.acquired ? taken.grant : ({} as never), {
        appliedAt: NOW,
        appliedRunId: 'execution-1',
        intentId: 'intent-nobody-recorded',
        outcome: 'applied',
        reason: 'dry-run',
      }),
    ).rejects.toThrow(/foreign key/u);
  });

  it('treats a tick budget below one as one tick, and never sleeps after the last', async () => {
    const { input, store, slept } = job({ ticks: 0 });
    expect((await runCycleJob(input)).ticksCompleted).toBe(1);
    expect(store.heartbeats).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});

describe('what stage 1 refuses to be', () => {
  const cycleRoot = join(import.meta.dirname, 'cycle');
  const domainRoot = join(import.meta.dirname, 'domain');

  const sources = (root: string): { path: string; source: string }[] => {
    const found: { path: string; source: string }[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith('.ts')) found.push({ path, source: readFileSync(path, 'utf8') });
      }
    };
    walk(root);
    return found;
  };

  it('imports no signed venue client, live wire module or reconciliation path', () => {
    // The seam stages 2 and 3 inherit. The cycle job is a paper engine: ADR-0013
    // §5 refuses "no live execution path, venue credential, or funded authority",
    // and the cheapest place to keep that true is a check that fails the moment a
    // port drags one in. A grep, deliberately: it bites on a name, so a renamed
    // live module cannot slip past a type.
    const forbidden = [
      /from\s+['"][^'"]*live-[^'"]*['"]/u,
      /from\s+['"][^'"]*kalshi-signing[^'"]*['"]/u,
      /from\s+['"][^'"]*reconciliation[^'"]*['"]/u,
      /from\s+['"][^'"]*venue-client[^'"]*['"]/u,
      /from\s+['"][^'"]*signed-[^'"]*['"]/u,
    ];
    for (const { path, source } of [...sources(cycleRoot), ...sources(domainRoot)]) {
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path} must not import ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('wires the paper lane with a READER only, and no way to activate it', () => {
    // The loader boundary for the 2026-10-19 wiring. The entrypoint may construct the
    // persisted authority READER; it must not construct a gate writer, must not reach
    // for the test artifact or its fixture, and must not introduce an environment
    // variable that could turn the refusal into an admission.
    const entrypoint = readFileSync(join(cycleRoot, 'main.ts'), 'utf8');
    expect(entrypoint).toContain('createPostgresPaperAuthorityStore');
    for (const forbidden of [
      'createPostgresPaperGateWriter',
      'dist-test-support',
      'paper-gate-audited-policy-fixture',
      'AUDITED_POLICY_ADMISSION',
    ])
      expect(entrypoint, `the entrypoint must not reference ${forbidden}`).not.toContain(forbidden);
    // It may NAME the availability constant in a comment — it does, to say why the lane is
    // fail-closed — but it must not import it, because importing it is the first step to
    // passing something else in its place.
    expect(entrypoint).not.toMatch(/from\s+['"][^'"]*paper-authority\.js['"]/u);
    // Exactly the environment variables it already read: a writer reference, the control
    // epoch and the Cloud Run execution name. No new one, and nothing paper-specific.
    expect(
      [...entrypoint.matchAll(/process\.env\[([A-Z_]+)\]/gu)].map((match) => match[1]),
    ).toEqual(['CONTROL_EPOCH_ENV', 'EXECUTION_ENV', 'WRITER_URL_ENV']);
    // And the application port offers no availability argument to override the build's.
    const application = readFileSync(join(cycleRoot, '..', 'application', 'cycle.ts'), 'utf8');
    expect(application).toContain('decisionUnderProductionBundle');
    for (const forbidden of ['auditedBundleAvailable', 'COMPILED_PAPER_BUNDLE_AVAILABLE'])
      expect(application, `cycle.ts must not take ${forbidden}`).not.toContain(forbidden + ':');
  });

  it('keeps the reason codes a closed set the migration and the runbook both name', () => {
    expect([...CYCLE_REASONS].sort()).toEqual([
      'dry-run',
      'forecast-run',
      'intent-future',
      'intent-missing',
      'intent-paused',
      'intent-stale-epoch',
      'lease-held',
      'mode-not-implemented',
      'paper-admission-unimplemented',
      'paper-authority-refused',
      'paper-authority-unreadable',
      'paper-bundle-unavailable',
      'run-already-recorded',
    ]);
    const migration = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'platform-api',
        'migrations',
        '0004-engine-cycle-lease-and-runs.sql',
      ),
      'utf8',
    );
    const forecastMigration = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'platform-api',
        'migrations',
        '0005-forecast-cycle-overlay.sql',
      ),
      'utf8',
    );
    // The paper lane's reasons are named by the port contract rather than by a
    // migration: `engine.control_outcome.reason` and `engine.job_run.last_outcome` carry
    // free text with no CHECK, the applied migrations are immutable, and the document a
    // human reads for this lane is the port contract. The invariant is unchanged — every
    // code is named in a durable document — and the document is asserted below.
    const portContract = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'docs',
        'operations',
        'paper-engine-port-contract.md',
      ),
      'utf8',
    );
    for (const reason of CYCLE_REASONS) {
      // Stage 2 adds its applied reason without rewriting the stage-1 migration.
      const owner = reason.startsWith('paper-')
        ? portContract
        : reason === 'forecast-run'
          ? forecastMigration
          : migration;
      expect(owner, `owning document must name the reason code ${reason}`).toContain(reason);
    }
    // `run-incomplete` is the open-record placeholder, not a run outcome, so it is
    // in the migration and deliberately not in the closed set above.
    expect(migration).toContain('run-incomplete');
    expect((CYCLE_REASONS as readonly string[]).includes('run-incomplete')).toBe(false);
  });

  it('accepts exactly the three modes, and only dry does anything', () => {
    expect(isCycleMode('dry')).toBe(true);
    expect(isCycleMode('forecast')).toBe(true);
    expect(isCycleMode('paper')).toBe(true);
    expect(isCycleMode('live')).toBe(false);
    expect(isCycleMode('toString')).toBe(false);
  });
});
