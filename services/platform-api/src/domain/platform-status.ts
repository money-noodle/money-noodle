export type PlatformStatusState = 'available' | 'degraded' | 'maintenance';

export interface ServiceDescriptor {
  readonly name: 'platform-api';
  readonly version: string;
}

export interface PlatformStatus {
  readonly state: PlatformStatusState;
  readonly asOf: Date;
  readonly service: ServiceDescriptor;
}
