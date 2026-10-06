import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createCheckIdentityReadiness } from '../../application/check-identity-readiness.js';
import { createCheckProjectionReadiness } from '../../application/check-projection-readiness.js';
import {
  createListBudgets,
  createReadBudgetDetail,
  createReadIntentHistory,
  createReadJobHealth,
  createRecordBudgetControl,
  type BudgetControlDependencies,
} from '../../application/manage-budget-control.js';
import {
  createAuthenticateSession,
  createRevokeSession,
  createSignIn,
  type SessionDependencies,
} from '../../application/manage-session.js';
import { createGetPlatformStatus } from '../../application/get-platform-status.js';
import {
  createGetHourlyThresholdMarkets,
  createGetMarketOverview,
} from '../../application/read-market-data.js';
import {
  createGetPaperBudget,
  createGetPaperPerformance,
  createGetPaperPerformanceSummary,
} from '../../application/read-paper-dashboard.js';
import type {
  BudgetRecordStore,
  ControlRecorderPort,
  EngineReadPort,
} from '../../domain/budget-control.js';
import type { IdentityTokenVerifier, SessionStore } from '../../domain/identity.js';
import type { MarketFeedPort } from '../../domain/market-feeds.js';
import type { PaperProjectionPort } from '../../domain/paper-projection.js';
import { createAccountQueryClient } from '../account-store/account-query-client.js';
import {
  createPostgresBudgetRecordStore,
  createPostgresSessionStore,
} from '../account-store/postgres-account-store.js';
import { readAccountStoreConfig } from '../account-store/read-account-store-config.js';
import {
  createEngineReaderClient,
  createEngineRecorderClient,
} from '../engine-store/engine-query-client.js';
import {
  createPostgresControlRecorder,
  createPostgresEngineReader,
} from '../engine-store/postgres-engine-store.js';
import { readEngineStoreConfig } from '../engine-store/read-engine-store-config.js';
import { createGoogleIdentityPlatformVerifier } from '../identity/google-identity-platform-verifier.js';
import { identityConfigured, readIdentityConfig } from '../identity/read-identity-config.js';
import { createMarketFeeds } from '../feeds/create-market-feeds.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from '../http/create-http-server.js';
import { createPostgresProjectionClient } from '../projection/postgres-client.js';
import { createPostgresPaperProjection } from '../projection/postgres-paper-projection.js';
import { expectedTableList, readProjectionConfig } from '../projection/read-projection-config.js';
import {
  createTelemetry,
  type CreateTelemetryOptions,
  type Telemetry,
} from '../telemetry/create-telemetry.js';
import { readTelemetryConfig } from '../telemetry/read-telemetry-config.js';
import { readRuntimeConfig } from './read-runtime-config.js';

export interface ConfiguredServerOverrides {
  /**
   * Test seam for the telemetry composition: in-memory or loopback transports
   * and a synthetic token source. Production passes nothing and gets the real
   * OTLP exporters and the workload-identity token source.
   */
  readonly telemetry?: Pick<
    CreateTelemetryOptions,
    'exporters' | 'tokenSource' | 'degradationSink' | 'allowLoopbackEndpointForTests' | 'endpoint'
  >;
  /**
   * Test seam for the market feed port, so the public reads can be exercised
   * against recorded payloads without reaching a provider.
   */
  readonly marketFeeds?: MarketFeedPort;
  /**
   * Test seam for the projection port, so readiness can be exercised against a
   * double. `null` is "configured as absent" and is distinct from omitting the
   * override, which lets the environment decide.
   */
  readonly projection?: PaperProjectionPort | null;
  /**
   * Test seams for the signed-in surface (#242), so sign-in, the session
   * lifecycle and intent recording can be exercised against doubles without a
   * database and without reaching an identity provider. `null` is "configured as
   * absent", which is the state of a revision whose Secret Manager values the
   * maintainer has not entered yet.
   */
  readonly identity?: {
    readonly accountId?: string;
    readonly budgets?: BudgetRecordStore | null;
    readonly engine?: EngineReadPort | null;
    readonly recorder?: ControlRecorderPort | null;
    readonly sessions?: SessionStore | null;
    readonly verifier?: IdentityTokenVerifier | null;
  };
}

