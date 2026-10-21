import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ContractResponseError, createPlatformApiContract } from './platform-api-contract.js';

const source = readFileSync('services/platform-api/openapi/platform-api.v1.yaml', 'utf8');

describe('createPlatformApiContract', () => {
  it('returns a nineteen-field recorded configure document and refuses twenty-one', () => {
    // The runtime assertion compiles from the published document, so the published
    // `maxProperties` is what a read actually enforces: before it was raised to twenty, a
    // nineteen-field paper configure document would have failed here and the route would
    // have answered 500 for a row the API itself had accepted.
    const contract = createPlatformApiContract(source);
    const parameters = {
      budget_id: 'synthetic:paper',
      entry_cap_cents: 200,
      funding_id: 'synthetic-funding',
      kalshi_cap_cents: 500,
      kalshi_market_percent: 100,
      market_id: 'crypto-15m',
      paper_config_version: 2,
      paper_providers: 'kalshi',
      policy_bundle: 'paper-v1-blend04-neutral-v7',
      polymarket_cap_cents: 0,
      polymarket_market_percent: 0,
      regime_bundle_id: 'paper-regime-historical-warm-lineage-v1',
      regime_enabled: true,
      regime_evidence_half_life_windows: '2.50',
      regime_minimum_policy_windows: 12,
      regime_pause_confidence: '0.970',
      regime_profile_claim: 'synthetic-profile-claim',
      regime_resume_confidence: '0.9',
      total_cap_cents: 1000,
    };
    expect(Object.keys(parameters)).toHaveLength(19);
    const history = (count: number) => ({
      capability: 'budget:paper',
      entries: [
        {
          intent: {
            action: 'configure',
            actor: 'synthetic-account',
            capability: 'budget:paper',
            epoch: 1,
            id: 'intent-1',
            parameters: Object.fromEntries(Object.entries(parameters).slice(0, count)),
            recordedAt: '2026-10-21T00:00:00.000Z',
            runId: 'synthetic-run',
          },
          outcomes: [],
        },
      ],
      requestId: 'request-123',
      schemaVersion: '1',
    });
    expect(() => contract.assertIntentHistory(history(19))).not.toThrow();
    expect(() => contract.assertIntentHistory(history(20))).not.toThrow();
    const twentyOne = history(19);
    const recorded = twentyOne.entries[0]!.intent.parameters as Record<string, unknown>;
    for (let index = 0; index < 2; index += 1) recorded[`extra_${index}`] = index;
    expect(Object.keys(recorded)).toHaveLength(21);
    expect(() => contract.assertIntentHistory(twentyOne)).toThrow(ContractResponseError);
  });

  it('validates the canonical status, health, and problem wire shapes', () => {
    const contract = createPlatformApiContract(source);

    expect(() =>
      contract.assertPlatformStatus({
        asOf: '2026-08-29T20:00:00.000Z',
        requestId: 'request-123',
        schemaVersion: '1',
        service: { name: 'platform-api', version: 'git-abc1234' },
        state: 'available',
      }),
    ).not.toThrow();
    expect(() =>
      contract.assertHealth({ service: 'platform-api', status: 'ready', version: 'abc1234' }),
    ).not.toThrow();
    expect(() =>
      contract.assertProblem({
        errorCode: 'MN-INTERNAL-ERROR',
        requestId: 'request-123',
        status: 500,
        title: 'Internal Server Error',
        type: 'https://errors.noodle.money/internal-error',
      }),
    ).not.toThrow();
  });

  it.each([
    {
      asOf: 'not-a-time',
      requestId: 'request-123',
      schemaVersion: '1',
      service: { name: 'platform-api', version: 'abc1234' },
      state: 'available',
    },
    {
      asOf: '2026-08-29T20:00:00.000Z',
      requestId: 'request 123',
      schemaVersion: '1',
      service: { name: 'platform-api', version: 'abc1234' },
      state: 'available',
    },
    {
      asOf: '2026-08-29T20:00:00.000Z',
      extra: 'must not cross the wire',
      requestId: 'request-123',
      schemaVersion: '1',
      service: { name: 'platform-api', version: 'abc1234' },
      state: 'available',
    },
  ])('rejects invalid status response %#', (response) => {
    const contract = createPlatformApiContract(source);

    expect(() => contract.assertPlatformStatus(response)).toThrow(ContractResponseError);
  });

  it('fails startup when the status operation no longer points at the governed schema', () => {
    const invalidSource = source.replace(
      "$ref: '#/components/schemas/PlatformStatus'",
      "$ref: '#/components/schemas/Health'",
    );

    expect(() => createPlatformApiContract(invalidSource)).toThrow(
      'must reference #/components/schemas/PlatformStatus',
    );
  });

  it.each([
    ['a non-object document', '[]', 'missing object document'],
    ['missing paths', '{}', 'missing document.paths'],
    [
      'the wrong JSON Schema dialect',
      source.replace(
        'https://json-schema.org/draft/2020-12/schema',
        'http://json-schema.org/draft-07/schema#',
      ),
      'must use JSON Schema draft 2020-12',
    ],
    [
      'a missing governed problem schema',
      source.replaceAll('    Problem:\n', '    RenamedProblem:\n'),
      'OpenAPI schema Problem is unavailable',
    ],
  ])('fails startup for %s', (_name, invalidSource, message) => {
    expect(() => createPlatformApiContract(invalidSource)).toThrow(message);
  });
});
