import { randomBytes, randomUUID } from 'node:crypto';

import { getPlatformStatus } from '@money-noodle/platform-api-client';

import type { PlatformStatusObservation } from '../../presentation/platform-status-view-model';
import { isPlatformStatus } from './validate-platform-status';

const DEFAULT_TIMEOUT_MS = 1_500;

export interface CorrelationContext {
  readonly requestId: string;
  readonly traceparent: string;
}

export interface LoadPlatformStatusOptions {
  readonly baseUrl: string;
  readonly correlation?: CorrelationContext;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createCorrelationContext(): CorrelationContext {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return {
    requestId: randomUUID(),
    traceparent: `00-${traceId}-${parentId}-01`,
  };
}

export async function loadPlatformStatus(
  options: LoadPlatformStatusOptions,
): Promise<PlatformStatusObservation | undefined> {
  const correlation = options.correlation ?? createCorrelationContext();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = await getPlatformStatus({
      baseUrl: options.baseUrl,
      cache: 'no-store',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      headers: {
        traceparent: correlation.traceparent,
        'x-request-id': correlation.requestId,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (result.error !== undefined || !isPlatformStatus(result.data)) return undefined;

    return {
      asOf: result.data.asOf,
      serviceVersion: result.data.service.version,
      state: result.data.state,
    };
  } catch {
    return undefined;
  }
}
