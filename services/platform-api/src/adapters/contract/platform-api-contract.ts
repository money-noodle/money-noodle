import Ajv2020Module, {
  type Ajv2020 as Ajv2020Instance,
  type Options as AjvOptions,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import formatsModule, { type FormatsPlugin } from 'ajv-formats';
import { parse } from 'yaml';

import type { PublishedHourlyThresholds } from '../../domain/hourly-thresholds.js';
import type { PublishedMarketOverview } from '../../domain/market-overview.js';
import type {
  PublishedBudget,
  PublishedPerformance,
  PublishedPerformanceSummary,
} from '../../domain/paper-dashboard.js';
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

/**
 * The paper reads, as they go over the wire.
 *
 * Each is the published view plus the two envelope fields every response in this
 * contract carries. The envelope is added at the edge rather than built into the
 * view, because `schemaVersion` and `requestId` are facts about this response and
 * not about the record it carries.
 */
export type PaperBudgetResponse = PublishedBudget & {
  readonly requestId: string;
  readonly schemaVersion: '1';
};

export type PaperPerformanceSummaryResponse = PublishedPerformanceSummary & {
  readonly requestId: string;
  readonly schemaVersion: '1';
};

export type PaperPerformanceResponse = PublishedPerformance & {
  readonly requestId: string;
  readonly schemaVersion: '1';
};

/**
 * The market reads, as they go over the wire.
 *
 * Same envelope rule as the paper reads. Note what is not added here: no freshness
 * member is synthesized at the edge, because freshness belongs to the feed that
 * produced the value and is already in the view.
 */
export type MarketOverviewResponse = PublishedMarketOverview & {
  readonly requestId: string;
  readonly schemaVersion: '1';
};

export type HourlyThresholdMarketsResponse = PublishedHourlyThresholds & {
  readonly requestId: string;
  readonly schemaVersion: '1';
};

/**
 * The signed-in responses, as they go over the wire.
 *
 * Same envelope rule as every other response in this contract. These are
 * declared structurally rather than from a domain type, because what crosses the
 * wire is deliberately *less* than what the domain holds: a session summary
 * carries an account and an expiry and nothing a provider said, and an intent row
 * carries ISO strings rather than the `Date` objects the store returns.
 */
export interface SessionSummaryResponse {
  readonly accountId: string;
  readonly expiresAt: string;
  readonly requestId: string;
  readonly schemaVersion: '1';
}

export interface BudgetSummaryPayload {
  readonly createdAt: string;
  readonly hasExecutionAuthority: boolean;
  readonly id: string;
  readonly kind: 'paper' | 'live';
}

export interface BudgetListResponse {
  readonly budgets: readonly BudgetSummaryPayload[];
  readonly requestId: string;
  readonly schemaVersion: '1';
}

export interface BudgetDetailResponse {
  readonly appliedState: string | null;
  readonly budget: BudgetSummaryPayload;
  readonly capability: string;
  readonly desiredState: 'running' | 'paused' | 'unset';
  readonly epoch: number;
  readonly latestIntentAt: string | null;
  readonly requestId: string;
  readonly schemaVersion: '1';
}

export interface ControlAcceptedResponse {
  readonly action: string;
  readonly capability: string;
  readonly intentId: string;
  readonly recorded: true;
  readonly requestId: string;
  readonly schemaVersion: '1';
}

export interface IntentHistoryResponse {
  readonly capability: string;
  readonly entries: readonly unknown[];
  readonly requestId: string;
  readonly schemaVersion: '1';
}

export interface JobHealthResponse {
  readonly jobs: readonly unknown[];
  readonly requestId: string;
  readonly schemaVersion: '1';
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
  assertBudgetDetail(value: unknown): asserts value is BudgetDetailResponse;
  assertBudgetList(value: unknown): asserts value is BudgetListResponse;
  assertControlAccepted(value: unknown): asserts value is ControlAcceptedResponse;
  assertHealth(value: unknown): asserts value is HealthResponse;
  assertHourlyThresholdMarkets(value: unknown): asserts value is HourlyThresholdMarketsResponse;
  assertIntentHistory(value: unknown): asserts value is IntentHistoryResponse;
  assertJobHealth(value: unknown): asserts value is JobHealthResponse;
  assertMarketOverview(value: unknown): asserts value is MarketOverviewResponse;
  assertPaperBudget(value: unknown): asserts value is PaperBudgetResponse;
  assertPaperPerformance(value: unknown): asserts value is PaperPerformanceResponse;
  assertPaperPerformanceSummary(value: unknown): asserts value is PaperPerformanceSummaryResponse;
  assertPlatformStatus(value: unknown): asserts value is PlatformStatusResponse;
  assertProblem(value: unknown): asserts value is ProblemResponse;
  assertSessionSummary(value: unknown): asserts value is SessionSummaryResponse;
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
    // The signed-in responses validate against the same document they are
    // published from, exactly as the public reads do. A control response that
    // drifted from the contract fails here rather than in a client, and that
    // matters more for these than for a read: a malformed acknowledgement of a
    // recorded intent is a malformed audit trail.
    assertBudgetDetail: createAssertion<BudgetDetailResponse>(
      'BudgetDetail',
      validator('BudgetDetail'),
    ),
    assertBudgetList: createAssertion<BudgetListResponse>('BudgetList', validator('BudgetList')),
    assertControlAccepted: createAssertion<ControlAcceptedResponse>(
      'ControlAccepted',
      validator('ControlAccepted'),
    ),
    assertHealth: createAssertion<HealthResponse>('Health', validator('Health')),
    assertHourlyThresholdMarkets: createAssertion<HourlyThresholdMarketsResponse>(
      'HourlyThresholdMarkets',
      validator('HourlyThresholdMarkets'),
    ),
    assertIntentHistory: createAssertion<IntentHistoryResponse>(
      'IntentHistory',
      validator('IntentHistory'),
    ),
    assertJobHealth: createAssertion<JobHealthResponse>(
      'JobHealthReport',
      validator('JobHealthReport'),
    ),
    assertMarketOverview: createAssertion<MarketOverviewResponse>(
      'MarketOverview',
      validator('MarketOverview'),
    ),
    // The read endpoints validate against the same document they are published
    // from, for the same reason the status endpoint does: a response that drifts
    // from the contract fails here, in this service, rather than in a client.
    assertPaperBudget: createAssertion<PaperBudgetResponse>(
      'PaperBudget',
      validator('PaperBudget'),
    ),
    assertPaperPerformance: createAssertion<PaperPerformanceResponse>(
      'PaperPerformance',
      validator('PaperPerformance'),
    ),
    assertPaperPerformanceSummary: createAssertion<PaperPerformanceSummaryResponse>(
      'PaperPerformanceSummary',
      validator('PaperPerformanceSummary'),
    ),
    assertPlatformStatus: createAssertion<PlatformStatusResponse>(
      'PlatformStatus',
      validator('PlatformStatus'),
    ),
    assertProblem: createAssertion<ProblemResponse>('Problem', validator('Problem')),
    assertSessionSummary: createAssertion<SessionSummaryResponse>(
      'SessionSummary',
      validator('SessionSummary'),
    ),
  };
}
