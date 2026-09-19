/**
 * Allowlisting and redaction for everything that reaches a telemetry payload.
 *
 * Two independent rules, because either alone is insufficient:
 *
 *   1. An attribute key not on the allowlist is dropped. Telemetry carries the
 *      fields we decided to carry, not whatever an instrumentation library
 *      happens to attach.
 *   2. A value matching a sensitive shape is replaced even when its key is
 *      allowlisted, because an allowlisted field can still receive a value it
 *      should not. The replacement names the shape, never the value.
 *
 * This is a deliberate re-implementation of the same shape families that
 * `tools/delivery/sanitize.mjs` refuses. Application code cannot import from
 * `tools/**` — that boundary is enforced by lint — so the rule is stated twice
 * and asserted in both places rather than shared through a new package.
 */

export const REDACTED = '[redacted]';

/**
 * Span event names that may be exported.
 *
 * Deliberately narrow. An exception event's name and attributes carry a
 * provider or application message, which is exactly what must not leave; an
 * event whose name is not listed here is dropped rather than renamed, because a
 * renamed event still carries its attributes.
 */
export const ALLOWED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'money_noodle.export.dropped',
  'money_noodle.upstream.timeout',
]);

/**
 * Span and log attribute keys that may be exported.
 *
 * Route templates, not raw URLs; status codes, not bodies; correlation
 * identifiers, not headers.
 */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'money_noodle.export.outcome',
  'money_noodle.image_digest',
  'money_noodle.request_id',
  'money_noodle.source_commit',
  'money_noodle.upstream.outcome',
  'otel.status_code',
  'server.address',
  'service.instance.id',
  'service.name',
  'service.version',
  'deployment.environment.name',
  'error.type',
]);

/**
 * Metric dimensions. Strictly narrower than span attributes: a request or trace
 * identifier as a metric label is unbounded cardinality, so neither appears
 * here and `assertBoundedMetricAttributes` refuses them outright.
 */
export const ALLOWED_METRIC_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'money_noodle.export.outcome',
  'money_noodle.signal',
]);

const UNBOUNDED_METRIC_KEYS: ReadonlySet<string> = new Set([
  'money_noodle.request_id',
  'trace_id',
  'span_id',
  'traceparent',
  'user.id',
]);

/** Value shapes that must never reach a telemetry payload, named by kind. */
const SENSITIVE_SHAPES: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: 'bearer-header', pattern: /\bBearer\s+\S{8,}/iu },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/u },
  { kind: 'google-oauth-token', pattern: /\bya29\.[A-Za-z0-9._-]{10,}/u },
  { kind: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/u },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u },
  { kind: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { kind: 'credentialed-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu },
  { kind: 'service-account-member', pattern: /\b[\w.+-]+@[\w-]+\.iam\.gserviceaccount\.com/u },
  { kind: 'native-project-path', pattern: /\bprojects\/[^/\s"]+\/(?:locations|secrets)\//u },
  { kind: 'cloud-run-url', pattern: /https:\/\/[A-Za-z0-9-]+\.[a-z0-9-]+\.run\.app/u },
  { kind: 'provider-etag', pattern: /\betag"?\s*[:=]\s*"/iu },
  {
    kind: 'raw-plan-payload',
    pattern: /"(?:resource_changes|prior_state|terraform_version)"\s*:/u,
  },
  { kind: 'query-string', pattern: /\?[\w.-]+=/u },
  { kind: 'cookie', pattern: /\b(?:cookie|set-cookie)\s*:/iu },
];

/** The sensitive shape kinds found in `value`, without ever returning the value. */
export function findSensitiveShapes(value: unknown): readonly string[] {
  if (typeof value !== 'string') return [];
  return SENSITIVE_SHAPES.filter(({ pattern }) => pattern.test(value)).map(({ kind }) => kind);
}

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, unknown>>;

function boundedValue(value: unknown, maxLength: number): AttributeValue | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  const shapes = findSensitiveShapes(value);
  // The kind is reportable; the value is not. This is the only place a
  // sensitive value is replaced, and it is replaced rather than truncated,
  // because a truncated credential is still a disclosed credential prefix.
  if (shapes.length > 0) return `${REDACTED}:${shapes.join(',')}`;

  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Applies the allowlist, the value bound and the sensitive-shape rule.
 *
 * Runs before buffering and again before serialization, because an attribute
 * can be attached by automatic instrumentation after the first pass.
 */
export function redactAttributes(
  attributes: Attributes,
  options: {
    readonly allowed?: ReadonlySet<string>;
    readonly maxCount: number;
    readonly maxLength: number;
  },
): Record<string, AttributeValue> {
  const allowed = options.allowed ?? ALLOWED_ATTRIBUTE_KEYS;
  const result: Record<string, AttributeValue> = {};
  let count = 0;

  for (const key of Object.keys(attributes).sort()) {
    if (count >= options.maxCount) break;
    if (!allowed.has(key)) continue;
    const value = boundedValue(attributes[key], options.maxLength);
    if (value === undefined) continue;
    result[key] = value;
    count += 1;
  }

  return result;
}

/**
 * Span names are exported verbatim, so they are allowlisted too.
 *
 * A name that is not a known route template or operation becomes its kind,
 * which keeps an automatically generated name carrying a raw URL out of the
 * payload.
 */
export function redactSpanName(name: string, allowedNames: ReadonlySet<string>): string {
  if (allowedNames.has(name)) return name;
  if (findSensitiveShapes(name).length > 0) return REDACTED;
  // Framework-generated names are kept only in their bounded, template form.
  return /^[A-Za-z][A-Za-z0-9 ._/{}-]{0,63}$/u.test(name) ? name : REDACTED;
}

/**
 * Refuses a metric attribute set that is unbounded by construction.
 *
 * Returns the bounded set; throwing here would turn a telemetry mistake into an
 * application failure, which the degradation rule forbids.
 */
export function boundMetricAttributes(attributes: Attributes): Record<string, AttributeValue> {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(attributes)) {
    if (UNBOUNDED_METRIC_KEYS.has(key)) continue;
    filtered[key] = attributes[key];
  }
  return redactAttributes(filtered, {
    allowed: ALLOWED_METRIC_ATTRIBUTE_KEYS,
    maxCount: 6,
    maxLength: 64,
  });
}
