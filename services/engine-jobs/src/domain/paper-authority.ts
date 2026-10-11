// Pure design only: no store, current configuration, funding mutation or runtime wiring.
export const MAX_PAPER_CONFIG_CENTS_V1 = 1_000_000;
export const PAPER_POLICY_BUNDLE_V1 = 'paper-v1-blend04-neutral-v7';
export interface PaperConfigurationV1 {
  paper_config_version: 1;
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
export function decodePaperConfiguration(value: unknown): PaperConfigurationV1 | undefined {
  const r = exactRecord(value, keys);
  if (
    !r ||
    r.paper_config_version !== 1 ||
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
  // Decoder recognizes design syntax only; recognition is never bundle admission.
  return r as unknown as PaperConfigurationV1;
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
  | { allowed: true; config: PaperConfigurationV1; configIntentId: string; latestIntentId: string };
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
    snapshot.epoch < 0 ||
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
    if (!ref || ref.paper_config_version !== 1 || ref.config_intent_id !== configure.id)
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
  config: PaperConfigurationV1,
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
