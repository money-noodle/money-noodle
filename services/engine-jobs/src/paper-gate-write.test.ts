import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PAPER_GATE_GENESIS_REVISION,
  comparePaperGateReplay,
  derivePaperGateEvaluation,
  derivePaperGateUniverse,
  paperGateGenerationInputsAreValid,
  paperGateIsoMilliseconds,
  paperGateSettingsFromRow,
  paperGateWriteRequestIsValid,
  type PaperGateGenerationInputs,
  type PaperGateIntendedEvent,
  type PaperGatePersistedEvent,
  type PaperGateUniverseEntry,
  type PaperGateWriteRequest,
} from './domain/paper-gate-write.js';
import type { PaperGateRowScope } from './domain/paper-gate-row-codec.js';
import {
  createPostgresPaperGateWriter,
  createPaperGateWriterCore,
} from './adapters/engine-store/postgres-paper-gate-writer.js';
import { createTestOnlyAuditedPolicyGateWriter } from './test-support/paper-gate-test-writer.js';
import {
  PAPER_HISTORICAL_REGIME_CONTRACT,
  PAPER_REGIME_SAMPLE_BUY_POLICY,
  PAPER_RESTRICTIVE_REGIME_PROPOSAL,
  REGIME_GATE_POLICY_VERSION,
} from './domain/paper-regime.js';

// `sample_policy` is a literal type on the scope, so the object is typed rather than
// widened to `string`.
const SCOPE: PaperGateRowScope = {
  budget_id: 'writer-actor:paper',
  epoch: 11,
  funding_id: 'writer-funding',
  generation_config_intent_id: 'writer-config',
  generation_key: 'writer-generation',
  sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
};
const FENCE = { capability: 'budget:paper', owner: 'writer-owner', fencingToken: 5n };
const GENERATION: PaperGateGenerationInputs = {
  bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
  enabled: true,
  evidenceHalfLifeWindows: '2.5',
  minimumPolicyWindows: 4,
  pauseConfidence: '0.99',
  profileClaim: 'synthetic-writer-profile',
  resumeConfidence: '0.75',
};
const COMMON = {
  coverageCutoffAtIso: '2026-10-14T00:00:00.000Z',
  coverageReceiptId: 'writer-receipt',
  evidenceObservedAtIso: '2026-10-14T00:00:00.000Z',
  eventKey: 'writer-event-0',
  runId: 'root-paper-run',
  scope: SCOPE,
};
const INITIALIZE: PaperGateWriteRequest = { ...COMMON, generation: GENERATION, kind: 'initialize' };
const EVALUATE: PaperGateWriteRequest = { ...COMMON, expectedRevision: 0n, kind: 'evaluate' };

