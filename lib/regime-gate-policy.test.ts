import { describe, expect, it } from 'vitest';
import { evaluateRegimeGate, regimeGateSettings, type RegimeGateObservation, type RegimeGateSettings } from './regime-gate-policy';

const settings: RegimeGateSettings = {
  enabled: true,
  minimumPolicyWindows: 12,
  evidenceHalfLifeWindows: 12,
  pauseConfidence: 0.99,
  resumeConfidence: 0.75,
};
const observation = (index: number, realizedEdge: number, policyVersion = 'current'): RegimeGateObservation => ({
  id: String(index), policyVersion,
  closesAt: new Date(Date.UTC(2026, 7, 11, 0, index * 15)).toISOString(),
  resolvedAt: new Date(Date.UTC(2026, 7, 11, 0, index * 15 + 15)).toISOString(),
  realizedEdge,
});

describe('adaptive regime gate', () => {
  it('defaults to disabled and parses explicitly enabled bounded settings', () => {
    expect(regimeGateSettings({ NODE_ENV: 'test' }).enabled).toBe(false);
    expect(regimeGateSettings({
      NODE_ENV: 'test', MONEY_NOODLE_REGIME_GATE_ENABLED: 'true',
      MONEY_NOODLE_REGIME_PAUSE_CONFIDENCE: '2',
      MONEY_NOODLE_REGIME_RESUME_CONFIDENCE: '0.2',
      MONEY_NOODLE_REGIME_MIN_POLICY_WINDOWS: '1',
      MONEY_NOODLE_REGIME_EVIDENCE_HALF_LIFE_WINDOWS: '1',
    })).toMatchObject({ enabled: true, pauseConfidence: 0.9999, resumeConfidence: 0.5, minimumPolicyWindows: 4, evidenceHalfLifeWindows: 2 });
  });

  it('stays permissive during current-policy warm-up', () => {
    const result = evaluateRegimeGate(Array.from({ length: 11 }, (_, index) => observation(index, -0.9)), 'current', 'warming', settings);
    expect(result.phase).toBe('warming');
    expect(result.allowsEntries).toBe(true);
    expect(result.resolvedWindows).toBe(11);
  });

  it('closes only after strong fee-aware negative evidence', () => {
    const result = evaluateRegimeGate(Array.from({ length: 12 }, (_, index) => observation(index, -0.8)), 'current', 'open', settings);
    expect(result.phase).toBe('closed');
    expect(result.allowsEntries).toBe(false);
    expect(result.negativeReturnConfidence).toBeGreaterThanOrEqual(0.99);
  });

  it('automatically reopens under the lower recovery threshold as new sentinel wins arrive', () => {
    const losses = Array.from({ length: 12 }, (_, index) => observation(index, -0.8));
    const wins = Array.from({ length: 18 }, (_, index) => observation(index + 12, 0.4));
    const result = evaluateRegimeGate([...losses, ...wins], 'current', 'closed', { ...settings, evidenceHalfLifeWindows: 4 });
    expect(result.phase).toBe('open');
    expect(result.allowsEntries).toBe(true);
    expect(result.negativeReturnConfidence).toBeLessThan(0.75);
  });

  it('does not let observations from an older policy warm the active generation', () => {
    const old = Array.from({ length: 30 }, (_, index) => observation(index, -0.9, 'old'));
    const result = evaluateRegimeGate(old, 'current', 'closed', settings);
    expect(result.phase).toBe('warming');
    expect(result.resolvedWindows).toBe(0);
    expect(result.allowsEntries).toBe(true);
  });

  it('never gates when disabled', () => {
    const result = evaluateRegimeGate(Array.from({ length: 30 }, (_, index) => observation(index, -1)), 'current', 'closed', { ...settings, enabled: false });
    expect(result.phase).toBe('disabled');
    expect(result.allowsEntries).toBe(true);
  });
});
