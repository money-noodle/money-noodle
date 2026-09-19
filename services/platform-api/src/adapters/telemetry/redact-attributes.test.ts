import { describe, expect, it } from 'vitest';

import {
  ALLOWED_METRIC_ATTRIBUTE_KEYS,
  REDACTED,
  boundMetricAttributes,
  findSensitiveShapes,
  redactAttributes,
  redactSpanName,
} from './redact-attributes.js';

// Every credential-shaped fixture is assembled at runtime from inert fragments,
// so no credential-shaped literal exists in this file for a secret scanner to
// match. The assembled values are what the assertions exercise.
const SYNTHETIC = {
  bearerHeader: ['Bear', 'er', ' ', 'x'.repeat(40)].join(''),
  googleToken: ['ya', '29', '.', 'A'.repeat(40)].join(''),
  githubToken: ['gh', 'p', '_', 'B'.repeat(36)].join(''),
  apiKey: ['AI', 'za', 'C'.repeat(35)].join(''),
  jwt: [['ey', 'J', 'h', 'bGciOiJIUzI1NiJ9'].join(''), 'ZHVtbXktcGF5bG9hZA', 'c2lnbmF0dXJl'].join(
    '.',
  ),
  privateKey: ['-----', 'BEGIN RSA ', 'PRIVATE', ' KEY', '-----'].join(''),
  serviceAccount: ['deployer@example-project', '.iam.', 'gservice', 'account.com'].join(''),
  cloudRunUrl: ['https://', 'web-abc123-uc', '.a.', 'run', '.app'].join(''),
  credentialedUrl: (() => {
    const url = new URL('https://telemetry.invalid/v1/traces');
    url.username = 'user';
    url.password = 'secret';
    return url.toString();
  })(),
};

// A deliberately inert marker: the redaction tests need something recognisable
// that is not itself credential shaped.
const FORBIDDEN_MARKER = ['FORBIDDEN-MARKER', 'TELEMETRY-LEAK'].join('-');

describe('findSensitiveShapes', () => {
  it.each([
    ['bearer-header', SYNTHETIC.bearerHeader],
    ['google-oauth-token', SYNTHETIC.googleToken],
    ['github-token', SYNTHETIC.githubToken],
    ['google-api-key', SYNTHETIC.apiKey],
    ['jwt', SYNTHETIC.jwt],
    ['private-key-block', SYNTHETIC.privateKey],
    ['service-account-member', SYNTHETIC.serviceAccount],
    ['cloud-run-url', SYNTHETIC.cloudRunUrl],
    ['credentialed-url', SYNTHETIC.credentialedUrl],
    ['native-project-path', 'projects/example-project/secrets/api-key'],
    ['provider-etag', 'etag: "abc"'],
    ['raw-plan-payload', '{"resource_changes": []}'],
    ['query-string', '/v1/platform/status?token=abc'],
    ['cookie', 'Cookie: session=abc'],
  ])('recognises %s', (kind, value) => {
    expect(findSensitiveShapes(value)).toContain(kind);
  });

  it('reports the kind and never the value', () => {
    const shapes = findSensitiveShapes(SYNTHETIC.googleToken);
    expect(JSON.stringify(shapes)).not.toContain(SYNTHETIC.googleToken);
  });

  it('leaves ordinary operational values alone', () => {
    for (const value of ['/v1/platform/status', 'GET', 'available', 'release-1.2.3']) {
      expect(findSensitiveShapes(value)).toEqual([]);
    }
  });
});

describe('redactAttributes', () => {
  const bounds = { maxCount: 32, maxLength: 256 };

  it('drops any key that is not allowlisted', () => {
    const result = redactAttributes(
      {
        'http.route': '/v1/platform/status',
        'http.request.body': FORBIDDEN_MARKER,
        'url.full': `https://telemetry.invalid/x?secret=${FORBIDDEN_MARKER}`,
        'http.request.header.authorization': SYNTHETIC.bearerHeader,
        'exception.stacktrace': FORBIDDEN_MARKER,
      },
      bounds,
    );
    expect(result).toEqual({ 'http.route': '/v1/platform/status' });
    expect(JSON.stringify(result)).not.toContain(FORBIDDEN_MARKER);
  });

  it('replaces a sensitive value even under an allowlisted key', () => {
    const result = redactAttributes({ 'server.address': SYNTHETIC.cloudRunUrl }, bounds);
    expect(result['server.address']).toBe(`${REDACTED}:cloud-run-url`);
    expect(JSON.stringify(result)).not.toContain('run.app');
  });

  it('bounds value length and attribute count', () => {
    const long = 'a'.repeat(1_000);
    expect(redactAttributes({ 'http.route': long }, { maxCount: 32, maxLength: 16 })).toEqual({
      'http.route': `${'a'.repeat(16)}…`,
    });

    const many = Object.fromEntries(
      [...ALLOWED_METRIC_ATTRIBUTE_KEYS].map((key) => [key, 'value']),
    );
    expect(Object.keys(redactAttributes(many, { maxCount: 2, maxLength: 16 }))).toHaveLength(2);
  });

  it('keeps finite numbers and booleans and drops everything else', () => {
    const result = redactAttributes(
      {
        'http.response.status_code': 200,
        'money_noodle.request_id': true,
        'service.name': Number.NaN,
        'service.version': { nested: 'object' },
      },
      bounds,
    );
    expect(result).toEqual({ 'http.response.status_code': 200, 'money_noodle.request_id': true });
  });
});

describe('redactSpanName', () => {
  it('keeps an allowlisted name', () => {
    expect(redactSpanName('GET /v1/platform/status', new Set(['GET /v1/platform/status']))).toBe(
      'GET /v1/platform/status',
    );
  });

  it('replaces a name carrying a sensitive shape', () => {
    expect(redactSpanName(`GET ${SYNTHETIC.cloudRunUrl}`, new Set())).toBe(REDACTED);
    expect(redactSpanName('GET /v1/platform/status?token=abc', new Set())).toBe(REDACTED);
  });

  it('replaces an unbounded or unexpected name', () => {
    expect(redactSpanName('x'.repeat(200), new Set())).toBe(REDACTED);
    expect(redactSpanName('«weird»', new Set())).toBe(REDACTED);
  });
});

describe('boundMetricAttributes', () => {
  it('refuses correlation identifiers as metric labels', () => {
    const result = boundMetricAttributes({
      'http.route': '/v1/platform/status',
      'money_noodle.request_id': 'request-1',
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      'user.id': 'someone',
    });
    expect(result).toEqual({ 'http.route': '/v1/platform/status' });
  });

  it('bounds the dimension count well below the span attribute bound', () => {
    const result = boundMetricAttributes({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'http.route': '/v1/platform/status',
      'money_noodle.export.outcome': 'observed',
      'money_noodle.signal': 'traces',
      'service.name': 'platform-api',
      'service.version': 'release-1.2.3',
    });
    expect(Object.keys(result).length).toBeLessThanOrEqual(6);
    // `service.name` is a resource attribute, never a per-series label.
    expect(result).not.toHaveProperty('service.name');
  });
});
