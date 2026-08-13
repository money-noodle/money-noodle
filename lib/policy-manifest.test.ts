import { afterEach, describe, expect, it } from 'vitest';
import { activePolicyManifest } from './policy-manifest';
import { BUY_POLICY_VERSION } from './prediction-policy';
import { tradingProviderRegistry } from './trading-provider-registry';
import type { ModelPromotionEntry, TradingProviderConfiguration, WalkForwardParameters } from './types';

const parameters: WalkForwardParameters = {
  temperature: 1, basisWeight: 0.55, volatilityScale: 1, slowTiltScale: 0.8,
  probabilityCap: 0.03, minimumEdge: 0.05, minimumQuality: 0.5,
};
const promotion = (id: string, at: string, modelVersion: string, action: ModelPromotionEntry['action'] = 'promoted'): ModelPromotionEntry =>
  ({ id, at, action, modelVersion, parameters, reason: `${action} ${modelVersion}` });

const configuration = (): TradingProviderConfiguration => {
  const at = '2026-08-12T00:00:00.000Z';
  const variant = {
    polymarket: 'polymarket-clob-contract-v1', kalshi: 'kalshi-15m-maker-v1',
    'crypto-com': 'crypto-com-event-contract-v1', forecastex: 'forecastex-contract-v1', robinhood: 'robinhood-event-contract-v1',
  } as const;
  return {
    version: 'trading-provider-config-v1', revision: 1, updatedAt: at, executionAuthority: 'provider-registry-v1', audit: [],
    providers: (Object.keys(variant) as Array<keyof typeof variant>).map((providerId) => ({
      providerId, researchEnabled: providerId === 'polymarket' || providerId === 'kalshi',
      paperEnabled: providerId === 'polymarket' || providerId === 'kalshi',
      liveEnabled: providerId === 'kalshi', selectedVariantId: variant[providerId], updatedAt: at,
    })),
  };
};

const manifest = (promotions: ModelPromotionEntry[] = []) =>
  activePolicyManifest(tradingProviderRegistry(configuration()), 'Blend 0.4', promotions);
const detail = (kind: string, label: string) => manifest().components.find((item) => item.kind === kind)?.details
  .find((item) => item.label === label)?.value;

const restore = { ...process.env };
afterEach(() => { process.env = { ...restore }; });

describe('published policy manifest', () => {
  it('records the active buy policy in history rather than inheriting the constant', () => {
    const published = manifest();
    // The history entries are literal strings, so bumping BUY_POLICY_VERSION fails here until the
    // change is described. This is the assertion that a version bump must not be able to satisfy
    // by itself, because a policy the desk cannot explain is not a policy it should be running.
    expect(published.history[0]).toMatchObject({ version: BUY_POLICY_VERSION, status: 'active' });
    expect(published.activeBuyPolicyVersion).toBe(BUY_POLICY_VERSION);
    expect(published.activeBuyPolicyActivatedAt).toBe(published.history[0].activatedAt);
    expect(published.history[0].changes.length).toBeGreaterThan(0);
  });

  it('keeps the history an unbroken, non-overlapping chain', () => {
    const { history } = manifest();
    expect(new Set(history.map((entry) => entry.version)).size).toBe(history.length);
    expect(history.filter((entry) => entry.status === 'active')).toHaveLength(1);
    expect(history[0].deactivatedAt).toBeUndefined();
    for (const [index, entry] of history.entries()) {
      expect(Number.isFinite(Date.parse(entry.activatedAt))).toBe(true);
      if (index === 0) continue;
      expect(entry.deactivatedAt).toBe(history[index - 1].activatedAt);
      expect(Date.parse(entry.activatedAt)).toBeLessThan(Date.parse(entry.deactivatedAt!));
    }
  });

  it('publishes the edge ceiling and the per-track side and asset withholdings', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE = 'false';
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_PAPER = 'true';
    delete process.env.MONEY_NOODLE_MAX_NET_EDGE;
    delete process.env.MONEY_NOODLE_LIVE_EXCLUDED_ASSETS;
    expect(detail('buy', 'Net edge after fees')).toBe('≥5pp and <35pp');
    expect(detail('buy', 'Selected-side probability')).toBe('≥55%');
    expect(detail('buy', 'Entry timing')).toBe('90-second warm-up; no entry in final 120 seconds');
    expect(detail('eligibility', 'DOWN/NO entry · live')).toBe('Suspended pending recalibration');
    expect(detail('eligibility', 'DOWN/NO entry · paper')).toBe('Permitted, measuring');
    expect(detail('eligibility', 'Assets withheld · live')).toBe('XRP');
    expect(detail('eligibility', 'Assets withheld · paper')).toBe('None');
  });

  it('reports configured values rather than defaults for every tunable control', () => {
    process.env.MONEY_NOODLE_MAX_NET_EDGE = '0.25';
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE = 'true';
    process.env.MONEY_NOODLE_LIVE_EXCLUDED_ASSETS = 'DOGE,SOL';
    process.env.MONEY_NOODLE_REGIME_GATE_ENABLED = 'false';
    process.env.MONEY_NOODLE_REGIME_MIN_POLICY_WINDOWS = '20';
    process.env.MONEY_NOODLE_MIN_SWITCH_PROBABILITY_ADVANTAGE = '0.25';
    process.env.MONEY_NOODLE_MAX_LIVE_MAKER_ATTEMPTS = '2';
    expect(detail('buy', 'Net edge after fees')).toBe('≥5pp and <25pp');
    expect(detail('eligibility', 'DOWN/NO entry · live')).toBe('Permitted');
    expect(detail('eligibility', 'Assets withheld · live')).toBe('DOGE, SOL');
    expect(detail('regime', 'Status')).toBe('Disabled; entries are not gated');
    expect(detail('regime', 'Warm-up')).toBe('20 policy windows');
    expect(detail('switch', 'Replacement advantage')).toBe('25pp');
    expect(detail('execution', 'Live attempts per contract')).toBe('2');
    expect(manifest().components.find((item) => item.kind === 'regime')?.status).toBe('observation');
  });
});

describe('published model provenance', () => {
  it('reports an empty ledger as an unrecorded production model rather than as no model', () => {
    const model = manifest().model!;
    expect(model).toMatchObject({ productionVersion: 'Blend 0.4', unrecorded: true, history: [] });
    expect(model.currentPromotion).toBeUndefined();
  });

  it('reports a production model the newest entry does not name as still unrecorded', () => {
    const model = manifest([promotion('a', '2026-08-01T00:00:00.000Z', 'Blend 0.3')]).model!;
    expect(model.unrecorded).toBe(true);
    expect(model.currentPromotion?.modelVersion).toBe('Blend 0.3');
  });

  it('records the promotion chain newest first once production matches the ledger', () => {
    const model = manifest([
      promotion('a', '2026-08-01T00:00:00.000Z', 'Blend 0.3'),
      promotion('c', '2026-08-10T00:00:00.000Z', 'Blend 0.4', 'rolled-back'),
      promotion('b', '2026-08-05T00:00:00.000Z', 'Blend 0.5'),
    ]).model!;
    expect(model.unrecorded).toBe(false);
    expect(model.currentPromotion?.id).toBe('c');
    expect(model.history.map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
  });
});
