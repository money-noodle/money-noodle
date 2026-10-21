import { describe, expect, it } from 'vitest';
import {
  evaluatePaperRegimeEvidence,
  evaluateHistoricalPaperRegime,
  PAPER_HISTORICAL_REGIME_CONTRACT,
  type PaperRegimeLineage,
  PAPER_REGIME_SAMPLE_BUY_POLICY,
  PAPER_RESTRICTIVE_REGIME_PROPOSAL,
  REGIME_GATE_POLICY_VERSION,
  paperRegimeSettingsIdentity,
  type PaperRegimeIdentity,
  type PaperRegimeEvidence,
  type RegimeGateSettings,
} from './domain/paper-regime.js';
const now = Date.parse('2026-10-11T02:00:00Z');
const settings: RegimeGateSettings = {
  enabled: true,
  minimumPolicyWindows: 4,
  evidenceHalfLifeWindows: 2,
  pauseConfidence: 0.99,
  resumeConfidence: 0.75,
};
const identity: PaperRegimeIdentity = {
  epoch: 1,
  configIntentId: 'synthetic-config',
  evidenceGenerationId: 'synthetic-generation',
  bundleId: PAPER_RESTRICTIVE_REGIME_PROPOSAL,
  gateFormula: REGIME_GATE_POLICY_VERSION,
  settingsIdentity: paperRegimeSettingsIdentity(settings),
};
const evidence = (edge: number): PaperRegimeEvidence => ({
  identity,
  sourceKind: 'prospective-engine-run',
  sourceId: 'synthetic-run',
  policyVersion: PAPER_REGIME_SAMPLE_BUY_POLICY,
  complete: true,
  observedAtMs: now,
  previousPhase: 'open',
  previousPhasePolicyVersion: PAPER_REGIME_SAMPLE_BUY_POLICY,
  observations: Array.from({ length: 4 }, (_, i) => ({
    id: 'synthetic-' + i,
    policyVersion: PAPER_REGIME_SAMPLE_BUY_POLICY,
    closesAt: new Date(now - (4 - i) * 900000).toISOString(),
    resolvedAt: new Date(now - (4 - i) * 900000 + 1000).toISOString(),
    realizedEdge: edge,
  })),
});
const evaluate = (input: PaperRegimeEvidence | undefined, config = settings) =>
  evaluatePaperRegimeEvidence(input, PAPER_REGIME_SAMPLE_BUY_POLICY, config, now, 30000, {
    ...identity,
    settingsIdentity: paperRegimeSettingsIdentity(config),
  });
