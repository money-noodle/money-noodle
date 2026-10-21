// Pure design only: no store, current configuration, funding mutation or runtime wiring.
import {
  PAPER_HISTORICAL_REGIME_CONTRACT,
  PAPER_RESTRICTIVE_REGIME_PROPOSAL,
} from './paper-regime.js';
import { paperExactRegimeSourceWithinDomains } from './paper-bound-decimal.js';
import type { PaperGateGenerationInputs } from './paper-gate-write.js';
export const MAX_PAPER_CONFIG_CENTS_V1 = 1_000_000;
export const PAPER_POLICY_BUNDLE_V1 = 'paper-v1-blend04-neutral-v7';
/**
 * The ONE recognised configure document: version 2, nineteen scalar fields.
 *
 * Twelve describe the simulated budget exactly as version 1 did. The seven `regime_*`
 * fields carry the generation profile the persisted gate writer needs, which is
 * operator-recorded per budget rather than defaulted in code (D1 = A). There is no
 * version 1 any more: a document still declaring version `1` is REFUSED as
 * `configuration-invalid`, never upgraded, defaulted or back-filled, because inventing a
 * profile for a recorded intent would invent authority nobody granted.
 *
 * Every bound mirrors migration 0006; the three decimal fields are decided by the shared
 * exact-decimal helper, on the digits, with the gate writer's own text grammar — so
 * `'2.50'`, `'08'` and `'0.970'` are accepted when their VALUES are in bounds, and no
 * canonical-spelling or precision cap is introduced here. No value is chosen.
 */
