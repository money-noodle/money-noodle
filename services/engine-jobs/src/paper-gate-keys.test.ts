import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PAPER_GATE_GENERATION_KEY_DOMAIN,
  PAPER_GATE_GENERATION_KEY_PREFIX,
  PAPER_GATE_KEY_PATTERN,
  PAPER_GATE_MAX_FRAMED_REVISION,
  PAPER_GATE_PHASE_EVENT_KEY_DOMAIN,
  PAPER_GATE_PHASE_EVENT_KEY_PREFIX,
  paperGateGenerationKey,
  paperGateGenerationKeyFraming,
  paperGatePhaseEventKey,
  paperGatePhaseEventKeyFraming,
  paperGateRowScopeFromGenerationIdentity,
} from './domain/paper-gate-keys.js';
import { paperGateRowScopeIsValid } from './domain/paper-gate-row-codec.js';
import { paperGateWriteRequestIsValid } from './domain/paper-gate-write.js';
import {
  PAPER_HISTORICAL_REGIME_CONTRACT,
  PAPER_REGIME_SAMPLE_BUY_POLICY,
} from './domain/paper-regime.js';

/**
 * OUT-OF-BAND VECTORS. Every digest below was computed WITHOUT this code, by two
 * independent tools, from the framing this module documents:
 *
 *   line() { printf '%s:%s\n' "$(printf '%s' "$1" | wc -c | tr -d ' ')" "$1"; }
 *   gen() { line 'money-noodle.paper-gate.generation-key.v1'; line 'fund-7'; line '12'; \
 *           line 'actor-7:paper'; line 'intent-cfg-7'; \
 *           line 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22'; }
 *   gen | sha256sum
 *     -> 628c7aeddc35f446feddc70b7bc92f4fc14922d4507da05ec4f0ebf81724bd28
 *   gen | openssl dgst -sha256 -r
 *     -> 628c7aeddc35f446feddc70b7bc92f4fc14922d4507da05ec4f0ebf81724bd28
 *
 *   ev() { line 'money-noodle.paper-gate.phase-event-key.v1'; \
 *          line 'pgg1-628c7aeddc35f446feddc70b7bc92f4fc14922d4507da05ec4f0ebf81724bd28'; \
 *          line "$1"; line "$2"; line 'run-7'; }
 *   ev 'genesis' ''                     | sha256sum / openssl dgst -sha256
 *     -> 891a05431a0cf84ec92fda2afb725d32746bb1d7e8371d7589a51f1dd32547b0
 *   ev 'evaluated' '9007199254740990'   | sha256sum / openssl dgst -sha256
 *     -> 6d684f1fa56ce2e4754a39cfa66f634fda34f717b7519dbace9c278140e16b30
 *
 * A change to the framing, the field order, the domain literals or the prefixes breaks
 * these vectors, which is the point: they pin the derivation, not the implementation.
 */
const VECTOR_IDENTITY = {
  budget_id: 'actor-7:paper',
  epoch: 12,
  funding_id: 'fund-7',
  generation_config_intent_id: 'intent-cfg-7',
  sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
} as const;
const VECTOR_GENERATION_FRAMING =
  '41:money-noodle.paper-gate.generation-key.v1\n' +
  '6:fund-7\n' +
  '2:12\n' +
  '13:actor-7:paper\n' +
  '12:intent-cfg-7\n' +
  '80:buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22\n';
const VECTOR_GENERATION_KEY =
  'pgg1-628c7aeddc35f446feddc70b7bc92f4fc14922d4507da05ec4f0ebf81724bd28';
const VECTOR_GENESIS_KEY = 'pge1-891a05431a0cf84ec92fda2afb725d32746bb1d7e8371d7589a51f1dd32547b0';
const VECTOR_EVALUATED_KEY =
  'pge1-6d684f1fa56ce2e4754a39cfa66f634fda34f717b7519dbace9c278140e16b30';

