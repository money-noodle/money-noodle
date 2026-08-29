import Ajv2020Module, {
  type Ajv2020 as Ajv2020Instance,
  type Options as AjvOptions,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import formatsModule, { type FormatsPlugin } from 'ajv-formats';
import { parse } from 'yaml';

import type { PlatformStatusState } from '../../domain/platform-status.js';

const Ajv2020 = Ajv2020Module as unknown as new (options?: AjvOptions) => Ajv2020Instance;
const addFormats = formatsModule as unknown as FormatsPlugin;

const CONTRACT_ID = 'https://api.noodle.money/contracts/platform-api.v1';
const STATUS_RESPONSE_REFERENCE = '#/components/schemas/PlatformStatus';

type JsonObject = Record<string, unknown>;

export interface PlatformStatusResponse {
  readonly asOf: string;
  readonly requestId: string;
  readonly schemaVersion: '1';
  readonly service: {
    readonly name: 'platform-api';
    readonly version: string;
  };
  readonly state: PlatformStatusState;
}

export interface HealthResponse {
  readonly service: 'platform-api';
  readonly status: 'live' | 'ready';
  readonly version: string;
}

export interface ProblemResponse {
  readonly detail?: string;
  readonly errorCode: string;
  readonly instance?: string;
  readonly requestId: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}

export interface PlatformApiContract {
  assertHealth(value: unknown): asserts value is HealthResponse;
  assertPlatformStatus(value: unknown): asserts value is PlatformStatusResponse;
  assertProblem(value: unknown): asserts value is ProblemResponse;
}

export class ContractResponseError extends Error {
  constructor(schemaName: string, errors: ValidateFunction['errors']) {
    super(`Response does not satisfy ${schemaName}: ${JSON.stringify(errors ?? [])}`);
    this.name = 'ContractResponseError';
  }
}

function requireObject(value: unknown, location: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`OpenAPI contract is missing object ${location}.`);
  }

  return value as JsonObject;
}

function property(object: JsonObject, key: string, location: string): unknown {
  if (!(key in object)) throw new Error(`OpenAPI contract is missing ${location}.${key}.`);
  return object[key];
}

function routeResponseReference(document: JsonObject): string {
  const paths = requireObject(property(document, 'paths', 'document'), 'paths');
  const route = requireObject(
    property(paths, '/v1/platform/status', 'paths'),
    'paths./v1/platform/status',
  );
  const operation = requireObject(property(route, 'get', 'status route'), 'status route.get');
  const responses = requireObject(
    property(operation, 'responses', 'status operation'),
    'responses',
  );
  const success = requireObject(property(responses, '200', 'status responses'), 'responses.200');
  const content = requireObject(
    property(success, 'content', 'status response'),
    'response.content',
  );
  const json = requireObject(
    property(content, 'application/json', 'status response content'),
    'response.content.application/json',
  );
  const schema = requireObject(property(json, 'schema', 'status JSON response'), 'response.schema');
  const reference = property(schema, '$ref', 'status response schema');

  if (typeof reference !== 'string') {
    throw new Error('OpenAPI status success response must use a schema reference.');
  }

  return reference;
}

function createAssertion<T>(
  schemaName: string,
  validator: ValidateFunction,
): (value: unknown) => asserts value is T {
  return (value: unknown): asserts value is T => {
    if (!validator(value)) throw new ContractResponseError(schemaName, validator.errors);
  };
}

export function createPlatformApiContract(source: string): PlatformApiContract {
  const parsed: unknown = parse(source);
  const document = requireObject(parsed, 'document');

  if (routeResponseReference(document) !== STATUS_RESPONSE_REFERENCE) {
    throw new Error(`OpenAPI status success response must reference ${STATUS_RESPONSE_REFERENCE}.`);
  }

  const components = requireObject(property(document, 'components', 'document'), 'components');
  const schemas = requireObject(
    property(components, 'schemas', 'components'),
    'components.schemas',
  );
  const dialect = property(document, 'jsonSchemaDialect', 'document');

  if (dialect !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error('OpenAPI contract must use JSON Schema draft 2020-12.');
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(
    {
      $id: CONTRACT_ID,
      $schema: dialect,
      components: { schemas },
    },
    CONTRACT_ID,
  );

  const validator = (schemaName: string): ValidateFunction => {
    const compiled = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${schemaName}`);
    if (compiled === undefined) throw new Error(`OpenAPI schema ${schemaName} is unavailable.`);
    return compiled;
  };

  return {
    assertHealth: createAssertion<HealthResponse>('Health', validator('Health')),
    assertPlatformStatus: createAssertion<PlatformStatusResponse>(
      'PlatformStatus',
      validator('PlatformStatus'),
    ),
    assertProblem: createAssertion<ProblemResponse>('Problem', validator('Problem')),
  };
}
