import { describe, expect, it } from 'vitest';
import {
  decodePaperConfiguration,
  evaluatePaperAuthority,
  generationInputsFromConfiguration,
  paperProviderWithheld,
  type PaperAuthoritySnapshot,
  type PaperAuthorityIntent,
} from './domain/paper-authority.js';
import { paperGateGenerationInputsAreValid } from './domain/paper-gate-write.js';
import {
  PAPER_HISTORICAL_REGIME_CONTRACT,
  PAPER_RESTRICTIVE_REGIME_PROPOSAL,
} from './domain/paper-regime.js';
// Synthetic, in-bounds values only: no strategy value is selected here or anywhere in
// the repository. The two spellings `2.50` and `0.970` are deliberate -- the writer's own
// grammar accepts them and nothing normalises them away.
const config = {
  paper_config_version: 2,
  budget_id: 'synthetic:paper',
  funding_id: 'synthetic-funding',
  total_cap_cents: 1000,
  entry_cap_cents: 200,
  kalshi_cap_cents: 500,
  polymarket_cap_cents: 0,
  kalshi_market_percent: 100,
  polymarket_market_percent: 0,
  paper_providers: 'kalshi',
  market_id: 'crypto-15m',
  policy_bundle: 'paper-v1-blend04-neutral-v7',
  regime_bundle_id: PAPER_HISTORICAL_REGIME_CONTRACT,
  regime_profile_claim: 'synthetic-profile-claim',
  regime_enabled: true,
  regime_minimum_policy_windows: 12,
  regime_evidence_half_life_windows: '2.50',
  regime_pause_confidence: '0.970',
  regime_resume_confidence: '0.9',
};
const c1: PaperAuthorityIntent = {
  id: 'C1',
  epoch: 7,
  actor: 'synthetic',
  capability: 'budget:paper',
  action: 'configure',
  parameters: config,
};
const resume: PaperAuthorityIntent = {
  ...c1,
  id: 'R',
  action: 'resume',
  parameters: { paper_config_version: 2, config_intent_id: 'C1' },
};
const base = (): PaperAuthoritySnapshot => ({
  complete: true,
  epoch: 7,
  latest: resume,
  latestTimeValid: true,
  configure: c1,
  configureTimeValid: true,
  configureAtOrBeforeLatest: true,
  configureAfterReset: true,
  funding: { id: 'synthetic-funding', budgetId: 'synthetic:paper', epoch: 7, conserved: true },
});
describe('paper configuration design; injected audited fixture is not production admission', () => {
  it('requires exactly19 scalars without coercion/unknown version/identity', () => {
    expect(Object.keys(config)).toHaveLength(19);
    expect(decodePaperConfiguration(config)).toEqual(config);
    const { funding_id: removed, ...missing } = config;
    expect(removed).toBe('synthetic-funding');
    expect(decodePaperConfiguration(missing)).toBeUndefined();
    for (const patch of [
      { extra: true },
      // Versions other than 2 are refused outright: never upgraded, defaulted or
      // back-filled, and `0` is refused like any other, not treated as absent.
      { paper_config_version: 0 },
      { paper_config_version: 1 },
      { paper_config_version: 3 },
      { paper_config_version: '2' },
      { entry_cap_cents: '200' },
      { funding_id: null },
      { market_id: 'crypto-1h' },
      { policy_bundle: 'future' },
      { paper_providers: ['kalshi'] },
      { budget_id: 'x'.repeat(121) },
    ])
      expect(decodePaperConfiguration({ ...config, ...patch })).toBeUndefined();
  });
  it('bounds the operator-recorded generation profile on 0006 and maps it unchanged', () => {
    const decoded = decodePaperConfiguration(config)!;
    expect(decoded.regime_profile_claim).toBe('synthetic-profile-claim');
    // The mapping is a rename: what the decoder accepted is exactly what the persisted
    // gate writer's own validator accepts.
    const inputs = generationInputsFromConfiguration(decoded);
    expect(inputs).toEqual({
      bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
      enabled: true,
      evidenceHalfLifeWindows: '2.50',
      minimumPolicyWindows: 12,
      pauseConfidence: '0.970',
      profileClaim: 'synthetic-profile-claim',
      resumeConfidence: '0.9',
    });
    expect(paperGateGenerationInputsAreValid(inputs)).toBe(true);
    // Both bundle constants decode, and nothing else does.
    expect(
      decodePaperConfiguration({ ...config, regime_bundle_id: PAPER_RESTRICTIVE_REGIME_PROPOSAL }),
    ).toBeDefined();
    // Spellings the writer has always accepted stay acceptable by VALUE.
    for (const patch of [
      { regime_evidence_half_life_windows: '2.5' },
      { regime_evidence_half_life_windows: '08' },
      { regime_pause_confidence: '0.97' },
      { regime_pause_confidence: '0.9700' },
    ])
      expect(decodePaperConfiguration({ ...config, ...patch })).toBeDefined();
    // Inclusive corners of each domain.
    for (const patch of [
      { regime_minimum_policy_windows: 4 },
      { regime_minimum_policy_windows: 500 },
      { regime_evidence_half_life_windows: '2' },
      { regime_evidence_half_life_windows: '500' },
      { regime_pause_confidence: '0.9', regime_resume_confidence: '0.89' },
      { regime_pause_confidence: '0.9999', regime_resume_confidence: '0.98' },
    ])
      expect(decodePaperConfiguration({ ...config, ...patch })).toBeDefined();
    // Every profile field, individually out of bounds or of the wrong shape.
    for (const patch of [
      { regime_bundle_id: 'paper-regime-unknown-v1' },
      { regime_bundle_id: 2 },
      { regime_profile_claim: '' },
      { regime_profile_claim: ' untrimmed' },
      { regime_profile_claim: 'x'.repeat(121) },
      { regime_enabled: 'true' },
      { regime_minimum_policy_windows: 3 },
      { regime_minimum_policy_windows: 501 },
      { regime_minimum_policy_windows: 12.5 },
      { regime_minimum_policy_windows: '12' },
      { regime_evidence_half_life_windows: '1.9999' },
      { regime_evidence_half_life_windows: '500.1' },
      { regime_evidence_half_life_windows: 2.5 },
      { regime_evidence_half_life_windows: '1e2' },
      { regime_pause_confidence: '0.8999' },
      { regime_pause_confidence: '0.99991' },
      { regime_pause_confidence: ' 0.99' },
      { regime_pause_confidence: '+0.9' },
      { regime_pause_confidence: 0.99 },
      { regime_resume_confidence: '0.4999' },
      { regime_resume_confidence: '0.9801' },
      // The margin, on the digits: one ten-thousandth too high.
      { regime_pause_confidence: '0.97', regime_resume_confidence: '0.9601' },
      // And the high-precision pair the shared helper admits only when it is legal.
      {
        regime_pause_confidence: '0.93999999999999989',
        regime_resume_confidence: '0.92999999999999990',
      },
    ])
      expect(decodePaperConfiguration({ ...config, ...patch })).toBeUndefined();
    // The legal high-precision pair, which `numeric` accepts, decodes and maps.
    const precise = decodePaperConfiguration({
      ...config,
      regime_pause_confidence: '0.93999999999999989',
      regime_resume_confidence: '0.92999999999999989',
    });
    expect(precise).toBeDefined();
    expect(paperGateGenerationInputsAreValid(generationInputsFromConfiguration(precise!))).toBe(
      true,
    );
  });

  it('bounds conservative cents without selecting current capital; zero withholds provider', () => {
    expect(decodePaperConfiguration({ ...config, total_cap_cents: 1000000 })).toBeDefined();
    for (const cap of [0, -1, 0.5, Infinity, NaN, 1000001])
      expect(decodePaperConfiguration({ ...config, total_cap_cents: cap })).toBeUndefined();
    expect(decodePaperConfiguration({ ...config, entry_cap_cents: 1001 })).toBeUndefined();
    const decoded = decodePaperConfiguration(config)!;
    expect(paperProviderWithheld(decoded, 'kalshi')).toBe(false);
    expect(paperProviderWithheld(decoded, 'polymarket')).toBe(true);
    expect(paperProviderWithheld({ ...decoded, kalshi_cap_cents: 0 }, 'kalshi')).toBe(true);
    expect(paperProviderWithheld({ ...decoded, kalshi_market_percent: 0 }, 'kalshi')).toBe(true);
    expect(paperProviderWithheld({ ...decoded, paper_providers: 'none' }, 'kalshi')).toBe(true);
  });
  it('default compiled bundle is unavailable, explicit audited synthetic fixture tests C1/resume only', () => {
    expect(evaluatePaperAuthority(base())).toEqual({
      allowed: false,
      reason: 'bundle-unavailable',
    });
    expect(evaluatePaperAuthority(base(), true)).toEqual({
      allowed: true,
      config,
      configIntentId: 'C1',
      latestIntentId: 'R',
    });
    expect(evaluatePaperAuthority({ ...base(), latest: c1 }, true).allowed).toBe(true);
  });
  it('pause/provider-enable/reset do not grant; bare or stale resume refuses', () => {
    for (const action of ['pause', 'provider-enable', 'reset'] as const)
      expect(evaluatePaperAuthority({ ...base(), latest: { ...resume, action } }, true)).toEqual({
        allowed: false,
        reason: 'paused',
      });
    for (const parameters of [
      {},
      { paper_config_version: 2 },
      { paper_config_version: 1, config_intent_id: 'C1' },
      { paper_config_version: 3, config_intent_id: 'C1' },
      { paper_config_version: 2, config_intent_id: 'old' },
    ])
      expect(
        evaluatePaperAuthority({ ...base(), latest: { ...resume, parameters } }, true).allowed,
      ).toBe(false);
    expect(evaluatePaperAuthority({ ...base(), configureAfterReset: false }, true).allowed).toBe(
      false,
    );
  });
  it('newest C2 makes C1 reference stale and malformed C2 poisons without fallback', () => {
    const c2 = { ...c1, id: 'C2' };
    expect(evaluatePaperAuthority({ ...base(), configure: c2 }, true)).toEqual({
      allowed: false,
      reason: 'resume-reference-invalid',
    });
    expect(
      evaluatePaperAuthority({ ...base(), configure: { ...c2, parameters: {} } }, true),
    ).toEqual({ allowed: false, reason: 'configuration-invalid' });
  });
  it('rejects global future/stale epoch/latest, actor/live capability and conservation mismatch', () => {
    for (const patch of [
      { epoch: 8 },
      { complete: false },
      { latestTimeValid: false },
      { configureTimeValid: false },
      { configureAtOrBeforeLatest: false },
      { latest: { ...resume, epoch: 6 } },
      { latest: { ...resume, epoch: 8 } },
      { latest: { ...resume, actor: 'other' } },
      { latest: { ...resume, capability: 'budget:live' } },
      { configure: { ...c1, parameters: { ...config, budget_id: 'synthetic:live' } } },
      { funding: { id: 'other', budgetId: 'synthetic:paper', epoch: 7, conserved: true } },
      {
        funding: {
          id: 'synthetic-funding',
          budgetId: 'synthetic:paper',
          epoch: 7,
          conserved: false,
        },
      },
    ])
      expect(evaluatePaperAuthority({ ...base(), ...patch }, true).allowed).toBe(false);
  });
});

it('refuses coherent epoch0 even with audited fixture; epoch1 reference remains valid', () => {
  const b = base();
  const withEpoch = (epoch: number) => ({
    ...b,
    epoch,
    latest: { ...resume, epoch },
    configure: { ...c1, epoch },
    funding: { ...b.funding!, epoch },
  });
  expect(evaluatePaperAuthority(withEpoch(0), true).allowed).toBe(false);
  expect(evaluatePaperAuthority(withEpoch(1), true).allowed).toBe(true);
});
