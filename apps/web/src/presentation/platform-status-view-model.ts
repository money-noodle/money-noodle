export type ObservedPlatformState = 'available' | 'degraded' | 'maintenance';

export interface PlatformStatusObservation {
  readonly asOf: string;
  readonly serviceVersion: string;
  readonly state: ObservedPlatformState;
}

export type PlatformStatusViewModel =
  | {
      readonly explanation: string;
      readonly label: string;
      readonly state: ObservedPlatformState;
      readonly observation: PlatformStatusObservation;
    }
  | {
      readonly explanation: string;
      readonly label: 'Status unknown';
      readonly state: 'unknown';
    };

const PRESENTATION = {
  available: {
    explanation: 'The platform API reports normal availability.',
    label: 'Available',
  },
  degraded: {
    explanation: 'The platform API reports reduced availability.',
    label: 'Degraded',
  },
  maintenance: {
    explanation: 'The platform API reports planned maintenance.',
    label: 'Maintenance',
  },
} as const;

export function presentPlatformStatus(
  observation: PlatformStatusObservation | undefined,
): PlatformStatusViewModel {
  if (observation === undefined) {
    return {
      explanation: 'A current platform observation could not be verified. Please try again later.',
      label: 'Status unknown',
      state: 'unknown',
    };
  }

  return {
    ...PRESENTATION[observation.state],
    observation,
    state: observation.state,
  };
}
