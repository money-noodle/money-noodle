import { ENTRY_EXECUTION_POLICY_VERSION } from './entry-execution-policy';
import { PROFIT_REVERSAL_ARM_PERCENT, STRICT_EXIT_MIN_GAIN_CENTS } from './exit-policy';
import {
  BUY_POLICY_VERSION, MAX_ENTRY_PRICE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY,
  MIN_NET_EDGE, MIN_SELECTED_SIDE_PROBABILITY,
} from './prediction-policy';
import type { PolicyManifest, PolicyManifestComponent, PolicyManifestHistoryEntry, TradingProviderDescriptor } from './types';

const BUY_V13_ACTIVATED_AT = '2026-08-12T16:53:00.000Z';

const component = (
  kind: PolicyManifestComponent['kind'],
  label: string,
  version: string,
  status: PolicyManifestComponent['status'],
  summary: string,
  details: PolicyManifestComponent['details'],
): PolicyManifestComponent => ({ kind, label, version, status, summary, details });

const history: PolicyManifestHistoryEntry[] = [
  {
    version: BUY_POLICY_VERSION,
    activatedAt: BUY_V13_ACTIVATED_AT,
    status: 'active',
    summary: 'Restored the symmetric 55% selected-side floor for live and paper after prospective v12 near-floor losses.',
    changes: ['Selected-side floor 52.5% → 55%', 'All other entry and execution controls unchanged'],
    evidence: ['reports/live-run-review-2026-08-12.md'],
  },
  {
    version: 'buy-binary-edge-net5-quality50-owned52.5-price5to97-v12',
    activatedAt: '2026-08-11T22:51:09.266Z',
    deactivatedAt: BUY_V13_ACTIVATED_AT,
    status: 'superseded',
    summary: 'Narrow live/paper experiment that admitted the 52.5–55% selected-side cohort.',
    changes: ['Selected-side floor 55% → 52.5%'],
    evidence: ['reports/live-run-review-2026-08-12.md'],
  },
  {
    version: 'buy-binary-edge-net5-quality50-owned55-price5to97-v11',
    activatedAt: '2026-08-11T16:22:00.000Z',
    deactivatedAt: '2026-08-11T22:51:09.266Z',
    status: 'superseded',
    summary: 'Introduced the symmetric 55% model-favored-side floor to reject model-underdog purchases.',
    changes: ['Required independent P(selected side) ≥55%'],
    evidence: ['reports/forecast-and-exit-review-2026-08-11.md'],
  },
];

export function activePolicyManifest(providers: TradingProviderDescriptor[], modelVersion: string): PolicyManifest {
  const providerDetails = providers.flatMap((provider) => provider.variants.map((variant) => ({
    label: `${provider.name} · ${variant.name}`,
    value: `${variant.id} · ${provider.liveEnabled ? 'live + paper' : provider.paperEnabled ? 'paper only' : variant.status} · ${provider.adapterVersion}`,
  })));
  return {
    version: 'policy-manifest-v1',
    generatedAt: new Date().toISOString(),
    activeBuyPolicyVersion: BUY_POLICY_VERSION,
    activeBuyPolicyActivatedAt: BUY_V13_ACTIVATED_AT,
    components: [
      component('forecast', 'Forecast model', modelVersion, 'production', 'Venue-independent contract-basis probability.', [
        { label: 'Tradeable probability', value: 'No trading-provider price input' },
        { label: 'Basis log-odds weight', value: '0.55' },
        { label: 'Probability bounds', value: '3%–97%' },
      ]),
      component('buy', 'Binary buy policy', BUY_POLICY_VERSION, 'production', 'Symmetric positive-edge UP/YES and DOWN/NO qualification.', [
        { label: 'Selected-side probability', value: `≥${Number((MIN_SELECTED_SIDE_PROBABILITY * 100).toFixed(2))}%` },
        { label: 'Net edge after fees', value: `≥${Number((MIN_NET_EDGE * 100).toFixed(2))}pp` },
        { label: 'Estimate quality', value: `≥${Number((MIN_ESTIMATE_QUALITY * 100).toFixed(2))}%` },
        { label: 'Actionable ask', value: `${Number((MIN_ENTRY_PRICE * 100).toFixed(2))}¢–${Number((MAX_ENTRY_PRICE * 100).toFixed(2))}¢` },
        { label: 'Persistence', value: '3 snapshots spanning 30 seconds' },
        { label: 'Entry timing', value: '90-second warm-up; no entry in final 120 seconds' },
      ]),
      component('execution', 'Entry execution', ENTRY_EXECUTION_POLICY_VERSION, 'production', 'Maker-only live execution with separately measured taker shadows.', [
        { label: 'Production mode', value: 'Managed post-only maker' },
        { label: 'Retry default', value: 'One attempt' },
        { label: 'Taker', value: 'Observation-only recommendation; capped IOC primitive' },
      ]),
      component('exit', 'Standalone exits', 'strict-value-v1 + profit-reversal-75-v1', 'production', 'Reduce-only value and armed profit-reversal exits.', [
        { label: 'Strict value margin', value: `${STRICT_EXIT_MIN_GAIN_CENTS}¢` },
        { label: 'Profit lock arms', value: `+${PROFIT_REVERSAL_ARM_PERCENT * 100}% executable profit` },
        { label: 'Re-entry cooldown', value: '60 seconds plus fresh evidence' },
      ]),
      component('switch', 'Switch policy', 'future-wealth-side-gap-v1', 'production', 'Reduce-only replacement only when future wealth and probability advantage are positive.', [
        { label: 'Replacement advantage', value: '15pp' },
        { label: 'Same-asset reversal', value: '20pp' },
        { label: 'Persistence', value: '3 snapshots spanning 30 seconds' },
      ]),
      component('regime', 'Adaptive regime gate', 'adaptive-fee-edge-window-v1', 'production', 'Soft entry gate over current-policy exact-contract sentinel windows.', [
        { label: 'Warm-up', value: '12 policy windows' },
        { label: 'Pause confidence', value: '99%' },
        { label: 'Resume confidence', value: '75%' },
        { label: 'Evidence half-life', value: '12 windows' },
      ]),
      component('provider', 'Trading-provider variants', 'trading-provider-registry-v1', 'observation', 'Explicit provider capabilities and immutable semantic/execution variant identities.', providerDetails),
    ],
    history,
  };
}
