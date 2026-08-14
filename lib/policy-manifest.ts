import { excludedAssets } from './asset-exclusion';
import { ENTRY_EXECUTION_POLICY_VERSION, parseEntryExecutionMode } from './entry-execution-policy';
import { POST_EXIT_REENTRY_COOLDOWN_MS, PROFIT_REVERSAL_ARM_PERCENT, STRICT_EXIT_MIN_GAIN_CENTS, profitReversalExitEnabled, standaloneExitPolicyVersion } from './exit-policy';
import { maximumLiveMakerAttempts } from './maker-retry-policy';
import { activeModel } from './model-promotion';
import {
  BUY_POLICY_VERSION, MAX_ENTRY_PRICE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY,
  MIN_NET_EDGE, MIN_SELECTED_SIDE_PROBABILITY, downEntryEnabled, maximumNetEdge,
} from './prediction-policy';
import { REGIME_GATE_POLICY_VERSION, regimeGateSettings } from './regime-gate-policy';
import {
  EXECUTION_LATE_CUTOFF_MS, EXECUTION_WARMUP_MS, REQUIRED_OBSERVATION_SPAN_MS, REQUIRED_QUALIFYING_SNAPSHOTS,
} from './signal-persistence';
import { REQUIRED_SWITCH_SNAPSHOTS, REQUIRED_SWITCH_SPAN_MS } from './switch-hysteresis';
import { SWITCH_POLICY_VERSION, switchPolicySettings } from './switch-policy';
import { TRADING_PROVIDER_REGISTRY_VERSION } from './trading-provider-registry';
import type { ModelPromotionEntry, PolicyManifest, PolicyManifestComponent, PolicyManifestHistoryEntry, PolicyManifestModel, TradingProviderDescriptor } from './types';

const component = (
  kind: PolicyManifestComponent['kind'],
  label: string,
  version: string,
  status: PolicyManifestComponent['status'],
  summary: string,
  details: PolicyManifestComponent['details'],
): PolicyManifestComponent => ({ kind, label, version, status, summary, details });

/**
 * Immutable record of every buy policy that has been live, newest first.
 *
 * Versions are written out in full rather than referenced through BUY_POLICY_VERSION: the published
 * history must describe what each version actually changed, so bumping the constant has to fail the
 * manifest test until a matching entry is added here.
 */