describe('explicit regime evidence without active sentinel collector', () => {
  it('accepts a legal confidence boundary and still refuses a violated margin', () => {
    // Evidence and expectation share the settings identity, so the only thing under test
    // is the settings gate itself.
    const withSettings = (config: RegimeGateSettings) => {
      const settingsIdentity = paperRegimeSettingsIdentity(config);
      const expected = { ...identity, settingsIdentity };
      return evaluatePaperRegimeEvidence(
        { ...evidence(0), identity: expected },
        PAPER_REGIME_SAMPLE_BUY_POLICY,
        config,
        now,
        30000,
        expected,
      );
    };
    // `resume <= pause - 0.01` holds exactly for this pair; in doubles the subtraction
    // rounded and the evaluator refused the settings outright.
    expect(0.93 <= 0.94 - 0.01).toBe(false);
    const allowed = withSettings({ ...settings, pauseConfidence: 0.94, resumeConfidence: 0.93 });
    expect(allowed.reason).not.toBe('Unsupported explicit paper regime settings.');
    expect(allowed.phase).toBe('open');
    expect(allowed.allowsEntries).toBe(true);
    for (const violated of [
      { ...settings, pauseConfidence: 0.94, resumeConfidence: 0.9301 },
      { ...settings, pauseConfidence: 0.9, resumeConfidence: 0.8901 },
    ])
      expect(withSettings(violated).reason).toBe('Unsupported explicit paper regime settings.');
  });
  it('preserves independent zero-edge mean and neutral confidence with bounded decay', () => {
    const result = evaluate(evidence(0));
    expect(result.phase).toBe('open');
    expect(result.allowsEntries).toBe(true);
    expect(result.weightedMeanEdge).toBe(0);
    expect(result.negativeReturnConfidence).toBeCloseTo(0.5, 7);
    expect(result.resolvedWindows).toBe(4);
  });
  it('closes unanimous negative evidence and reopens positive evidence using hysteresis', () => {
    expect(evaluate(evidence(-1)).allowsEntries).toBe(false);
    expect(evaluate({ ...evidence(1), previousPhase: 'closed' }).phase).toBe('open');
  });
  it('refuses missing/stale/incomplete/disabled/insufficient inputs rather than permissive warmup', () => {
    expect(evaluate(undefined).allowsEntries).toBe(false);
    expect(evaluate(evidence(0), { ...settings, enabled: false }).allowsEntries).toBe(false);
    for (const patch of [
      { observedAtMs: now - 30001 },
      { observedAtMs: now + 1 },
      { complete: false },
      { previousPhasePolicyVersion: 'old' },
      { observations: evidence(0).observations.slice(0, 3) },
    ])
      expect(evaluate({ ...evidence(0), ...patch }).allowsEntries).toBe(false);
  });
  it('refuses duplicate windows/ids, foreign policy, unsupported counts and malformed resolved evidence', () => {
    const e = evidence(0);
    expect(
      evaluate({ ...e, observations: [...e.observations, e.observations[0]!] }).allowsEntries,
    ).toBe(false);
    for (const patch of [
      { realizedEdge: NaN },
      { realizedEdge: 2 },
      { policyVersion: 'old' },
      { resolvedAt: new Date(now + 1).toISOString() },
      { closesAt: 'bad' },
    ])
      expect(
        evaluate({
          ...e,
          observations: e.observations.map((o, i) => (i === 0 ? { ...o, ...patch } : o)),
        }).allowsEntries,
      ).toBe(false);
    expect(evaluate(e, { ...settings, minimumPolicyWindows: 0 }).allowsEntries).toBe(false);
    expect(
      evaluate({ ...e, observations: Array.from({ length: 5001 }, () => e.observations[0]!) })
        .allowsEntries,
    ).toBe(false);
  });
});

it('binds generation/settings/epoch rather than trusting sample labels', () => {
  for (const patch of [
    { epoch: 0 },
    { evidenceGenerationId: 'other' },
    { settingsIdentity: 'other' },
    { gateFormula: 'other' as typeof REGIME_GATE_POLICY_VERSION },
  ])
    expect(evaluate({ ...evidence(0), identity: { ...identity, ...patch } }).allowsEntries).toBe(
      false,
    );
});
it('independent H2 z=1 hysteresis keeps open open but closed closed', () => {
  const e = evidence(-0.14122320202092406);
  const open = evaluate(e);
  expect(open.phase).toBe('open');
  expect(open.negativeReturnConfidence).toBeCloseTo(0.8413447461, 6);
  expect(evaluate({ ...e, previousPhase: 'closed' }).phase).toBe('closed');
  expect(evaluate({ ...evidence(0.14122320202092406), previousPhase: 'closed' }).phase).toBe(
    'open',
  );
});
it('fractional half-life remains valid source arithmetic input', () => {
  const config = { ...settings, evidenceHalfLifeWindows: 2.5 };
  expect(
    evaluate(
      {
        ...evidence(0),
        identity: { ...identity, settingsIdentity: paperRegimeSettingsIdentity(config) },
      },
      config,
    ).phase,
  ).toBe('open');
});