// Validate all configuration before reading the contract or constructing a
// server. Telemetry is initialized first so the server is constructed with it
// already available, never retrofitted onto a listening server.
export async function createConfiguredServer(
  env: Readonly<Record<string, string | undefined>>,
  overrides: ConfiguredServerOverrides = {},
): Promise<{
  /** Closed on shutdown beside the projection, for the same reason. */
  accountClient: { close(): Promise<void> } | null;
  config: ReturnType<typeof readRuntimeConfig>;
  projection: PaperProjectionPort | null;
  server: ReturnType<typeof createHttpServer>;
  telemetry: Telemetry;
}> {
  const config = readRuntimeConfig(env);
  const telemetryConfig = readTelemetryConfig(env, {
    serviceName: config.service.name,
    serviceVersion: config.service.version,
  });
  const telemetry = await createTelemetry({
    ...(telemetryConfig.endpoint === undefined ? {} : { endpoint: telemetryConfig.endpoint }),
    identity: {
      environment: telemetryConfig.environment,
      imageDigest: telemetryConfig.imageDigest,
      runtimeRevision: telemetryConfig.runtimeRevision,
      serviceName: telemetryConfig.serviceName,
      serviceVersion: telemetryConfig.serviceVersion,
      sourceCommit: telemetryConfig.sourceCommit,
    },
    ...(telemetryConfig.quotaProject === undefined
      ? {}
      : { quotaProject: telemetryConfig.quotaProject }),
    samplingRatio: telemetryConfig.samplingRatio,
    ...overrides.telemetry,
  });

  // The projection is configured by a Secret Manager reference the maintainer
  // fills out of band, so an absent connection string is a legitimate state, not
  // a misconfiguration (#209). The adapter connects lazily; constructing it
  // reaches no database.
  const projectionConfig = readProjectionConfig(env);
  const projection =
    overrides.projection !== undefined
      ? overrides.projection
      : projectionConfig.connectionString === undefined
        ? null
        : createPostgresPaperProjection({
            client: createPostgresProjectionClient(projectionConfig.connectionString),
            schema: projectionConfig.schema,
            tables: projectionConfig.tables,
          });

  const checkReadiness = createCheckProjectionReadiness({
    expectedTables: expectedTableList(projectionConfig.tables),
    projection,
    // #210 added three read endpoints over the projection, so a revision without a
    // working, SELECT-only one cannot serve its declared contract and must never
    // report ready. That is the fail-closed half of ADR-0012, and from here it is
    // also the gate on a deployment: Cloud Run has no separate readiness probe, so
    // a revision that never reports ready never receives traffic and the previous
    // one keeps serving.
    //
    // Cold start is the cost, and it is accepted rather than hidden. The projection's
    // provider autosuspends, so the first connect after an idle period can take
    // seconds; the driver waits up to ten, while the startup probe times out at three
    // and is retried ten times over roughly half a minute. An early probe can
    // therefore fail while the connection it opened is still being established, and
    // a later probe in the same window finds the pool warm. A database that stays
    // asleep longer than the startup window fails the revision, which is the correct
    // outcome: traffic stays where it is.
    readyWithoutProjection: false,
  });

  // The feed port holds the bounded in-process cache, so it is constructed once per
  // process rather than per request. Constructing it reaches no provider and needs no
  // credential: every endpoint behind it is public and keyless. Readiness does not
  // consult it — a provider outage is published in a 200, and is never a reason for
  // this revision to stop serving or for the platform to restart it.
  const marketFeeds = overrides.marketFeeds ?? createMarketFeeds();

  // Identity and the engine store, composed the same way the projection is: every
  // value arrives from a Secret Manager reference the maintainer fills out of band,
  // an absent value is a legitimate state rather than a misconfiguration, and
  // constructing an adapter reaches nothing (ADR-0005, ADR-0012, ADR-0013 §2).
  const identityConfig = readIdentityConfig(env);
  const engineConfig = readEngineStoreConfig(env);
  const accountConfig = readAccountStoreConfig(env);

  const accountClient =
    overrides.identity?.sessions === undefined && overrides.identity?.budgets === undefined
      ? accountConfig.connectionString === undefined
        ? null
        : createAccountQueryClient(accountConfig.connectionString)
      : null;

  const sessions: SessionStore | null =
    overrides.identity?.sessions !== undefined
      ? overrides.identity.sessions
      : accountClient === null
        ? null
        : createPostgresSessionStore({ client: accountClient, schema: accountConfig.schema });

  const budgets: BudgetRecordStore | null =
    overrides.identity?.budgets !== undefined
      ? overrides.identity.budgets
      : accountClient === null
        ? null
        : createPostgresBudgetRecordStore({ client: accountClient, schema: accountConfig.schema });

  const engine: EngineReadPort | null =
    overrides.identity?.engine !== undefined
      ? overrides.identity.engine
      : engineConfig.readerConnectionString === undefined
        ? null
        : createPostgresEngineReader({
            client: createEngineReaderClient(engineConfig.readerConnectionString),
            schema: engineConfig.schema,
          });

  const recorder: ControlRecorderPort | null =
    overrides.identity?.recorder !== undefined
      ? overrides.identity.recorder
      : engineConfig.recorderConnectionString === undefined
        ? null
        : createPostgresControlRecorder({
            client: createEngineRecorderClient(engineConfig.recorderConnectionString),
            schema: engineConfig.schema,
          });

  const verifier: IdentityTokenVerifier | null =
    overrides.identity?.verifier !== undefined
      ? overrides.identity.verifier
      : identityConfigured(identityConfig) &&
          identityConfig.audience !== undefined &&
          identityConfig.issuer !== undefined
        ? createGoogleIdentityPlatformVerifier({
            audience: identityConfig.audience,
            issuer: identityConfig.issuer,
            keysUrl: identityConfig.keysUrl,
          })
        : null;

  const accountId = overrides.identity?.accountId ?? identityConfig.accountId;

  const sessionDependencies: SessionDependencies = {
    accountId,
    clock: { now: () => new Date() },
    // 32 bytes of randomness, base64url. Opaque and unguessable: the identifier is
    // the whole of what a client holds, so it must carry no structure to attack.
    newSessionId: () => randomBytes(32).toString('base64url'),
    sessions,
    verifier,
  };

  const budgetDependencies: BudgetControlDependencies = {
    budgets,
    clock: { now: () => new Date() },
    engine,
    epoch: engineConfig.epoch,
    newRunId: () => randomUUID(),
    recorder,
  };

  // What "configured" means for readiness: everything the signed-in surface needs
  // to answer. A revision missing any of it answers those routes honestly and is
  // still allowed to be ready, because the public dashboard — which is the whole of
  // what M3 promised — is unaffected. The flag is what #210 flipped for the
  // projection once a read endpoint depended on it, and the identity surface will
  // flip the same way once something depends on it being there.
  const checkIdentityReadiness = createCheckIdentityReadiness({
    configured: () =>
      verifier !== null && sessions !== null && budgets !== null && accountId !== undefined,
    readyWithoutIdentity: true,
  });

  const contract = createPlatformApiContract(readFileSync(config.contractPath, 'utf8'));
  const getPlatformStatus = createGetPlatformStatus({
    clock: { now: () => new Date() },
    service: config.service,
    stateReader: { read: () => 'available' },
  });
  const server = createHttpServer({
    checkReadiness: async () => {
      // Both gates, and the projection's answer wins when both fail: it is the one
      // that already stops a revision from serving its public contract.
      const projectionVerdict = await checkReadiness();
      if (!projectionVerdict.ready) return projectionVerdict;
      const identityVerdict = checkIdentityReadiness();
      return identityVerdict.ready
        ? identityVerdict
        : { ready: false, state: 'identity-not-configured' };
    },
    contract,
    getHourlyThresholdMarkets: createGetHourlyThresholdMarkets({ feeds: marketFeeds }),
    getMarketOverview: createGetMarketOverview({ feeds: marketFeeds }),
    // One port instance, three use cases, no cache between them: a read reads.
    getPaperBudget: createGetPaperBudget({ projection }),
    getPaperPerformance: createGetPaperPerformance({ projection }),
    getPaperPerformanceSummary: createGetPaperPerformanceSummary({ projection }),
    getPlatformStatus,
    service: config.service,
    signedIn: {
      authenticateSession: createAuthenticateSession(sessionDependencies),
      listBudgets: createListBudgets(budgetDependencies),
      readBudgetDetail: createReadBudgetDetail(budgetDependencies),
      readIntentHistory: createReadIntentHistory(budgetDependencies),
      readJobHealth: createReadJobHealth(budgetDependencies),
      recordBudgetControl: createRecordBudgetControl(budgetDependencies),
      revokeSession: createRevokeSession(sessionDependencies),
      signIn: createSignIn(sessionDependencies),
    },
    telemetry,
  });
  return { accountClient, config, projection, server, telemetry };
}