export interface PaperConfigurationV2 {
  paper_config_version: 2;
  budget_id: string;
  funding_id: string;
  total_cap_cents: number;
  entry_cap_cents: number;
  kalshi_cap_cents: number;
  polymarket_cap_cents: number;
  kalshi_market_percent: number;
  polymarket_market_percent: number;
  paper_providers: 'none' | 'kalshi' | 'polymarket' | 'kalshi-polymarket';
  market_id: 'crypto-15m';
  policy_bundle: typeof PAPER_POLICY_BUNDLE_V1;
  /** One of the two bundle constants, never a retyped literal. */
  regime_bundle_id:
    typeof PAPER_RESTRICTIVE_REGIME_PROPOSAL | typeof PAPER_HISTORICAL_REGIME_CONTRACT;
  regime_profile_claim: string;
  regime_enabled: boolean;
  regime_minimum_policy_windows: number;
  /** Fractional profile fields travel as plain decimal TEXT, not JSON numbers, so the
   * operator's recorded digits reach `numeric` unchanged: a binary64 round trip between
   * the record and the column would silently move the value. */
  regime_evidence_half_life_windows: string;
  regime_pause_confidence: string;
  regime_resume_confidence: string;
}
const keys = [
  'paper_config_version',
  'budget_id',
  'funding_id',
  'total_cap_cents',
  'entry_cap_cents',
  'kalshi_cap_cents',
  'polymarket_cap_cents',
  'kalshi_market_percent',
  'polymarket_market_percent',
  'paper_providers',
  'market_id',
  'policy_bundle',
  'regime_bundle_id',
  'regime_profile_claim',
  'regime_enabled',
  'regime_minimum_policy_windows',
  'regime_evidence_half_life_windows',
  'regime_pause_confidence',
  'regime_resume_confidence',
] as const;
function exactRecord(
  value: unknown,
  required: readonly string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === required.length &&
    required.every((k) => Object.hasOwn(record, k))
    ? record
    : undefined;
}
const identity = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 120 && v.trim() === v;
export function decodePaperConfiguration(value: unknown): PaperConfigurationV2 | undefined {
  const r = exactRecord(value, keys);
  if (
    !r ||
    r.paper_config_version !== 2 ||
    !identity(r.budget_id) ||
    !identity(r.funding_id) ||
    r.market_id !== 'crypto-15m' ||
    r.policy_bundle !== PAPER_POLICY_BUNDLE_V1 ||
    typeof r.paper_providers !== 'string' ||
    !['none', 'kalshi', 'polymarket', 'kalshi-polymarket'].includes(r.paper_providers)
  )
    return undefined;
  for (const key of [
    'total_cap_cents',
    'entry_cap_cents',
    'kalshi_cap_cents',
    'polymarket_cap_cents',
  ] as const) {
    const v = r[key];
    if (
      typeof v !== 'number' ||
      !Number.isSafeInteger(v) ||
      v < (key === 'total_cap_cents' || key === 'entry_cap_cents' ? 1 : 0) ||
      v > MAX_PAPER_CONFIG_CENTS_V1
    )
      return undefined;
  }
  if (
    (r.entry_cap_cents as number) > (r.total_cap_cents as number) ||
    (r.kalshi_cap_cents as number) > (r.total_cap_cents as number) ||
    (r.polymarket_cap_cents as number) > (r.total_cap_cents as number)
  )
    return undefined;
  for (const key of ['kalshi_market_percent', 'polymarket_market_percent'] as const)
    if (
      typeof r[key] !== 'number' ||
      !Number.isSafeInteger(r[key]) ||
      (r[key] as number) < 0 ||
      (r[key] as number) > 100
    )
      return undefined;
  // The generation profile. The bundle identifiers are the code constants themselves, so
  // a renamed bundle cannot drift from the literal a document carries; the integer and
  // text bounds are 0006's; and the three decimals go through the SHARED exact helper,
  // which owns those bound literals and decides the `resume <= pause - 0.01` margin on
  // digits rather than on a binary64 subtraction.
  if (
    (r.regime_bundle_id !== PAPER_RESTRICTIVE_REGIME_PROPOSAL &&
      r.regime_bundle_id !== PAPER_HISTORICAL_REGIME_CONTRACT) ||
    !identity(r.regime_profile_claim) ||
    typeof r.regime_enabled !== 'boolean' ||
    typeof r.regime_minimum_policy_windows !== 'number' ||
    !Number.isSafeInteger(r.regime_minimum_policy_windows) ||
    r.regime_minimum_policy_windows < 4 ||
    r.regime_minimum_policy_windows > 500 ||
    !paperExactRegimeSourceWithinDomains({
      evidenceHalfLifeWindows: r.regime_evidence_half_life_windows,
      pauseConfidence: r.regime_pause_confidence,
      resumeConfidence: r.regime_resume_confidence,
    })
  )
    return undefined;
  // Decoder recognizes design syntax only; recognition is never bundle admission.
  return r as unknown as PaperConfigurationV2;
}
/**
 * The decoded profile as the persisted gate writer's generation inputs: a field-for-field
 * rename and nothing else. Nothing is computed, defaulted, rounded or substituted, and no
 * bound is re-decided — a document that reaches this function already satisfied the
 * decoder, which uses the same shared helper the writer's own validator uses.
 *
 * Calling this is not write admission: the production lane constructs no gate writer and
 * production bundle availability stays `false`.
 */
export function generationInputsFromConfiguration(
  config: PaperConfigurationV2,
): PaperGateGenerationInputs {
  return {
    bundleId: config.regime_bundle_id,
    profileClaim: config.regime_profile_claim,
    enabled: config.regime_enabled,
    minimumPolicyWindows: config.regime_minimum_policy_windows,
    evidenceHalfLifeWindows: config.regime_evidence_half_life_windows,
    pauseConfidence: config.regime_pause_confidence,
    resumeConfidence: config.regime_resume_confidence,
  };
}
export interface PaperAuthorityIntent {
  id: string;
  epoch: number;
  actor: string;
  capability: string;
  action: 'configure' | 'resume' | 'pause' | 'reset' | 'provider-enable';
  parameters: unknown;
}
/** Supplied by a coherent DB snapshot with DB-precision ordering, never a 50-row history page.
 * latest is GLOBAL latest for capability, not latest filtered to current epoch; newest configure
 * remains present even when malformed. afterReset/order booleans must be derived in PostgreSQL.
 */
