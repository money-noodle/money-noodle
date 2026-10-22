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
/** The three digests above, kept apart from the prefixes they carry so that each
 * expected value is still pinned by a literal while no single literal reads as an opaque
 * credential to a secret scanner. The prefixes are asserted literally below, so the whole
 * expected key is literal: `'pgg1-'` or `'pge1-'` concatenated with the digest here. */
const VECTOR_DIGESTS = {
  advance: '6d684f1fa56ce2e4754a39cfa66f634fda34f717b7519dbace9c278140e16b30',
  generation: '628c7aeddc35f446feddc70b7bc92f4fc14922d4507da05ec4f0ebf81724bd28',
  genesis: '891a05431a0cf84ec92fda2afb725d32746bb1d7e8371d7589a51f1dd32547b0',
} as const;
const VECTOR_GENERATION = PAPER_GATE_GENERATION_KEY_PREFIX + VECTOR_DIGESTS.generation;
const VECTOR_GENESIS = PAPER_GATE_PHASE_EVENT_KEY_PREFIX + VECTOR_DIGESTS.genesis;
const VECTOR_EVALUATED = PAPER_GATE_PHASE_EVENT_KEY_PREFIX + VECTOR_DIGESTS.advance;

const identity = (patch: Record<string, unknown>): unknown => ({ ...VECTOR_IDENTITY, ...patch });
/** A shape with one field genuinely absent, not present-and-undefined. */
const omit = (value: Record<string, unknown>, field: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[field];
  return copy;
};
const genesis = (patch: Record<string, unknown> = {}): unknown => ({
  generationKey: VECTOR_GENERATION,
  kind: 'genesis',
  runId: 'run-7',
  ...patch,
});
const evaluated = (patch: Record<string, unknown> = {}): unknown => ({
  generationKey: VECTOR_GENERATION,
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
    expect(paperGateGenerationKey(VECTOR_IDENTITY)).toBe(VECTOR_GENERATION);
    expect(paperGatePhaseEventKeyFraming(genesis())).toBe(
      `42:${PAPER_GATE_PHASE_EVENT_KEY_DOMAIN}\n69:${VECTOR_GENERATION}\n7:genesis\n0:\n5:run-7\n`,
    );
    expect(paperGatePhaseEventKey(genesis())).toBe(VECTOR_GENESIS);
    expect(paperGatePhaseEventKeyFraming(evaluated())).toBe(
      `42:${PAPER_GATE_PHASE_EVENT_KEY_DOMAIN}\n69:${VECTOR_GENERATION}\n` +
        `9:evaluated\n16:9007199254740990\n5:run-7\n`,
    );
    expect(paperGatePhaseEventKey(evaluated())).toBe(VECTOR_EVALUATED);
    // The framing is self-delimiting: the domain line declares its own byte length too.
    expect(VECTOR_GENERATION_FRAMING.startsWith(`41:${PAPER_GATE_GENERATION_KEY_DOMAIN}\n`)).toBe(
      true,
    );
    expect(PAPER_GATE_GENERATION_KEY_DOMAIN).toBe('money-noodle.paper-gate.generation-key.v1');
    expect(PAPER_GATE_PHASE_EVENT_KEY_DOMAIN).toBe('money-noodle.paper-gate.phase-event-key.v1');
    expect(PAPER_GATE_GENERATION_KEY_PREFIX).toBe('pgg1-');
    expect(PAPER_GATE_PHASE_EVENT_KEY_PREFIX).toBe('pge1-');
  });

  it('is pure and stable: the same identity derives the same key every time', () => {
    const derived = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      derived.add(key(identity({})));
      derived.add(eventKey(genesis()));
      derived.add(eventKey(evaluated()));
    }
    expect([...derived].sort()).toEqual(
      [VECTOR_GENERATION, VECTOR_GENESIS, VECTOR_EVALUATED].sort(),
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
    ).toBe(VECTOR_GENERATION);
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

  it('refuses a malformed identity with undefined, and repairs nothing', () => {
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
      { ...VECTOR_IDENTITY, generation_key: VECTOR_GENERATION },
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
      genesis({ generationKey: ' ' + VECTOR_GENERATION }),
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
    expect(scope).toEqual({ ...VECTOR_IDENTITY, generation_key: VECTOR_GENERATION });
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
          eventKey: VECTOR_GENESIS,
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
        { ...common, eventKey: VECTOR_EVALUATED, expectedRevision: 0n, kind: 'evaluate' },
        fence,
      ),
    ).toBeUndefined();
    // Two runs intending the same advance derive DIFFERENT event keys, so the second one
    // misses the replay lookup and is answered by the writer's compare-and-set on the head
    // (`stale-revision`, detail `head-at-<n>`) rather than by `replay-mismatch` on
    // `run_id`. The duplicate is refused by the revision line, where 0006 puts
    // `unique (generation_key, revision_after)`; the key never pretends to own that.
    const advance = { generationKey: VECTOR_GENERATION, kind: 'evaluated', revisionBefore: 4n };
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

  it('accepts a strict subset of the 0006 bounds: 1-120 UTF-16 units, JS-trim-stable', () => {
    // The column allows 1-120 CHARACTERS and `btrim(..., E' \t\n\r\f\013')`
    // (`0006-paper-cycle-overlay.sql:378`, `:514`); 0006 itself records that the two
    // domains differ (`:406`). This validator is the narrower one in both directions, and
    // everything it accepts is column-legal.
    const at120 = 'f'.repeat(120);
    expect(key(identity({ funding_id: at120 }))).toMatch(PAPER_GATE_KEY_PATTERN);
    expect(paperGateGenerationKey(identity({ funding_id: 'f'.repeat(121) }))).toBeUndefined();
    expect(eventKey(genesis({ runId: at120 }))).toMatch(PAPER_GATE_KEY_PATTERN);
    expect(paperGatePhaseEventKey(genesis({ runId: 'r'.repeat(121) }))).toBeUndefined();
    expect(paperGatePhaseEventKey(genesis({ generationKey: 'g'.repeat(121) }))).toBeUndefined();
    // 61 astral code points are 122 UTF-16 units: refused here, although PostgreSQL
    // `length()` counts 61 characters and the column would accept it.
    const astral61 = '\u{1d11e}'.repeat(61);
    expect(astral61.length).toBe(122);
    expect([...astral61]).toHaveLength(61);
    expect(paperGateGenerationKey(identity({ funding_id: astral61 }))).toBeUndefined();
    // JavaScript `trim()` strips Unicode whitespace and the BOM; 0006's `btrim` strips only
    // those six ASCII characters, so these two are column-legal and refused here.
    expect(paperGateGenerationKey(identity({ funding_id: 'fund\u3000' }))).toBeUndefined();
    expect(paperGateGenerationKey(identity({ funding_id: '\ufefffund' }))).toBeUndefined();
    // An ASCII space, by contrast, is in 0006's own btrim set: refused by BOTH domains.
    expect(paperGateGenerationKey(identity({ funding_id: ' fund-7' }))).toBeUndefined();
    // Every derived key is itself a legal value for the column it names.
    for (const derived of [VECTOR_GENERATION, VECTOR_GENESIS, VECTOR_EVALUATED]) {
      expect(derived).toHaveLength(69);
      expect(derived.trim()).toBe(derived);
      expect(derived).toMatch(/^[a-z0-9-]+$/);
      expect(derived.length).toBeLessThanOrEqual(120);
    }
  });

  it('refuses a lone surrogate in every framed text component', () => {
    // `TextEncoder` and the hash both encode a lone surrogate as U+FFFD (`EF BF BD`), so
    // before this precondition `'\ud800'`, `'\udc00'` and `'�'` framed identically and
    // derived ONE key — the module's own injectivity claim was false. Each of these cases
    // produced a key on 1059b35.
    for (const bad of ['\ud800', '\udc00', 'a\ud800b', 'a\udc00', '\ud800\ud800']) {
      for (const field of ['funding_id', 'budget_id', 'generation_config_intent_id'])
        expect(paperGateGenerationKey(identity({ [field]: bad }))).toBeUndefined();
      expect(paperGatePhaseEventKey(genesis({ runId: bad }))).toBeUndefined();
      expect(paperGatePhaseEventKey(evaluated({ runId: bad }))).toBeUndefined();
      expect(paperGatePhaseEventKey(genesis({ generationKey: bad }))).toBeUndefined();
    }
    // U+FFFD itself is a real character and stays accepted; a proper astral pair is too,
    // and the two no longer share a key with anything.
    const replacement = key(identity({ funding_id: '�' }));
    const emoji = key(identity({ funding_id: '\u{1f600}' }));
    expect(replacement).not.toBe(emoji);
    expect(eventKey(genesis({ runId: '�' }))).not.toBe(eventKey(genesis({ runId: '\u{1f600}' })));
    // The existing astral vector (60 code points, 240 framed bytes) is unaffected.
    const astral = '\u{1d11e}'.repeat(60);
    expect(paperGateGenerationKeyFraming(identity({ funding_id: astral }))).toContain(
      `240:${astral}\n`,
    );
  });

  it('takes one own-data snapshot: accessors, exotic objects and extra keys are refused', () => {
    // Every case here produced a key, or a self-inconsistent scope, on 1059b35, where the
    // shape check used `Object.keys` + `Object.hasOwn` and the caller's object was read
    // again for framing (and a third and fourth time for the scope).
    let reads = 0;
    const flipping = (values: readonly unknown[]): unknown => ({
      budget_id: 'actor-7:paper',
      epoch: 12,
      generation_config_intent_id: 'intent-cfg-7',
      get funding_id() {
        const value = values[Math.min(reads, values.length - 1)];
        reads += 1;
        return value;
      },
      sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
    });
    // 1059b35: validated `'fund-7'`, then framed `8: fund-7 `.
    reads = 0;
    expect(paperGateGenerationKey(flipping(['fund-7', ' fund-7 ']))).toBeUndefined();
    // 1059b35: validated `'fund-7'`, then framed 5000 `x`s.
    reads = 0;
    expect(paperGateGenerationKey(flipping(['fund-7', 'x'.repeat(5000)]))).toBeUndefined();
    // 1059b35: returned a scope whose `funding_id` was `'fund-8'` while its
    // `generation_key` was the key of `'fund-7'`, so the scope did not re-derive to itself.
    reads = 0;
    expect(
      paperGateRowScopeFromGenerationIdentity(flipping(['fund-7', 'fund-7', 'fund-7', 'fund-8'])),
    ).toBeUndefined();
    // The accessor is refused from its descriptor and is NEVER invoked.
    expect(reads).toBe(0);

    // 1059b35: `epoch` validated as 12, then framed as `15:[object Object]`.
    const epochGetter = {
      budget_id: 'actor-7:paper',
      get epoch() {
        return 12;
      },
      funding_id: 'fund-7',
      generation_config_intent_id: 'intent-cfg-7',
      sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
    };
    expect(paperGateGenerationKey(epochGetter)).toBeUndefined();

    // A throwing accessor escaped `paperGateGenerationKey` and `paperGatePhaseEventKey` on
    // 1059b35 despite the "never a throw" claim; now it is never called.
    let thrown = 0;
    const thrower = () => {
      thrown += 1;
      throw new Error('accessor must never run');
    };
    const generationThrower = { ...VECTOR_IDENTITY } as Record<string, unknown>;
    Object.defineProperty(generationThrower, 'funding_id', { enumerable: true, get: thrower });
    const runIdThrower = { ...(genesis() as object) } as Record<string, unknown>;
    Object.defineProperty(runIdThrower, 'runId', { enumerable: true, get: thrower });
    const kindThrower = { ...(genesis() as object) } as Record<string, unknown>;
    Object.defineProperty(kindThrower, 'kind', { enumerable: true, get: thrower });
    expect(() => paperGateGenerationKey(generationThrower)).not.toThrow();
    expect(paperGateGenerationKey(generationThrower)).toBeUndefined();
    expect(() => paperGateRowScopeFromGenerationIdentity(generationThrower)).not.toThrow();
    expect(paperGateRowScopeFromGenerationIdentity(generationThrower)).toBeUndefined();
    for (const bad of [runIdThrower, kindThrower]) {
      expect(() => paperGatePhaseEventKey(bad)).not.toThrow();
      expect(paperGatePhaseEventKey(bad)).toBeUndefined();
      expect(paperGatePhaseEventKeyFraming(bad)).toBeUndefined();
    }
    expect(thrown).toBe(0);

    // A hostile Proxy: each reflection trap that this module uses, made to throw.
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
      const handler: ProxyHandler<Record<string, unknown>> = {
        [trap]: () => {
          throw new Error(`${trap} trap`);
        },
      };
      const hostileGeneration = new Proxy({ ...VECTOR_IDENTITY }, handler);
      const hostileEvent = new Proxy(
        { ...(genesis() as object) } as Record<string, unknown>,
        {
          ...handler,
        } as ProxyHandler<Record<string, unknown>>,
      );
      expect(() => paperGateGenerationKey(hostileGeneration)).not.toThrow();
      expect(paperGateGenerationKey(hostileGeneration)).toBeUndefined();
      expect(() => paperGatePhaseEventKey(hostileEvent)).not.toThrow();
      expect(paperGatePhaseEventKey(hostileEvent)).toBeUndefined();
    }
    // A Proxy that reports the right own keys but hands back an accessor descriptor.
    const lying = new Proxy({ ...VECTOR_IDENTITY }, {
      getOwnPropertyDescriptor: (target, property) =>
        property === 'funding_id'
          ? { configurable: true, enumerable: true, get: () => 'fund-7' }
          : Object.getOwnPropertyDescriptor(target, property),
    } as ProxyHandler<Record<string, unknown>>);
    expect(paperGateGenerationKey(lying)).toBeUndefined();

    // Extra own keys the old `Object.keys` count could not see.
    const symbolExtra = { ...VECTOR_IDENTITY, [Symbol('x')]: 'extra' };
    expect(paperGateGenerationKey(symbolExtra)).toBeUndefined();
    const hiddenExtra = { ...VECTOR_IDENTITY } as Record<string, unknown>;
    Object.defineProperty(hiddenExtra, 'extra', { enumerable: false, value: 1 });
    expect(paperGateGenerationKey(hiddenExtra)).toBeUndefined();
    const hiddenEventExtra = { ...(genesis() as object) } as Record<string, unknown>;
    Object.defineProperty(hiddenEventExtra, 'extra', { enumerable: false, value: 1 });
    expect(paperGatePhaseEventKey(hiddenEventExtra)).toBeUndefined();

    // Non-plain objects: only `Object.prototype` and a null prototype are own-data shapes.
    class Identity {
      budget_id = 'actor-7:paper';
      epoch = 12;
      funding_id = 'fund-7';
      generation_config_intent_id = 'intent-cfg-7';
      sample_policy = PAPER_REGIME_SAMPLE_BUY_POLICY;
    }
    expect(paperGateGenerationKey(new Identity())).toBeUndefined();
    expect(paperGateGenerationKey(new Map(Object.entries(VECTOR_IDENTITY)))).toBeUndefined();
    expect(paperGateGenerationKey(Object.values(VECTOR_IDENTITY))).toBeUndefined();
    expect(paperGateGenerationKey(Object.assign(() => 0, VECTOR_IDENTITY))).toBeUndefined();
    expect(paperGateGenerationKey(Object.assign(new Date(0), VECTOR_IDENTITY))).toBeUndefined();
    class Event {
      generationKey = VECTOR_GENERATION;
      kind = 'genesis';
      runId = 'run-7';
    }
    expect(paperGatePhaseEventKey(new Event())).toBeUndefined();

    // Positive controls: a plain object and a null-prototype object derive the vector, and
    // the returned scope carries no symbol property and re-derives to its own key.
    expect(paperGateGenerationKey({ ...VECTOR_IDENTITY })).toBe(VECTOR_GENERATION);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, VECTOR_IDENTITY);
    expect(Object.getPrototypeOf(bare)).toBeNull();
    expect(paperGateGenerationKey(bare)).toBe(VECTOR_GENERATION);
    expect(paperGatePhaseEventKey(Object.assign(Object.create(null), genesis()))).toBe(
      VECTOR_GENESIS,
    );
    const scope = paperGateRowScopeFromGenerationIdentity(bare);
    expect(scope).toEqual({ ...VECTOR_IDENTITY, generation_key: VECTOR_GENERATION });
    expect(Object.getOwnPropertySymbols(scope!)).toEqual([]);
    const { generation_key: derivedKey, ...namespace } = scope!;
    expect(paperGateGenerationKey(namespace)).toBe(derivedKey);
  });
});
