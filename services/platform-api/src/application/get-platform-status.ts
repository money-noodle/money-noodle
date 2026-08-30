import type {
  PlatformStatus,
  PlatformStatusState,
  ServiceDescriptor,
} from '../domain/platform-status.js';

export interface Clock {
  now(): Date;
}

export interface PlatformStatusStateReader {
  read(): PlatformStatusState;
}

export interface GetPlatformStatusDependencies {
  readonly clock: Clock;
  readonly service: ServiceDescriptor;
  readonly stateReader: PlatformStatusStateReader;
}

export type GetPlatformStatus = () => PlatformStatus;

export function createGetPlatformStatus(
  dependencies: GetPlatformStatusDependencies,
): GetPlatformStatus {
  return () => ({
    asOf: dependencies.clock.now(),
    service: dependencies.service,
    state: dependencies.stateReader.read(),
  });
}