const persisted: PaperRegimeLineage = {
  kind: 'persisted',
  stateRunId: 'synthetic-state-run',
  revision: 1,
};
const initialized: PaperRegimeLineage = {
  kind: 'initialized',
  initializationRunId: 'synthetic-init-run',
  priorGenerationState: 'none',
  revision: 0,
};
const historical = (
  e: PaperRegimeEvidence | undefined,
  config = settings,
  lineage: PaperRegimeLineage | undefined = persisted,
) => {
  const expected: PaperRegimeIdentity = {
    ...identity,
    bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
    settingsIdentity: paperRegimeSettingsIdentity(config),
  };
  return evaluateHistoricalPaperRegime(
    e
      ? {
          ...e,
          identity: {
            ...e.identity,
            bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
            settingsIdentity: paperRegimeSettingsIdentity(config),
          },
        }
      : undefined,
    config,
    now,
    expected,
    lineage,
  );
};
it('historical empty genuine initialization warms/permits; missing or fake initialization refuses', () => {
  const empty = { ...evidence(0), previousPhase: 'warming' as const, observations: [] };
  expect(historical(empty, settings, initialized).phase).toBe('warming');
  expect(historical(empty, settings, initialized).allowsEntries).toBe(true);
  expect(historical(undefined, settings, initialized).allowsEntries).toBe(false);
  expect(
    evaluateHistoricalPaperRegime(
      { ...empty, identity: { ...identity, bundleId: PAPER_HISTORICAL_REGIME_CONTRACT } },
      settings,
      now,
      { ...identity, bundleId: PAPER_HISTORICAL_REGIME_CONTRACT },
      undefined,
    ).allowsEntries,
  ).toBe(false);
  expect(
    historical({ ...empty, previousPhase: 'closed' }, settings, initialized).allowsEntries,
  ).toBe(false);
});
it('historical3vs4 warms/permits while restrictive3 refuses and closed state cannot reset to warm', () => {
  const three = {
    ...evidence(-1),
    previousPhase: 'warming' as const,
    observations: evidence(-1).observations.slice(0, 3),
  };
  expect(historical(three).phase).toBe('warming');
  expect(historical(three).allowsEntries).toBe(true);
  expect(evaluate(three).allowsEntries).toBe(false);
  expect(historical(evidence(-1)).phase).toBe('closed');
  expect(historical({ ...three, previousPhase: 'closed' }).allowsEntries).toBe(false);
});
it('historical explicitly disabled settings permit only coherent lineage; malformed and incomplete refuse', () => {
  const disabled = { ...settings, enabled: false };
  expect(historical(evidence(0), disabled).phase).toBe('disabled');
  expect(historical(evidence(0), disabled).allowsEntries).toBe(true);
  expect(historical({ ...evidence(0), complete: false }, disabled).allowsEntries).toBe(false);
  expect(historical(evidence(0), { ...settings, evidenceHalfLifeWindows: NaN }).allowsEntries).toBe(
    false,
  );
});
it('historical H2 hysteresis matches independentCDF and genuine new generation warms without synthesized history', () => {
  const e = evidence(-0.14122320202092406);
  expect(historical(e).phase).toBe('open');
  expect(historical({ ...e, previousPhase: 'closed' }).phase).toBe('closed');
  expect(historical(e).negativeReturnConfidence).toBeCloseTo(0.8413447461, 6);
  const newId: PaperRegimeIdentity = {
    ...identity,
    bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
    evidenceGenerationId: 'synthetic-new-generation',
  };
  const empty = {
    ...evidence(0),
    identity: newId,
    previousPhase: 'warming' as const,
    observations: [],
  };
  expect(evaluateHistoricalPaperRegime(empty, settings, now, newId, initialized).phase).toBe(
    'warming',
  );
  expect(
    evaluateHistoricalPaperRegime(
      { ...empty, identity: { ...newId, evidenceGenerationId: 'old' } },
      settings,
      now,
      newId,
      initialized,
    ).allowsEntries,
  ).toBe(false);
});
it('historical resolved samples retain rank weights across elapsed wallclock time and fractional half-life', () => {
  const config = { ...settings, evidenceHalfLifeWindows: 2.5 };
  const old: PaperRegimeEvidence = {
    ...evidence(0),
    observedAtMs: now - 1000,
    identity: {
      ...identity,
      bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
      settingsIdentity: paperRegimeSettingsIdentity(config),
    },
  };
  expect(
    evaluateHistoricalPaperRegime(old, config, now + 86400000, old.identity, persisted).phase,
  ).toBe('open');
});
