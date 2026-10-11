import { describe, expect, it } from 'vitest';
import {
  decodePaperConfiguration,
  evaluatePaperAuthority,
  paperProviderWithheld,
  type PaperAuthoritySnapshot,
  type PaperAuthorityIntent,
} from './domain/paper-authority.js';
const config = {
  paper_config_version: 1,
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
  parameters: { paper_config_version: 1, config_intent_id: 'C1' },
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
  it('requires exactly12 scalars without coercion/unknown version/identity', () => {
    expect(Object.keys(config)).toHaveLength(12);
    expect(decodePaperConfiguration(config)).toEqual(config);
    const { funding_id: removed, ...missing } = config;
    expect(removed).toBe('synthetic-funding');
    expect(decodePaperConfiguration(missing)).toBeUndefined();
    for (const patch of [
      { extra: true },
      { paper_config_version: 2 },
      { entry_cap_cents: '200' },
      { funding_id: null },
      { market_id: 'crypto-1h' },
      { policy_bundle: 'future' },
      { paper_providers: ['kalshi'] },
      { budget_id: 'x'.repeat(121) },
    ])
      expect(decodePaperConfiguration({ ...config, ...patch })).toBeUndefined();
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
      { paper_config_version: 1 },
      { paper_config_version: 2, config_intent_id: 'C1' },
      { paper_config_version: 1, config_intent_id: 'old' },
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
