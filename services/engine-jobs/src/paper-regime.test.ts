import { describe, expect, it } from 'vitest';
import {
  evaluatePaperRegimeEvidence,
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