export interface PaperAuthoritySnapshot {
  complete: boolean;
  epoch: number;
  latest: PaperAuthorityIntent | undefined;
  latestTimeValid: boolean;
  configure: PaperAuthorityIntent | undefined;
  configureTimeValid: boolean;
  configureAtOrBeforeLatest: boolean;
  configureAfterReset: boolean;
  funding: { id: string; budgetId: string; epoch: number; conserved: boolean } | undefined;
}
export type PaperAuthorityDecision =
  | { allowed: false; reason: string }
  | { allowed: true; config: PaperConfigurationV2; configIntentId: string; latestIntentId: string };
// Full immutable policy closure is NOT audited. Production admission remains unavailable.
export const COMPILED_PAPER_BUNDLE_AVAILABLE = false;
export function evaluatePaperAuthority(
  snapshot: PaperAuthoritySnapshot,
  auditedBundleAvailable: boolean = COMPILED_PAPER_BUNDLE_AVAILABLE,
): PaperAuthorityDecision {
  const refuse = (reason: string): PaperAuthorityDecision => ({ allowed: false, reason });
  const latest = snapshot.latest,
    configure = snapshot.configure;
  if (
    snapshot.complete !== true ||
    !Number.isSafeInteger(snapshot.epoch) ||
    snapshot.epoch < 1 ||
    !latest ||
    snapshot.latestTimeValid !== true ||
    latest.epoch !== snapshot.epoch ||
    latest.capability !== 'budget:paper'
  )
    return refuse('latest-authority-invalid');
  if (latest.action !== 'configure' && latest.action !== 'resume') return refuse('paused');
  if (
    !configure ||
    snapshot.configureTimeValid !== true ||
    snapshot.configureAtOrBeforeLatest !== true ||
    snapshot.configureAfterReset !== true ||
    configure.action !== 'configure' ||
    configure.epoch !== snapshot.epoch ||
    configure.capability !== 'budget:paper' ||
    configure.actor !== latest.actor ||
    !identity(configure.actor) ||
    !identity(configure.id) ||
    !identity(latest.id)
  )
    return refuse('configure-authority-invalid');
  const config = decodePaperConfiguration(configure.parameters);
  if (!config || config.budget_id !== configure.actor + ':paper')
    return refuse('configuration-invalid');
  if (latest.action === 'configure' && latest.id !== configure.id)
    return refuse('configure-not-latest');
  if (latest.action === 'resume') {
    const ref = exactRecord(latest.parameters, ['paper_config_version', 'config_intent_id']);
    if (!ref || ref.paper_config_version !== 2 || ref.config_intent_id !== configure.id)
      return refuse('resume-reference-invalid');
  }
  const funding = snapshot.funding;
  if (
    !funding ||
    funding.conserved !== true ||
    funding.id !== config.funding_id ||
    funding.budgetId !== config.budget_id ||
    funding.epoch !== snapshot.epoch
  )
    return refuse('funding-invalid');
  if (auditedBundleAvailable !== true) return refuse('bundle-unavailable');
  return { allowed: true, config, configIntentId: configure.id, latestIntentId: latest.id };
}
export function paperProviderWithheld(
  config: PaperConfigurationV2,
  provider: 'kalshi' | 'polymarket',
): boolean {
  const named =
    config.paper_providers === provider || config.paper_providers === 'kalshi-polymarket';
  return (
    !named ||
    config[provider === 'kalshi' ? 'kalshi_cap_cents' : 'polymarket_cap_cents'] === 0 ||
    config[provider === 'kalshi' ? 'kalshi_market_percent' : 'polymarket_market_percent'] === 0
  );
}
