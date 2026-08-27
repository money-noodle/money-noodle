import { afterEach, describe, expect, it } from 'vitest';
import { activePolicyManifest } from './policy-manifest';
import { PRODUCTION_BASIS_LOG_ODDS_WEIGHT } from './calibration-replay';
import { MAX_TRADEABLE_PROBABILITY, MIN_TRADEABLE_PROBABILITY } from './dashboard';
import {
  BUY_POLICY_VERSION, MAX_ENTRY_PRICE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_SELECTED_SIDE_PROBABILITY,
} from './prediction-policy';
import { tradingProviderRegistry } from './trading-provider-registry';
import type { ModelPromotionEntry, TradingProviderConfiguration, WalkForwardParameters } from './types';

const parameters: WalkForwardParameters = {
  temperature: 1, basisWeight: 0.55, volatilityScale: 1, slowTiltScale: 0.8,
  probabilityCap: 0.03, minimumEdge: 0.05, maximumEdge: 0.35, minimumSelectedProbability: 0.55, minimumQuality: 0.5,
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
    expect(published.history[0].evidence.some((item) => item.includes('reports/'))).toBe(true);
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
    delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY;
    delete process.env.MONEY_NOODLE_MAX_NET_EDGE;
    delete process.env.MONEY_NOODLE_EXCLUDED_ASSETS;
    expect(detail('buy', 'Net edge after fees')).toBe('≥5pp and <100pp');
    expect(detail('buy', 'Selected-side probability')).toBe('≥55%');
    expect(detail('buy', 'Entry timing')).toBe('90-second warm-up; no entry in final 30 seconds');
    // One row each, not one per track: the published policy says the tracks cannot differ.
    expect(detail('eligibility', 'DOWN/NO entry')).toBe('Permitted');
    expect(detail('eligibility', 'Assets withheld')).toBe('XRP');
    expect(detail('eligibility', 'Applies to')).toBe('Live and paper identically');
  });

  it('reports configured values rather than defaults for every tunable control', () => {
    process.env.MONEY_NOODLE_MAX_NET_EDGE = '0.25';
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY = 'false';
    process.env.MONEY_NOODLE_EXCLUDED_ASSETS = 'DOGE,SOL';
    process.env.MONEY_NOODLE_REGIME_GATE_ENABLED = 'false';
    process.env.MONEY_NOODLE_REGIME_MIN_POLICY_WINDOWS = '20';
    process.env.MONEY_NOODLE_MIN_SWITCH_PROBABILITY_ADVANTAGE = '0.25';
    process.env.MONEY_NOODLE_MAX_LIVE_MAKER_ATTEMPTS = '2';
    process.env.MONEY_NOODLE_ENTRY_EXECUTION_MODE = 'adaptive';
    expect(detail('buy', 'Net edge after fees')).toBe('≥5pp and <25pp');
    expect(detail('eligibility', 'DOWN/NO entry')).toBe('Suspended by operator switch');
    expect(detail('eligibility', 'Assets withheld')).toBe('DOGE, SOL');
    expect(detail('regime', 'Status')).toBe('Disabled; entries are not gated');
    expect(detail('regime', 'Warm-up')).toBe('20 policy windows');
    expect(detail('switch', 'Replacement advantage')).toBe('25pp');
    expect(detail('execution', 'Live entry intents per side/window')).toBe('3');
    expect(detail('execution', 'Maker miss rearming')).toContain('Immediate after authoritative cancellation');
    expect(detail('execution', 'Fallback price')).toContain('125%');
    expect(detail('execution', 'Sizing')).toBe('0.3× below 30pp; 1× at or above; no upsizing');
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

describe('the manifest describes the policy the desk is actually running', () => {
  const manifest = () => activePolicyManifest([], 'Blend 0.4');
  const detail = (kind: string, label: string) => manifest().components
    .filter((component) => component.kind === kind)
    .flatMap((component) => component.details)
    .find((row) => row.label === label)?.value;

  it('quotes the basis weight the forecast actually uses', () => {
    // This was three independent literals: one in dashboard.ts, one in calibration-replay.ts, and one
    // typed into this manifest. They agreed by coincidence, so changing the model would have left the
    // published policy describing a weight nothing used.
    expect(detail('forecast', 'Basis log-odds weight')).toBe(`${PRODUCTION_BASIS_LOG_ODDS_WEIGHT}`);
  });

  it('quotes the probability bounds the forecast is actually clamped to', () => {
    expect(detail('forecast', 'Probability bounds'))
      .toBe(`${Number((MIN_TRADEABLE_PROBABILITY * 100).toFixed(2))}%–${Number((MAX_TRADEABLE_PROBABILITY * 100).toFixed(2))}%`);
  });

  it('quotes the entry gates from the constants execution reads', () => {
    expect(detail('buy', 'Selected-side probability')).toBe(`≥${Number((MIN_SELECTED_SIDE_PROBABILITY * 100).toFixed(2))}%`);
    expect(detail('buy', 'Estimate quality')).toBe(`≥${Number((MIN_ESTIMATE_QUALITY * 100).toFixed(2))}%`);
    expect(detail('buy', 'Actionable ask')).toBe(`${Number((MIN_ENTRY_PRICE * 100).toFixed(2))}¢–${Number((MAX_ENTRY_PRICE * 100).toFixed(2))}¢`);
  });

  it('follows a net-edge ceiling override rather than the version string', () => {
    // The version string says "net5to35". MONEY_NOODLE_MAX_NET_EDGE can move the real ceiling without
    // moving that string, so the detail row has to come from the function execution calls.
    const original = process.env.MONEY_NOODLE_MAX_NET_EDGE;
    process.env.MONEY_NOODLE_MAX_NET_EDGE = '0.2';
    try {
      expect(detail('buy', 'Net edge after fees')).toContain('<20pp');
    } finally {
      if (original === undefined) delete process.env.MONEY_NOODLE_MAX_NET_EDGE;
      else process.env.MONEY_NOODLE_MAX_NET_EDGE = original;
    }
  });

  it('describes the path-classification gate, which is restrictive and on by default', () => {
    // Two regime gates run. Only the adaptive one was published until 2026-08-16, so the surface
    // understated what the desk declines to trade by roughly 15% of windows.
    const gate = manifest().components.find((component) => component.kind === 'regime-classification');
    expect(gate).toBeDefined();
    expect(gate?.details.find((row) => row.label === 'Status')?.value).toContain('Enabled');
  });

  it('reports the classification gate as disabled when the operator turns it off', () => {
    const original = process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME;
    process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME = 'false';
    try {
      const gate = manifest().components.find((component) => component.kind === 'regime-classification');
      expect(gate?.status).toBe('observation');
      expect(gate?.details.find((row) => row.label === 'Status')?.value).toContain('Disabled');
    } finally {
      if (original === undefined) delete process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME;
      else process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME = original;
    }
  });
});