const history: PolicyManifestHistoryEntry[] = [
  {
    version: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v17',
    activatedAt: '2026-08-14T01:05:00.000Z',
    status: 'active',
    summary: 'One policy for both tracks: paper became a true mirror of live rather than a second, quietly different desk.',
    changes: [
      'Entry rules take no execution mode, so a live/paper policy divergence can no longer be expressed',
      'Paper now withholds XRP and obeys the adaptive regime gate, exactly as live does',
      'The per-track DOWN switches collapse to one MONEY_NOODLE_ALLOW_DOWN_ENTRY, currently enabled',
      'Asset withholding collapses to one MONEY_NOODLE_EXCLUDED_ASSETS list covering both tracks',
      'Version bumped so records made before the alignment stay distinguishable from mirror records',
    ],
    evidence: ['SPEC.md §12 · Track separation and policy evaluation'],
  },
  {
    version: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v16',
    activatedAt: '2026-08-14T00:20:00.000Z',
    deactivatedAt: '2026-08-14T01:05:00.000Z',
    status: 'superseded',
    summary: 'Withdrew the DOWN/NO suspension after its evidence failed to reproduce against the order ledger.',
    changes: [
      'DOWN/NO entry permitted again on both tracks, restoring roughly half the desk’s volume',
      'Suspension inverted to an explicit per-track switch, MONEY_NOODLE_SUSPEND_DOWN_ENTRY_LIVE / _PAPER',
      'XRP remains withheld from live entry on its own, reproducible evidence',
    ],
    evidence: ['STATUS.md · DOWN suspension withdrawn: the evidence did not reproduce (2026-08-14)'],
  },
  {
    version: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-uponly-v15',
    activatedAt: '2026-08-13T21:20:43.000Z',
    deactivatedAt: '2026-08-14T00:20:00.000Z',
    status: 'superseded',
    summary: 'Added an upper bound on claimed edge, above which a disagreement is treated as model failure rather than opportunity.',
    changes: [
      'Net edge must now be at least 5pp and strictly below 35pp',
      'Applied at both the shared admissibility check and the inline per-venue qualification path',
      'Restrictive only, and tunable through MONEY_NOODLE_MAX_NET_EDGE',
    ],
    evidence: ['STATUS.md · Edge ceiling at 35pp, buy policy v15 (2026-08-13)'],
  },
  {
    version: 'buy-binary-edge-net5-quality50-owned55-price5to97-uponly-v14',
    activatedAt: '2026-08-13T17:35:09.000Z',
    deactivatedAt: '2026-08-13T21:20:43.000Z',
    status: 'superseded',
    summary: 'Suspended DOWN/NO entry after clustered per-window returns isolated it as the source of the live loss.',
    changes: [
      'DOWN/NO entry refused unless explicitly re-enabled',
      'Later scoped per track, so paper keeps trading DOWN while live does not',
      'Exits, reduce-only sells, and settlement of existing DOWN positions unaffected',
    ],
    evidence: ['STATUS.md · DOWN/NO entry suspended after a loss review (2026-08-13)'],
  },
  {
    version: 'buy-binary-edge-net5-quality50-owned55-price5to97-v13',
    activatedAt: '2026-08-12T16:53:00.000Z',
    deactivatedAt: '2026-08-13T17:35:09.000Z',
    status: 'superseded',
    summary: 'Restored the symmetric 55% selected-side floor for live and paper after prospective v12 near-floor losses.',
    changes: ['Selected-side floor 52.5% → 55%', 'All other entry and execution controls unchanged'],
    evidence: ['reports/live-run-review-2026-08-12.md'],
  },
  {
    version: 'buy-binary-edge-net5-quality50-owned52.5-price5to97-v12',
    activatedAt: '2026-08-11T22:51:09.266Z',
    deactivatedAt: '2026-08-12T16:53:00.000Z',
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

const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;
const points = (value: number) => `${Number((value * 100).toFixed(2))}pp`;
const cents = (value: number) => `${Number((value * 100).toFixed(2))}¢`;
const seconds = (milliseconds: number) => `${milliseconds / 1000} seconds`;

/**
 * What production is running against what the promotion ledger can account for.
 *
 * `unrecorded` is the honest case and currently the real one: a model that predates the ledger, or was
 * changed without appending an entry, is running without a recorded justification. Reporting that
 * plainly is the point of publishing the record at all.
 */
function modelRecord(modelVersion: string, promotions: ModelPromotionEntry[]): PolicyManifestModel {
  const currentPromotion = activeModel(promotions);
  return {
    productionVersion: modelVersion,
    currentPromotion,
    unrecorded: currentPromotion?.modelVersion !== modelVersion,
    history: [...promotions].sort((a, b) => b.at.localeCompare(a.at)),
  };
}

export function activePolicyManifest(providers: TradingProviderDescriptor[], modelVersion: string, promotions: ModelPromotionEntry[] = []): PolicyManifest {
  const providerDetails = providers.flatMap((provider) => provider.variants.map((variant) => ({
    label: `${provider.name} · ${variant.name}`,
    value: `${variant.id} · ${provider.liveEnabled ? 'live + paper' : provider.paperEnabled ? 'paper only' : variant.status} · ${provider.adapterVersion}`,
  })));
  // Every configurable control is read from the same function execution uses, so a server-side
  // override can never leave this surface describing a policy the desk is not actually running.
  const regime = regimeGateSettings();
  const switchSettings = switchPolicySettings();
  const executionMode = parseEntryExecutionMode(process.env.MONEY_NOODLE_ENTRY_EXECUTION_MODE);
  const downEnabled = downEntryEnabled();
  const excluded = excludedAssets();
  const maximumEdge = maximumNetEdge();
  return {
    version: 'policy-manifest-v1',
    generatedAt: new Date().toISOString(),
    activeBuyPolicyVersion: BUY_POLICY_VERSION,
    activeBuyPolicyActivatedAt: history[0].activatedAt,
    components: [
      component('forecast', 'Forecast model', modelVersion, 'production', 'Venue-independent contract-basis probability.', [
        { label: 'Tradeable probability', value: 'No trading-provider price input' },
        { label: 'Basis log-odds weight', value: '0.55' },
        { label: 'Probability bounds', value: '3%–97%' },
      ]),
      component('buy', 'Binary buy policy', BUY_POLICY_VERSION, 'production', 'Positive expected value on the actionable ask, bounded above by a model-failure ceiling.', [
        { label: 'Selected-side probability', value: `≥${percent(MIN_SELECTED_SIDE_PROBABILITY)}` },
        { label: 'Net edge after fees', value: `≥${points(MIN_NET_EDGE)} and <${points(maximumEdge)}` },
        { label: 'Estimate quality', value: `≥${percent(MIN_ESTIMATE_QUALITY)}` },
        { label: 'Actionable ask', value: `${cents(MIN_ENTRY_PRICE)}–${cents(MAX_ENTRY_PRICE)}` },
        { label: 'Persistence', value: `${REQUIRED_QUALIFYING_SNAPSHOTS} snapshots spanning ${seconds(REQUIRED_OBSERVATION_SPAN_MS)}` },
        { label: 'Entry timing', value: `${EXECUTION_WARMUP_MS / 1000}-second warm-up; no entry in final ${EXECUTION_LATE_CUTOFF_MS / 1000} seconds` },
      ]),
      component('eligibility', 'Side and asset eligibility', 'side-and-asset-withholding-v2', 'production', 'Sides and assets withheld from new entry on their own measured evidence. One set of rules for live and paper alike: the mirror trades what live trades. Restrictive only — exits, reduce-only sells, and settlement of existing positions are unaffected.', [
        { label: 'DOWN/NO entry', value: downEnabled ? 'Permitted' : 'Suspended by operator switch' },
        { label: 'Assets withheld', value: excluded.join(', ') || 'None' },
        { label: 'Applies to', value: 'Live and paper identically' },
      ]),
      component('execution', 'Entry execution', ENTRY_EXECUTION_POLICY_VERSION, 'production', 'Maker-only live execution with separately measured taker shadows.', [
        { label: 'Production mode', value: executionMode === 'maker' ? 'Managed post-only maker' : executionMode === 'adaptive' ? 'Adaptive: may act on the taker recommendation' : 'Taker, retaining every hard gate' },
        { label: 'Live attempts per contract', value: `${maximumLiveMakerAttempts()}` },
        { label: 'Taker', value: executionMode === 'maker' ? 'Observation-only recommendation; capped IOC primitive' : 'Executable when every strict gate clears' },
      ]),
      component('exit', 'Standalone exits', standaloneExitPolicyVersion(), 'production', 'Reduce-only value exits, with armed profit reversal recorded whether or not it may sell.', [
        { label: 'Strict value margin', value: `${STRICT_EXIT_MIN_GAIN_CENTS}¢` },
        { label: 'Profit lock arms', value: `+${PROFIT_REVERSAL_ARM_PERCENT * 100}% executable profit` },
        { label: 'Profit reversal exit', value: profitReversalExitEnabled() ? 'Executable' : 'Withheld on its own evidence; armed downturns are recorded only' },
        { label: 'Re-entry cooldown', value: `${seconds(POST_EXIT_REENTRY_COOLDOWN_MS)} plus fresh evidence` },
      ]),
      component('switch', 'Switch policy', SWITCH_POLICY_VERSION, 'production', 'Reduce-only replacement only when future wealth and probability advantage are positive.', [
        { label: 'Replacement advantage', value: points(switchSettings.minimumProbabilityAdvantage) },
        { label: 'Same-asset reversal', value: points(switchSettings.minimumOppositeSideAdvantage) },
        { label: 'Cooldown after a switch', value: `${switchSettings.cooldownSeconds} seconds` },
        { label: 'Persistence', value: `${REQUIRED_SWITCH_SNAPSHOTS} snapshots spanning ${seconds(REQUIRED_SWITCH_SPAN_MS)}` },
      ]),
      component('regime', 'Adaptive regime gate', REGIME_GATE_POLICY_VERSION, regime.enabled ? 'production' : 'observation', 'Soft entry gate over current-policy exact-contract sentinel windows. Evidence is scoped to the active buy policy, so a policy change restarts warm-up and the gate permits entries until it is warm again.', [
        { label: 'Status', value: regime.enabled ? 'Enabled' : 'Disabled; entries are not gated' },
        { label: 'Warm-up', value: `${regime.minimumPolicyWindows} policy windows` },
        { label: 'Pause confidence', value: percent(regime.pauseConfidence) },
        { label: 'Resume confidence', value: percent(regime.resumeConfidence) },
        { label: 'Evidence half-life', value: `${regime.evidenceHalfLifeWindows} windows` },
      ]),
      component('provider', 'Trading-provider variants', TRADING_PROVIDER_REGISTRY_VERSION, 'observation', 'Explicit provider capabilities and immutable semantic/execution variant identities.', providerDetails),
    ],
    history,
    model: modelRecord(modelVersion, promotions),
  };
}