describe('paper gate write request validation', () => {
  it('accepts the three well formed shapes', () => {
    expect(paperGateWriteRequestIsValid(INITIALIZE, FENCE)).toBeUndefined();
    expect(paperGateWriteRequestIsValid(EVALUATE, FENCE)).toBeUndefined();
    expect(
      paperGateWriteRequestIsValid(
        {
          ...COMMON,
          generation: GENERATION,
          kind: 'reset',
          priorGenerationKey: 'writer-generation-prior',
          resetBarrierIntentId: 'writer-reset',
        },
        FENCE,
      ),
    ).toBeUndefined();
  });

  it('refuses a malformed scope, fence, epoch or identity before anything else', () => {
    expect(
      paperGateWriteRequestIsValid({ ...INITIALIZE, scope: { ...SCOPE, epoch: 0 } }, FENCE),
    ).toBe('scope');
    expect(
      paperGateWriteRequestIsValid({ ...INITIALIZE, scope: { ...SCOPE, epoch: 1.5 } }, FENCE),
    ).toBe('scope');
    expect(paperGateWriteRequestIsValid(INITIALIZE, { ...FENCE, fencingToken: 0n })).toBe('scope');
    expect(paperGateWriteRequestIsValid(INITIALIZE, { ...FENCE, owner: '' })).toBe('scope');
    expect(paperGateWriteRequestIsValid({ ...INITIALIZE, eventKey: ' x' }, FENCE)).toBe('request');
    expect(paperGateWriteRequestIsValid({ ...INITIALIZE, runId: '' }, FENCE)).toBe('request');
    expect(paperGateWriteRequestIsValid({ ...INITIALIZE, coverageReceiptId: '' }, FENCE)).toBe(
      'request',
    );
  });

  it('requires strict millisecond ISO boundaries, not a lossy date', () => {
    expect(paperGateIsoMilliseconds('2026-10-14T00:00:00.000Z')).toBe(
      Date.parse('2026-10-14T00:00:00.000Z'),
    );
    for (const bad of [
      '2026-10-14T00:00:00Z',
      '2026-10-14T00:00:00.000000Z',
      '2026-10-14T00:00:00.000+00:00',
      '2026-13-14T00:00:00.000Z',
      '',
    ])
      expect(paperGateIsoMilliseconds(bad)).toBeUndefined();
    expect(
      paperGateWriteRequestIsValid(
        { ...INITIALIZE, evidenceObservedAtIso: '2026-10-14T00:00:00Z' },
        FENCE,
      ),
    ).toBe('request');
  });

  it('bounds the generation contract inputs to exactly the 0006 domains', () => {
    expect(paperGateGenerationInputsAreValid(GENERATION)).toBe(true);
    for (const over of [
      { bundleId: 'something-else' },
      { profileClaim: '' },
      { enabled: 'yes' },
      { minimumPolicyWindows: 3 },
      { minimumPolicyWindows: 501 },
      { evidenceHalfLifeWindows: '1.9' },
      { evidenceHalfLifeWindows: '501' },
      // Exponent, sign and float forms are all refused: the text is cast to numeric.
      { pauseConfidence: '9.9e-1' },
      { pauseConfidence: '+0.99' },
      { pauseConfidence: 0.99 },
      { pauseConfidence: '0.89' },
      { resumeConfidence: '0.99' },
      { resumeConfidence: '0.49' },
    ])
      expect(
        paperGateGenerationInputsAreValid({ ...GENERATION, ...over } as PaperGateGenerationInputs),
      ).toBe(false);
    // resume must be at least a hundredth below pause.
    expect(
      paperGateGenerationInputsAreValid({
        ...GENERATION,
        pauseConfidence: '0.95',
        resumeConfidence: '0.945',
      }),
    ).toBe(false);
  });

  it('refuses a reset whose prior generation is the one being created', () => {
    expect(
      paperGateWriteRequestIsValid(
        {
          ...COMMON,
          generation: GENERATION,
          kind: 'reset',
          priorGenerationKey: SCOPE.generation_key,
          resetBarrierIntentId: 'writer-reset',
        },
        FENCE,
      ),
    ).toBe('request');
  });
});

const entry = (
  key: string,
  closesMicroseconds: bigint,
  resolved?: { resolvedAt: bigint; recordedAt: bigint; edge: string },
): PaperGateUniverseEntry => ({
  candidateKey: key,
  closesAtMicroseconds: closesMicroseconds,
  contractId: 'synthetic-contract',
  outcomeRecordedAtMicroseconds: resolved?.recordedAt,
  outcomeResolvedAtMicroseconds: resolved?.resolvedAt,
  realizedEdge: resolved?.edge,
  side: 'UP',
});

// 2026-10-12T02:15:00.000Z and the next three 15 minute windows, in microseconds.
const W1 = 1791771300000000n;
const WINDOW = 900000000n;
const resolvedAt = (window: bigint) => ({
  edge: '0.2',
  recordedAt: window + 2000000n,
  resolvedAt: window + 1000000n,
});

describe('paper gate universe derivation', () => {
  it('counts resolved and unresolved and bounds the window range', () => {
    const derived = derivePaperGateUniverse([
      entry('c1', W1, resolvedAt(W1)),
      entry('c2', W1 + WINDOW),
      entry('c3', W1 + 2n * WINDOW, resolvedAt(W1 + 2n * WINDOW)),
    ]);
    expect(derived).toEqual({
      capturedCandidateCount: 3,
      capturedResolvedCount: 2,
      capturedUnresolvedCount: 1,
      firstClosesAtMicroseconds: W1,
      lastClosesAtMicroseconds: W1 + 2n * WINDOW,
    });
  });

  it('refuses a duplicate candidate or a duplicate window rather than picking one', () => {
    expect(derivePaperGateUniverse([entry('c1', W1), entry('c1', W1 + WINDOW)])).toBeUndefined();
    expect(derivePaperGateUniverse([entry('c1', W1), entry('c2', W1)])).toBeUndefined();
  });

  it('is empty-safe and leaves the window bounds absent', () => {
    expect(derivePaperGateUniverse([])).toEqual({
      capturedCandidateCount: 0,
      capturedResolvedCount: 0,
      capturedUnresolvedCount: 0,
      firstClosesAtMicroseconds: undefined,
      lastClosesAtMicroseconds: undefined,
    });
  });
});