const identity = (patch: Record<string, unknown>): unknown => ({ ...VECTOR_IDENTITY, ...patch });
/** A shape with one field genuinely absent, not present-and-undefined. */
const omit = (value: Record<string, unknown>, field: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[field];
  return copy;
};
const genesis = (patch: Record<string, unknown> = {}): unknown => ({
  generationKey: VECTOR_GENERATION_KEY,
  kind: 'genesis',
  runId: 'run-7',
  ...patch,
});
const evaluated = (patch: Record<string, unknown> = {}): unknown => ({
  generationKey: VECTOR_GENERATION_KEY,
  kind: 'evaluated',
  revisionBefore: PAPER_GATE_MAX_FRAMED_REVISION,
  runId: 'run-7',
  ...patch,
});
const key = (identityValue: unknown): string => {
  const derived = paperGateGenerationKey(identityValue);
  expect(derived).toMatch(PAPER_GATE_KEY_PATTERN);
  return derived!;
};
const eventKey = (identityValue: unknown): string => {
  const derived = paperGatePhaseEventKey(identityValue);
  expect(derived).toMatch(PAPER_GATE_KEY_PATTERN);
  return derived!;
};

describe('deterministic paper gate key derivation', () => {
  it('reproduces digests computed out of band by sha256sum and openssl', () => {
    expect(paperGateGenerationKeyFraming(VECTOR_IDENTITY)).toBe(VECTOR_GENERATION_FRAMING);
    expect(paperGateGenerationKey(VECTOR_IDENTITY)).toBe(VECTOR_GENERATION_KEY);
    expect(paperGatePhaseEventKeyFraming(genesis())).toBe(
      `42:${PAPER_GATE_PHASE_EVENT_KEY_DOMAIN}\n69:${VECTOR_GENERATION_KEY}\n7:genesis\n0:\n5:run-7\n`,
    );
    expect(paperGatePhaseEventKey(genesis())).toBe(VECTOR_GENESIS_KEY);
    expect(paperGatePhaseEventKeyFraming(evaluated())).toBe(
      `42:${PAPER_GATE_PHASE_EVENT_KEY_DOMAIN}\n69:${VECTOR_GENERATION_KEY}\n` +
        `9:evaluated\n16:9007199254740990\n5:run-7\n`,
    );
    expect(paperGatePhaseEventKey(evaluated())).toBe(VECTOR_EVALUATED_KEY);
    // The framing is self-delimiting: the domain line declares its own byte length too.
    expect(VECTOR_GENERATION_FRAMING.startsWith(`41:${PAPER_GATE_GENERATION_KEY_DOMAIN}\n`)).toBe(
      true,
    );
    expect(PAPER_GATE_GENERATION_KEY_DOMAIN).toBe('money-noodle.paper-gate.generation-key.v1');
    expect(PAPER_GATE_PHASE_EVENT_KEY_DOMAIN).toBe('money-noodle.paper-gate.phase-event-key.v1');
  });

  it('is pure and stable: the same identity derives the same key every time', () => {
    const derived = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      derived.add(key(identity({})));
      derived.add(eventKey(genesis()));
      derived.add(eventKey(evaluated()));
    }
    expect([...derived].sort()).toEqual(
      [VECTOR_GENERATION_KEY, VECTOR_GENESIS_KEY, VECTOR_EVALUATED_KEY].sort(),
    );
    // Key order in the identity object is not part of the identity.
    expect(
      key({
        sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
        generation_config_intent_id: 'intent-cfg-7',
        budget_id: 'actor-7:paper',
        epoch: 12,
        funding_id: 'fund-7',
      }),
    ).toBe(VECTOR_GENERATION_KEY);
  });

  it('changes when any component of the identity changes', () => {
    const generations = [
      key(identity({})),
      key(identity({ funding_id: 'fund-8' })),
      key(identity({ epoch: 13 })),
      key(identity({ budget_id: 'actor-8:paper' })),
      key(identity({ generation_config_intent_id: 'intent-cfg-8' })),
    ];
    expect(new Set(generations).size).toBe(5);
    const events = [
      eventKey(genesis()),
      eventKey(genesis({ generationKey: generations[1] })),
      eventKey(genesis({ runId: 'run-8' })),
      eventKey(evaluated()),
      eventKey(evaluated({ revisionBefore: 0n })),
      eventKey(evaluated({ revisionBefore: PAPER_GATE_MAX_FRAMED_REVISION - 1n })),
      eventKey(evaluated({ runId: 'run-8' })),
      eventKey(evaluated({ generationKey: generations[1] })),
    ];
    expect(new Set(events).size).toBe(8);
    // Cross-space: a generation key and an event key can never collide, and the two
    // prefixes make the space visible before the digest is read.
    expect(new Set([...generations, ...events]).size).toBe(13);
    for (const generation of generations)
      expect(generation.startsWith(PAPER_GATE_GENERATION_KEY_PREFIX)).toBe(true);
    for (const event of events)
      expect(event.startsWith(PAPER_GATE_PHASE_EVENT_KEY_PREFIX)).toBe(true);
  });

  it('frames components unambiguously, so no two component lists collide', () => {
    const ambiguous = [
      // 'ab' + 'c' versus 'a' + 'bc' across adjacent framed components.
      identity({ budget_id: 'ab', generation_config_intent_id: 'c' }),
      identity({ budget_id: 'a', generation_config_intent_id: 'bc' }),
      // A component carrying the framing's own delimiters.
      identity({ budget_id: 'a', generation_config_intent_id: 'b:c' }),
      identity({ budget_id: 'a:b', generation_config_intent_id: 'c' }),
      identity({ budget_id: 'a', generation_config_intent_id: 'b|c' }),
      identity({ budget_id: 'a', generation_config_intent_id: 'b/c' }),
      identity({ budget_id: 'a', generation_config_intent_id: 'b\nc' }),
      identity({ budget_id: 'a', generation_config_intent_id: 'b"c' }),
      identity({ budget_id: 'a', generation_config_intent_id: 'b\\c' }),
      // A component spelled to look like its own length prefix.
      identity({ budget_id: 'a', generation_config_intent_id: '1:b' }),
      identity({ budget_id: 'a', generation_config_intent_id: '3:bcd' }),
      identity({ budget_id: '1:a', generation_config_intent_id: 'b' }),
      // Same bytes, different split against the epoch that sits between them.
      identity({ funding_id: 'f1', epoch: 2 }),
      identity({ funding_id: 'f', epoch: 12 }),
      // NFC and NFD are different values in the column, so different keys.
      identity({ funding_id: 'café' }),
      identity({ funding_id: 'café' }),
    ];
    const keys = ambiguous.map(key);
    expect(new Set(keys).size).toBe(ambiguous.length);
    // The length prefix counts UTF-8 BYTES, which is what makes the two Unicode
    // spellings and every astral component frame by weight rather than by unit count.
    expect(paperGateGenerationKeyFraming(identity({ funding_id: 'café' }))).toContain('5:café\n');
    expect(paperGateGenerationKeyFraming(identity({ funding_id: 'café' }))).toContain('6:café\n');
    const astral = '\u{1d11e}'.repeat(60);
    expect(astral.length).toBe(120);
    expect(paperGateGenerationKeyFraming(identity({ funding_id: astral }))).toContain(
      `240:${astral}\n`,
    );
    expect(key(identity({ funding_id: astral }))).toMatch(PAPER_GATE_KEY_PATTERN);
    // Event components frame the same way, including an empty revision at genesis.
    expect(
      new Set([
        eventKey(genesis({ runId: 'a:b' })),
        eventKey(genesis({ runId: 'a' })),
        eventKey(evaluated({ revisionBefore: 0n, runId: 'a' })),
        eventKey(evaluated({ revisionBefore: 0n, runId: '0:a' })),
      ]).size,
    ).toBe(4);
  });

  it('accepts exactly the 0006 bounds and refuses everything outside them', () => {
    const at120 = 'f'.repeat(120);
    expect(key(identity({ funding_id: at120 }))).toMatch(PAPER_GATE_KEY_PATTERN);
    expect(paperGateGenerationKey(identity({ funding_id: 'f'.repeat(121) }))).toBeUndefined();
    expect(eventKey(genesis({ runId: at120 }))).toMatch(PAPER_GATE_KEY_PATTERN);
    expect(paperGatePhaseEventKey(genesis({ runId: 'r'.repeat(121) }))).toBeUndefined();
    expect(paperGatePhaseEventKey(genesis({ generationKey: 'g'.repeat(121) }))).toBeUndefined();
    // Every derived key is itself a legal value for the column it names.
    for (const derived of [VECTOR_GENERATION_KEY, VECTOR_GENESIS_KEY, VECTOR_EVALUATED_KEY]) {
      expect(derived).toHaveLength(69);
      expect(derived.trim()).toBe(derived);
      expect(derived).toMatch(/^[a-z0-9-]+$/);
      expect(derived.length).toBeLessThanOrEqual(120);
    }
  });

  it('refuses a malformed identity with undefined, never a throw and never a repair', () => {
    for (const bad of [
      undefined,
      null,
      'text',
      42,
      0n,
      [],
      [VECTOR_IDENTITY],
      () => VECTOR_IDENTITY,
      {},
      // Missing, extra and renamed fields.
      { ...VECTOR_IDENTITY, generation_key: VECTOR_GENERATION_KEY },
      { ...VECTOR_IDENTITY, extra: 'x' },
      omit(VECTOR_IDENTITY, 'epoch'),
      identity({ funding_id: '' }),
      // Untrimmed values are refused, NOT trimmed: a trimmed key would silently name a
      // different row than the caller asked for.
      identity({ funding_id: ' fund-7' }),
      identity({ funding_id: 'fund-7 ' }),
      identity({ funding_id: '\tfund-7' }),
      identity({ funding_id: 'fund-7\n' }),
      identity({ budget_id: 7 }),
      identity({ generation_config_intent_id: null }),
      // The epoch is 0006's `integer` domain, checked as a safe integer.
      identity({ epoch: 0 }),
      identity({ epoch: -1 }),
      identity({ epoch: 2147483648 }),
      identity({ epoch: 1.5 }),
      identity({ epoch: '7' }),
      identity({ epoch: Number.NaN }),
      identity({ epoch: 12n }),
      // The sample policy is one literal, twice: a column CHECK and the scope type.
      identity({ sample_policy: 'buy-anything-v1' }),
      identity({ sample_policy: `${PAPER_REGIME_SAMPLE_BUY_POLICY} ` }),
      identity({ sample_policy: undefined }),
    ]) {
      expect(paperGateGenerationKeyFraming(bad)).toBeUndefined();
      expect(paperGateGenerationKey(bad)).toBeUndefined();
      expect(paperGateRowScopeFromGenerationIdentity(bad)).toBeUndefined();
    }
    for (const bad of [
      undefined,
      null,
      'text',
      42,
      [],
      {},
      genesis({ kind: 'initialize' }),
      genesis({ kind: 'Genesis' }),
      genesis({ kind: undefined }),
      // A revision belongs to an advance and only to an advance.
      genesis({ revisionBefore: 0n }),
      omit(evaluated() as Record<string, unknown>, 'revisionBefore'),
      evaluated({ revisionBefore: 0 }),
      evaluated({ revisionBefore: '0' }),
      evaluated({ revisionBefore: -1n }),
      evaluated({ revisionBefore: PAPER_GATE_MAX_FRAMED_REVISION + 1n }),
      evaluated({ revisionBefore: undefined }),
      evaluated({ extra: 'x' }),
      genesis({ generationKey: '' }),
      genesis({ generationKey: ' ' + VECTOR_GENERATION_KEY }),
      genesis({ generationKey: 7 }),
      genesis({ runId: null }),
      genesis({ runId: '' }),
    ]) {
      expect(paperGatePhaseEventKeyFraming(bad)).toBeUndefined();
      expect(paperGatePhaseEventKey(bad)).toBeUndefined();
    }
  });

  it('derives values the writer itself accepts, scope and request alike', () => {
    const scope = paperGateRowScopeFromGenerationIdentity(VECTOR_IDENTITY);
    expect(scope).toEqual({ ...VECTOR_IDENTITY, generation_key: VECTOR_GENERATION_KEY });
    expect(paperGateRowScopeIsValid(scope)).toBe(true);
    const fence = { capability: 'engine-cycle', fencingToken: 1n, owner: 'owner-1' };
    const common = {
      coverageCutoffAtIso: '2026-10-21T23:00:00.000Z',
      coverageReceiptId: 'coverage-receipt-7',
      evidenceObservedAtIso: '2026-10-21T23:00:00.000Z',
      runId: 'run-7',
      scope: scope!,
    };
    expect(
      paperGateWriteRequestIsValid(
        {
          ...common,
          eventKey: VECTOR_GENESIS_KEY,
          generation: {
            bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
            enabled: true,
            evidenceHalfLifeWindows: '2.5',
            minimumPolicyWindows: 12,
            pauseConfidence: '0.99',
            profileClaim: 'synthetic-profile-claim',
            resumeConfidence: '0.75',
          },
          kind: 'initialize',
        },
        fence,
      ),
    ).toBeUndefined();
    expect(
      paperGateWriteRequestIsValid(
        { ...common, eventKey: VECTOR_EVALUATED_KEY, expectedRevision: 0n, kind: 'evaluate' },
        fence,
      ),
    ).toBeUndefined();
    // Two runs intending the same advance derive DIFFERENT event keys, so the second one
    // misses the replay lookup and is answered by the writer's compare-and-set on the head
    // (`stale-revision`, detail `head-at-<n>`) rather than by `replay-mismatch` on
    // `run_id`. The duplicate is refused by the revision line, where 0006 puts
    // `unique (generation_key, revision_after)`; the key never pretends to own that.
    const advance = { generationKey: VECTOR_GENERATION_KEY, kind: 'evaluated', revisionBefore: 4n };
    expect(eventKey({ ...advance, runId: 'run-7' })).not.toBe(
      eventKey({ ...advance, runId: 'run-8' }),
    );
    // A retry by the SAME run re-derives the same key, which is what makes a replay
    // recognisable at all.
    expect(eventKey({ ...advance, runId: 'run-7' })).toBe(eventKey({ ...advance, runId: 'run-7' }));
  });

  it('stays unwired: no application, cycle, adapter or restore module imports it', () => {
    const cwd = fileURLToPath(new URL('../../..', import.meta.url));
    const grep = (...args: readonly string[]): string => {
      try {
        // `--untracked` so the proof covers the working tree as well as the commit,
        // and so a not-yet-committed import cannot pass this test. Ignored paths
        // (`node_modules`, build output) stay excluded.
        return execFileSync('git', ['grep', '-l', '--untracked', ...args], {
          cwd,
          encoding: 'utf8',
        });
      } catch (error) {
        // `git grep` exits 1 with no output when nothing matches; anything else is a real
        // failure and must not be read as an absence of imports.
        const failure = error as { status?: number; stdout?: string };
        expect(failure.status).toBe(1);
        expect(failure.stdout ?? '').toBe('');
        return '';
      }
    };
    const boundaries = [
      'services/engine-jobs/src/application',
      'services/engine-jobs/src/cycle',
      'services/engine-jobs/src/cycle.ts',
      'services/engine-jobs/src/adapters',
      'services/engine-jobs/src/restore',
      'services/engine-jobs/src/restore.ts',
      'services/platform-api/src',
      'apps/web/src',
    ];
    // No boundary module references the module by path OR by any exported name.
    for (const needle of [
      'paper-gate-keys',
      'paperGateGenerationKey',
      'paperGatePhaseEventKey',
      'paperGateRowScopeFromGenerationIdentity',
      'PAPER_GATE_GENERATION_KEY_DOMAIN',
    ])
      expect(grep(needle, '--', ...boundaries)).toBe('');
    const matches = (needle: string): readonly string[] =>
      grep(needle, '--', 'services/engine-jobs/src')
        .split('\n')
        .filter((line) => line !== '')
        .sort();
    // Negative controls: the same search DOES find things, so an empty result above means
    // "not referenced there", not "grep found nothing anywhere". Inside the service only
    // this test names the module's path, and only the module and this test name its
    // exports — which also proves the search reads the module file itself.
    expect(matches('paper-gate-keys')).toEqual([
      'services/engine-jobs/src/paper-gate-keys.test.ts',
    ]);
    expect(matches('paperGateGenerationKeyFraming')).toEqual([
      'services/engine-jobs/src/domain/paper-gate-keys.ts',
      'services/engine-jobs/src/paper-gate-keys.test.ts',
    ]);
  });
});
