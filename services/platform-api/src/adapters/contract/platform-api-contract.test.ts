import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ContractResponseError, createPlatformApiContract } from './platform-api-contract.js';

const source = readFileSync('services/platform-api/openapi/platform-api.v1.yaml', 'utf8');

describe('createPlatformApiContract', () => {
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