const GEN_ROW = {
  bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
  configIntentId: 'writer-config',
  enabled: true,
  epoch: 11,
  evidenceHalfLifeWindows: '2.5',
  gateFormula: REGIME_GATE_POLICY_VERSION,
  initializationRunId: 'root-paper-run',
  minimumPolicyWindows: 4,
  pauseConfidence: '0.99',
  resumeConfidence: '0.75',
  samplePolicy: PAPER_REGIME_SAMPLE_BUY_POLICY,
  settingsDescriptor: 'regime-settings-v1:true:4:2.5:0.99:0.75',
};
const OBSERVED_MS = Date.parse('2026-10-14T00:00:00.000Z');
const NOW_MS = Date.parse('2026-10-18T00:00:00.000Z');

describe('paper gate settings and evaluation derivation', () => {
  it('requires the row columns and the settings descriptor to agree', () => {
    expect(paperGateSettingsFromRow(GEN_ROW)).toEqual({
      enabled: true,
      evidenceHalfLifeWindows: 2.5,
      minimumPolicyWindows: 4,
      pauseConfidence: 0.99,
      resumeConfidence: 0.75,
    });
    expect(
      paperGateSettingsFromRow({
        ...GEN_ROW,
        settingsDescriptor: 'regime-settings-v1:true:4:2.5:0.99:0.70',
      }),
    ).toBeUndefined();
    expect(paperGateSettingsFromRow({ ...GEN_ROW, pauseConfidence: 'x' })).toBeUndefined();
  });

  it('derives warming with nothing resolved, from the genesis lineage', () => {
    const outcome = derivePaperGateEvaluation(
      GEN_ROW,
      [entry('c1', W1)],
      'warming',
      {
        initializationRunId: 'root-paper-run',
        kind: 'initialized',
        priorGenerationState: 'none',
        revision: 0,
      },
      OBSERVED_MS,
      NOW_MS,
    );
    expect('refusal' in outcome).toBe(false);
    if ('refusal' in outcome) return;
    expect(outcome.observations).toHaveLength(0);
    expect(outcome.inputs).toHaveLength(0);
    expect(outcome.evaluation.phase).toBe('warming');
    expect(outcome.evaluation.effectiveWindows).toBe(0);
    expect(outcome.evaluation.weightedMeanEdge).toBeNull();
  });

  it('derives the ordered observations and a real phase from a persisted lineage', () => {
    const entries = [0n, 1n, 2n, 3n, 4n].map((i) =>
      entry('c' + i.toString(), W1 + i * WINDOW, resolvedAt(W1 + i * WINDOW)),
    );
    const outcome = derivePaperGateEvaluation(
      GEN_ROW,
      // Deliberately out of order on input: the derivation sorts by window then key.
      [...entries].reverse(),
      'warming',
      { kind: 'persisted', revision: 1, stateRunId: 'root-paper-run' },
      OBSERVED_MS,
      NOW_MS,
    );
    expect('refusal' in outcome).toBe(false);
    if ('refusal' in outcome) return;
    expect(outcome.inputs.map((i) => i.candidateKey)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(outcome.observations.map((o) => o.closesAt)).toEqual([
      '2026-10-12T02:15:00.000Z',
      '2026-10-12T02:30:00.000Z',
      '2026-10-12T02:45:00.000Z',
      '2026-10-12T03:00:00.000Z',
      '2026-10-12T03:15:00.000Z',
    ]);
    expect(outcome.evaluation.phase).toBe('open');
    expect(outcome.evaluation.resolvedWindows).toBe(5);
    expect(outcome.evaluation.weightedMeanEdge).toBe(0.2);
  });

  it('reports the restrictive bundle as an absent producer rather than guessing an age', () => {
    const outcome = derivePaperGateEvaluation(
      { ...GEN_ROW, bundleId: PAPER_RESTRICTIVE_REGIME_PROPOSAL },
      [],
      'warming',
      { initializationRunId: 'r', kind: 'initialized', priorGenerationState: 'none', revision: 0 },
      OBSERVED_MS,
      NOW_MS,
    );
    expect(outcome).toEqual({
      detail: 'restrictive-bundle-max-age-undecided',
      refusal: 'evidence-producer-unavailable',
    });
  });

  it('refuses an evaluation whose own shape does not match the derived universe', () => {
    // An outcome resolved AFTER the claimed observation boundary makes the qualified
    // evaluator refuse, and a refusal is never persisted as an event.
    const outcome = derivePaperGateEvaluation(
      GEN_ROW,
      [0n, 1n, 2n, 3n, 4n].map((i) =>
        entry('c' + i.toString(), W1 + i * WINDOW, {
          edge: '0.2',
          recordedAt: BigInt(NOW_MS) * 1000n,
          resolvedAt: BigInt(NOW_MS) * 1000n,
        }),
      ),
      'warming',
      { kind: 'persisted', revision: 1, stateRunId: 'root-paper-run' },
      OBSERVED_MS,
      NOW_MS,
    );
    expect('refusal' in outcome).toBe(true);
    if (!('refusal' in outcome)) return;
    expect(outcome.refusal).toBe('evidence-rejected');
  });

  it('refuses a generation whose formula or policy is not the qualified one', () => {
    for (const over of [{ gateFormula: 'other' }, { samplePolicy: 'other' }])
      expect(
        derivePaperGateEvaluation(
          { ...GEN_ROW, ...over },
          [],
          'warming',
          {
            initializationRunId: 'r',
            kind: 'initialized',
            priorGenerationState: 'none',
            revision: 0,
          },
          OBSERVED_MS,
          NOW_MS,
        ),
      ).toMatchObject({ refusal: 'generation' });
  });
});

const INTENDED: PaperGateIntendedEvent = {
  capturedCandidateCount: 0,
  capturedResolvedCount: 0,
  capturedUnresolvedCount: 0,
  eventKind: 'genesis',
  inputCandidateKeys: [],
  inputCount: 0,
  previousPhase: undefined,
  priorEventKey: undefined,
  projectedPhase: 'warming',
  revisionAfter: PAPER_GATE_GENESIS_REVISION,
  revisionBefore: undefined,
  universeFirstClosesAtMicroseconds: undefined,
  universeLastClosesAtMicroseconds: undefined,
};
const PERSISTED: PaperGatePersistedEvent = {
  budgetId: SCOPE.budget_id,
  capturedCandidateCount: 0,
  capturedResolvedCount: 0,
  capturedUnresolvedCount: 0,
  configIntentId: SCOPE.generation_config_intent_id,
  coverageCutoffAtMicroseconds: BigInt(Date.parse(COMMON.coverageCutoffAtIso)) * 1000n,
  coverageReceiptId: COMMON.coverageReceiptId,
  currentEffectConfigIntentId: 'writer-config',
  epoch: SCOPE.epoch,
  eventKind: 'genesis',
  evidenceObservedAtMicroseconds: BigInt(Date.parse(COMMON.evidenceObservedAtIso)) * 1000n,
  evidenceVersion: 'paper-regime-explicit-evidence-v1',
  fundingId: SCOPE.funding_id,
  generationKey: SCOPE.generation_key,
  inputCandidateKeys: [],
  inputCount: 0,
  latestIntentId: 'writer-config',
  previousPhase: undefined,
  priorEventKey: undefined,
  projectedPhase: 'warming',
  resultPhase: undefined,
  revisionAfter: 0n,
  revisionBefore: undefined,
  runId: COMMON.runId,
  samplePolicy: SCOPE.sample_policy,
  sourceKind: 'prospective-engine-run',
  universeFirstClosesAtMicroseconds: undefined,
  universeLastClosesAtMicroseconds: undefined,
};

describe('paper gate replay comparison', () => {
  it('matches an exactly equal replay', () => {
    expect(comparePaperGateReplay(PERSISTED, INTENDED, INITIALIZE, FENCE)).toBeUndefined();
  });

  it('names the first field that differs, for every compared field', () => {
    const cases: readonly (readonly [string, Partial<PaperGatePersistedEvent>])[] = [
      ['generation_key', { generationKey: 'other' }],
      ['funding_id', { fundingId: 'other' }],
      ['epoch', { epoch: 12 }],
      ['budget_id', { budgetId: 'other:paper' }],
      ['generation_config_intent_id', { configIntentId: 'other' }],
      ['sample_policy', { samplePolicy: 'other' }],
      ['run_id', { runId: 'other' }],
      ['source_kind', { sourceKind: 'other' }],
      ['evidence_version', { evidenceVersion: 'other' }],
      ['coverage_receipt_id', { coverageReceiptId: 'other' }],
      ['evidence_observed_at', { evidenceObservedAtMicroseconds: 1n }],
      ['coverage_cutoff_at', { coverageCutoffAtMicroseconds: 1n }],
      ['event_kind', { eventKind: 'evaluated' }],
      ['revision_after', { revisionAfter: 1n }],
      ['revision_before', { revisionBefore: 0n }],
      ['prior_event_key', { priorEventKey: 'other' }],
      ['previous_phase', { previousPhase: 'warming' }],
      ['projected_phase', { projectedPhase: 'open' }],
      ['captured_candidate_count', { capturedCandidateCount: 1 }],
      ['captured_resolved_count', { capturedResolvedCount: 1 }],
      ['captured_unresolved_count', { capturedUnresolvedCount: 1 }],
      ['input_count', { inputCount: 1 }],
      ['universe_first_closes_at', { universeFirstClosesAtMicroseconds: W1 }],
      ['universe_last_closes_at', { universeLastClosesAtMicroseconds: W1 }],
      ['ordered_inputs', { inputCandidateKeys: ['c1'] }],
    ];
    for (const [field, over] of cases)
      expect(comparePaperGateReplay({ ...PERSISTED, ...over }, INTENDED, INITIALIZE, FENCE)).toBe(
        field,
      );
  });

  it('compares ordered inputs by position, not as a set', () => {
    const persisted = { ...PERSISTED, inputCandidateKeys: ['c1', 'c2'] };
    const intended = { ...INTENDED, inputCandidateKeys: ['c2', 'c1'] };
    expect(comparePaperGateReplay(persisted, intended, INITIALIZE, FENCE)).toBe('ordered_inputs');
  });

  it('compares the expected revision against the RECORDED revision, not the head', () => {
    const persisted = {
      ...PERSISTED,
      eventKind: 'evaluated',
      previousPhase: 'warming',
      priorEventKey: 'writer-genesis',
      resultPhase: 'warming',
      revisionAfter: 1n,
      revisionBefore: 0n,
    };
    const intended = {
      ...INTENDED,
      eventKind: 'evaluated' as const,
      previousPhase: 'warming' as const,
      priorEventKey: 'writer-genesis',
      revisionAfter: 1n,
      revisionBefore: 0n,
    };
    expect(comparePaperGateReplay(persisted, intended, EVALUATE, FENCE)).toBeUndefined();
    expect(
      comparePaperGateReplay(persisted, intended, { ...EVALUATE, expectedRevision: 1n }, FENCE),
    ).toBe('expected_revision');
  });
});

describe('writer availability boundary', () => {
  const root = join(process.cwd(), 'services/engine-jobs/src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);

  it('keeps the audited-policy core reachable only from test-support and tests', () => {
    const importers = files.filter(
      (file) =>
        !file.includes('/test-support/') &&
        !file.endsWith('.test.ts') &&
        !file.endsWith('postgres-paper-gate-writer.ts') &&
        readFileSync(file, 'utf8').includes('createPaperGateWriterCore'),
    );
    expect(importers).toEqual([]);
  });

  it('keeps the test-only seam out of the shipped build', () => {
    const build = JSON.parse(
      readFileSync(join(process.cwd(), 'services/engine-jobs/tsconfig.build.json'), 'utf8'),
    ) as { exclude: string[] };
    // The strongest part of the boundary: the test-only wrapper is not compiled into
    // `dist` at all, so it cannot be imported by anything that ships.
    expect(build.exclude).toContain('src/test-support/**');
    expect(typeof createTestOnlyAuditedPolicyGateWriter).toBe('function');
    expect(createTestOnlyAuditedPolicyGateWriter).not.toBe(createPostgresPaperGateWriter);
    expect(typeof createPaperGateWriterCore).toBe('function');
  });

  it('gives the production factory no availability parameter at all', () => {
    const source = readFileSync(
      join(root, 'adapters/engine-store/postgres-paper-gate-writer.ts'),
      'utf8',
    );
    const factory = source.slice(source.indexOf('export function createPostgresPaperGateWriter'));
    const signature = factory.slice(0, factory.indexOf('): PaperGateWriter'));
    expect(signature).not.toContain('auditedBundleAvailable');
    expect(signature).not.toContain('boolean');
    // And it passes the compiled constant, never a parameter.
    expect(factory).toContain('COMPILED_PAPER_BUNDLE_AVAILABLE');
  });
});
