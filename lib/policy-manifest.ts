import { excludedAssets } from './asset-exclusion';
import { maximumEdgeSpike } from './edge-spike-policy';
import { PRODUCTION_BASIS_LOG_ODDS_WEIGHT } from './calibration-replay';
import { MAX_TRADEABLE_PROBABILITY, MIN_TRADEABLE_PROBABILITY } from './dashboard';
import { classifiedRegimeRequired } from './paper-execution';
import { ADAPTIVE_ENTRY_ATTEMPTS, ENTRY_EXECUTION_POLICY_VERSION, HIGH_EDGE_TAKER_THRESHOLD, parseEntryExecutionMode } from './entry-execution-policy';
import { ENTRY_SIZING_POLICY_VERSION, FULL_SIZE_EDGE_THRESHOLD, REDUCED_ENTRY_MULTIPLIER } from './entry-sizing-policy';
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
    version: 'buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21',
    activatedAt: '2026-08-19T00:45:00.000Z',
    status: 'active',
    summary: 'Promoted the two-snapshot persistence candidate and configured gated maker/taker execution; the intended unconditional taker switch was not implemented.',
    changes: [
      'REQUIRED_QUALIFYING_SNAPSHOTS 3 -> 2 and REQUIRED_OBSERVATION_SPAN_MS 30s -> 15s, promoting persistence-two-consecutive-v1',
      'Configured MONEY_NOODLE_ENTRY_EXECUTION_MODE=taker; evaluateEntryExecutionPolicy still retains maker whenever any strict taker gate fails, so this is selective rather than take-every-ask execution',
      'No change to the edge bounds, side floor, quality floor, price band, warm-up or late cutoff that v20 set',
      'Known cost accepted: the version bump discards the accumulated adaptive-regime windows and re-warms',
    ],
    // **The persistence half is the first entry change this desk has made on prospectively committed
    // evidence rather than a retroactive screen**, which is the bar SPEC 12.5 sets and which the withdrawn
    // v14 DOWN suspension failed. `persistence-two-consecutive-v1` holds 553 resolved incremental
    // settlement windows at +13.2% +/-8.4 per $1 at the ask, and the value is concentrated in the 227
    // production never took at all (+23.5% +/-13.0) rather than in the half it reached a median 17 seconds
    // later (+6.5% +/-11.1, indistinguishable from noise). Under the version-scoping rule only the v19
    // cohort formally counted — 92 windows, +16.0% +/-19.9 — and this is promoted on the pooled figure,
    // which is a departure recorded here rather than buried.
    //
    // What it fixes is larger than the entry rule. A single non-qualifying snapshot resets the streak to
    // zero, so at the collector's ~17s cadence one blip cost ~51 seconds of re-earning: measured over 12
    // hours, 115 of 205 admitted decisions never persisted at all.
    //
    // **The taker half reverses reports/take-the-ask-2026-08-18.md, and the reason is a changed
    // constraint rather than changed data.** That report priced arm C — take the ask on every decision —
    // and set it aside because it "assumes capacity the hourly order ceiling and budget would not have
    // given". The same evening raised positions 3 -> 9, same-window 2 -> 6, per-group 1 -> 3, and made
    // runLive drain its ranked queue instead of placing one order per cycle, so that capacity now exists.
    // Priced under v19: arm C returned -3.7% +/-13.4 live and -1.8% +/-13.5 paper against -13.1% and
    // -24.6% for what the desk actually did.
    //
    // Stated plainly: paying the spread *costs* about 7pp on the trades the maker would have filled
    // anyway (arm B -14.3% against arm A2 -7.6%). Taking wins only by converting the other half, which is
    // the half the maker was adversely selected out of. Capital deployed roughly doubles. Arm C is the
    // best arm measured, not a profitable one — it is still negative per dollar.
    //
    // The two halves were intended to ship together because the persistence evidence is ask-priced. The
    // 2026-08-19 audit found that `taker` and `adaptive` execute the same gated recommendation, so the
    // unconditional arm C described above was not actually deployed. History states the discrepancy rather
    // than rewriting the counterfactual rationale as though it happened.
    evidence: [
      'data/persistence-candidate.json · 553 resolved incremental windows, +13.2% +/-8.4; never-eligible half +23.5% +/-13.0',
      'npm run analyze:take-the-ask · v19 arm C -3.7% live and -1.8% paper against -13.1% and -24.6% as traded',
      'npm run analyze:execution-gap · 115 of 205 admitted decisions never persisted over 12 hours',
      'SPEC.md 12.5 · promotion requires committed sentinel evidence and is a manual act',
    ],
  },
  {
    version: 'buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-v20',
    activatedAt: '2026-08-18T23:30:00.000Z',
    deactivatedAt: '2026-08-19T00:45:00.000Z',
    status: 'superseded',
    summary: 'Admitted substantially more entries: the net-edge floor to −5pp, the ceiling off, and the late cutoff from 120s to 30s. An operator decision to trade volume the measurement says is profitable, accepting an execution risk the measurement does not cover.',
    changes: [
      'MIN_NET_EDGE 5pp → −5pp; the 402 decisions this admits returned +17.5% ±6.5 held to settlement',
      'MAX_NET_EDGE default 35pp → 1, disarming the ceiling; re-arm with MONEY_NOODLE_MAX_NET_EDGE=0.35',
      'EXECUTION_LATE_CUTOFF_MS 120s → 30s; the 248 decisions this admits returned +19.8% ±12.0, positive on 8 of 8 days',
      'No change to the selected-side floor, the quality floor, the price band, warm-up, or persistence',
      'Known cost accepted: the version bump discards the accumulated adaptive-regime windows and re-warms',
    ],
    // Put in writing at the operator's instruction, and the parts that are not established are named
    // rather than folded into the summary.
    //
    // What the evidence does support: measured over 8 days, the combined increment is 686 decisions at
    // +32.4% ±10.5 per window and +20.2% stake-weighted, positive on 8 of 8 days. 537 of those are
    // ordinary 50–85c contracts carrying 73% of the profit, where the per-window and stake-weighted views
    // agree to within a point — so it is not an artefact of weighting, and it is not tail-driven: the best
    // ten decisions are 11% of the total. The prior objection that capacity would make this substitutional
    // rather than additive was refuted by measurement: the desk sat at its 3-position cap on 0 of 67 v19
    // orders and 3 of 348 since v17.
    //
    // What it does not support, stated plainly:
    //   - Under the durability proxy the same increment falls from +20.2% to +10.3% ±10.8. The relaxed
    //     floor admits edges that may not survive contact with a resting order.
    //   - Every figure is at the ask, held to settlement. Production rests a maker order and fills about
    //     half the time, adversely selected. None of this measures what these entries would fill at.
    //   - The 30-second cutoff is the piece with an operational risk the measurement cannot see: no time
    //     to reprice, no retry inside 120s, and no time to exit. Exit availability there is 64% against
    //     82% for the population.
    //   - Eight days, one venue, one strategy. The edge-floor increment exists on only three of them.
    //
    // This is an operator decision taken with all of that stated. Every safety control remains in force:
    // environment gating, typed-confirmation arming, the per-trade all-in cap, rate limits, the kill
    // switch, reduce-only exits, and reconciliation before execution. Nothing here relaxes one, and the
    // decision is reversible by restoring the three constants.
    evidence: [
      'reports/missed-entry-review-2026-08-18.md · gate relaxations scored against the live rule',
      'npm run analyze:missed-entries §2c-2d · increment worth +81c over 8 days; 73% from 50-85c contracts',
      'npm run analyze:contract-selection · at the 3-position cap on 0 of 67 v19 orders, so the slots are empty',
      'reports/loss-decomposition-2026-08-18.md · v19 contract selection −21.8pp, fill selection −8.4pp',
    ],
  },
  {
    version: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v19',
    activatedAt: '2026-08-18T22:00:00.000Z',
    deactivatedAt: '2026-08-18T23:30:00.000Z',
    status: 'superseded',
    summary: 'Disarmed the edge-spike refusal by operator decision, against the direction of its own sentinel. The spike is still measured on every decision.',
    changes: [
      'The spike gate no longer refuses an entry; `edgeSpikeGateEnabled` is off unless MONEY_NOODLE_EDGE_SPIKE_GATE=true',
      'edge-spike-sentinel-v1 keeps recording the spike on every decision, admitted or refused, so the question stays answerable',
      'No other rule changes: edge bounds, quality floor, side floor, price bounds and persistence are v17/v18 unchanged',
      'Known cost accepted again: a version bump discards the accumulated adaptive-regime windows and re-warms',
    ],
    // Recorded plainly because the evidence did not ask for this. Over 52 graded sentinels the gate
    // refused 7, and those refusals returned -24.4% against -7.2% for admitted decisions — +17.2pp in the
    // gate's favour at t=0.43, directionally supportive and far from conclusive. v18's book was not
    // measurably worse than v17's (t=-1.36 paper, -0.41 live, n=37/44 over two days), so "v18 is
    // underperforming" is not established either. This is an operator decision taken with that stated,
    // and it is reversible through the environment variable without a further bump. The sentinel is
    // deliberately left running so re-arming can be justified by evidence rather than re-argued.
    evidence: [
      'reports/fill-selection-robustness-2026-08-18.md · the v17 diagnosis is unstable across specifications',
      'reports/edge-magnitude-2026-08-18.md · three reversals in one session; surviving effects at t=1.5-1.7',
      'data/edge-spike-sentinels.json · 52 graded decisions, 7 refused, admitted minus refused +17.2pp (t=0.43)',
    ],
  },
  {
    version: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-fresh2pp-v18',
    activatedAt: '2026-08-17T08:00:00.000Z',
    deactivatedAt: '2026-08-18T22:00:00.000Z',
    status: 'superseded',
    summary: 'Refused entries whose edge had just spiked above its own persistence median — made on an asymmetry, not on evidence clearing a bar.',
    changes: [
      'An entry is refused when its net edge sits 2pp or more above the median of its qualifying snapshots',
      'The ceiling is a declared member of the persistence requirements, so a candidate lane states it rather than inheriting it',
      'Restrictive only: it can refuse an entry, never authorize one, and tunes through MONEY_NOODLE_MAX_EDGE_SPIKE',
      'edge-spike-sentinel-v1 records every decision reaching the gate, admitted or refused, at decision time',
      'Known cost accepted: the version bump discards 156 accumulated v17 adaptive-regime windows and permits entries for 12 windows while it re-warms',
    ],
    // The bar this does not clear is stated deliberately. The threshold was chosen after inspecting the
    // bins, on three days, with paper's own clustered interval spanning zero — retroactive screening,
    // which §5.5 says promotes nothing. What authorizes it is that declining this volume costs roughly
    // nothing while the book is negative, and not declining it costs real money if the effect is real.
    // The sentinel exists so the figure is recomputed prospectively rather than re-argued from the
    // script that produced it, which is precisely how the v14 DOWN suspension failed.
    evidence: [
      'reports/edge-policy-review-2026-08-17.md §3 · Edge spikes, 34.0% against 58.7% over 228 decisions',
      'docs/edge-spike-sentinel-design.md §2 · Made on an asymmetry; rollback criterion',
    ],
  },
  {
    version: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v17',
    activatedAt: '2026-08-14T01:05:00.000Z',
    deactivatedAt: '2026-08-17T08:00:00.000Z',
    status: 'superseded',
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
  const spikeCeiling = maximumEdgeSpike();
  const classifiedRequired = classifiedRegimeRequired();
  return {
    version: 'policy-manifest-v1',
    generatedAt: new Date().toISOString(),
    activeBuyPolicyVersion: BUY_POLICY_VERSION,
    activeBuyPolicyActivatedAt: history[0].activatedAt,
    components: [
      component('forecast', 'Forecast model', modelVersion, 'production', 'Venue-independent contract-basis probability.', [
        { label: 'Tradeable probability', value: 'No trading-provider price input' },
        { label: 'Basis log-odds weight', value: `${PRODUCTION_BASIS_LOG_ODDS_WEIGHT}` },
        { label: 'Probability bounds', value: `${percent(MIN_TRADEABLE_PROBABILITY)}–${percent(MAX_TRADEABLE_PROBABILITY)}` },
      ]),
      component('buy', 'Binary buy policy', BUY_POLICY_VERSION, 'production', 'Positive expected value on the actionable ask, bounded above by a model-failure ceiling.', [
        { label: 'Selected-side probability', value: `≥${percent(MIN_SELECTED_SIDE_PROBABILITY)}` },
        { label: 'Net edge after fees', value: `≥${points(MIN_NET_EDGE)} and <${points(maximumEdge)}` },
        { label: 'Estimate quality', value: `≥${percent(MIN_ESTIMATE_QUALITY)}` },
        { label: 'Actionable ask', value: `${cents(MIN_ENTRY_PRICE)}–${cents(MAX_ENTRY_PRICE)}` },
        { label: 'Persistence', value: `${REQUIRED_QUALIFYING_SNAPSHOTS} snapshots spanning ${seconds(REQUIRED_OBSERVATION_SPAN_MS)}` },
        { label: 'Signal freshness', value: `Edge must sit under ${points(spikeCeiling)} above its persistence median` },
        { label: 'Entry timing', value: `${EXECUTION_WARMUP_MS / 1000}-second warm-up; no entry in final ${EXECUTION_LATE_CUTOFF_MS / 1000} seconds` },
      ]),
      component('eligibility', 'Side and asset eligibility', 'side-and-asset-withholding-v2', 'production', 'Sides and assets withheld from new entry on their own measured evidence. One set of rules for live and paper alike: the mirror trades what live trades. Restrictive only — exits, reduce-only sells, and settlement of existing positions are unaffected.', [
        { label: 'DOWN/NO entry', value: downEnabled ? 'Permitted' : 'Suspended by operator switch' },
        { label: 'Assets withheld', value: excluded.join(', ') || 'None' },
        { label: 'Applies to', value: 'Live and paper identically' },
      ]),
      component('execution', 'Entry execution', ENTRY_EXECUTION_POLICY_VERSION, 'production', executionMode === 'maker'
        ? 'Maker-only live execution with separately measured high-edge taker shadows.'
        : 'One live attempt: fresh 30pp+ edges may take; every lower edge receives one managed maker.', [
        { label: 'Production mode', value: executionMode === 'maker' ? 'Managed post-only maker' : 'High-edge adaptive maker/taker' },
        { label: 'High-edge route', value: `Issuance and refreshed taker edge ≥${points(HIGH_EDGE_TAKER_THRESHOLD)}; median ≥10pp; quality ≥65%; spread ≤2¢` },
        { label: 'Ordinary route', value: `Below ${points(HIGH_EDGE_TAKER_THRESHOLD)}: one managed maker; zero-fill ends the sequence` },
        { label: 'Pre-submit ask movement', value: '≤1.0¢; fresh quote re-runs gates, all-in reserve uses worst price' },
        { label: 'Live attempts per contract', value: `${executionMode === 'adaptive' ? ADAPTIVE_ENTRY_ATTEMPTS : maximumLiveMakerAttempts()}` },
        { label: 'Sizing policy', value: ENTRY_SIZING_POLICY_VERSION },
        { label: 'Sizing', value: `${REDUCED_ENTRY_MULTIPLIER}× below ${points(FULL_SIZE_EDGE_THRESHOLD)}; 1× at or above; no upsizing` },
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
      // Two distinct regime gates run, and only the adaptive one was described here until 2026-08-16.
      // The classifier gate is restrictive, on by default, and refuses roughly 15% of windows, so
      // omitting it left this surface understating what the desk declines to trade.
      component('regime-classification', 'Path-classification gate', 'classified-regime-required-v1',
        classifiedRequired ? 'production' : 'observation',
        'Hard entry gate on the 15-second cycle path. A window the classifier cannot characterise is refused rather than traded on an unclassified path. Restrictive only — it can remove entries, never add exposure.', [
          { label: 'Status', value: classifiedRequired ? 'Enabled; unclassified windows are refused' : 'Disabled; unclassified windows may be traded' },
          { label: 'Refuses', value: 'Windows whose regime is `insufficient` or unrecorded' },
          { label: 'Operator switch', value: 'MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME' },
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
