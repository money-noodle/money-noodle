import type { EntryExecutionObservation } from './types';

export const ENTRY_DIRECTION_OBSERVATION_VERSION = 'entry-direction-observation-v1';
export const ENTRY_DIRECTION_TICK_CENTS = 1;
export type EntryQuoteDirection = 'adverse' | 'stable' | 'favorable';

export interface EntryDirectionPoint {
  at: string;
  selectedAsk: number;
  movementCents: number;
  direction: EntryQuoteDirection;
  candidateDecision: 'continue' | 'refuse' | 'cancel';
}

export interface EntryDirectionObservation {
  version: typeof ENTRY_DIRECTION_OBSERVATION_VERSION;
  issuanceAsk: number;
  preSubmit?: EntryDirectionPoint;
  firstUnfilledManagement?: EntryDirectionPoint;
}

export function classifySelectedAskMovement(fromAsk: number, toAsk: number): { movementCents: number; direction: EntryQuoteDirection } | null {
  if (![fromAsk, toAsk].every(Number.isFinite) || !(fromAsk > 0) || !(toAsk > 0)) return null;
  const movementCents = (toAsk - fromAsk) * 100;
  const direction = movementCents <= -ENTRY_DIRECTION_TICK_CENTS + 1e-9 ? 'adverse'
    : movementCents >= ENTRY_DIRECTION_TICK_CENTS - 1e-9 ? 'favorable'
      : 'stable';
  return { movementCents, direction };
}

/** Reporting-only reducer over the exact maker path. Production must never read its candidate decisions. */
export function observeEntryDirection(
  previous: EntryDirectionObservation | undefined,
  issuanceAsk: number,
  observation: EntryExecutionObservation,
): EntryDirectionObservation | undefined {
  if (!Number.isFinite(issuanceAsk) || !(issuanceAsk > 0)) return previous;
  const next: EntryDirectionObservation = previous
    ? { ...previous, preSubmit: previous.preSubmit && { ...previous.preSubmit }, firstUnfilledManagement: previous.firstUnfilledManagement && { ...previous.firstUnfilledManagement } }
    : { version: ENTRY_DIRECTION_OBSERVATION_VERSION, issuanceAsk };
  if (!next.preSubmit && (observation.event === 'create_quote' || observation.event === 'paper_submitted')
    && Number.isFinite(observation.selectedAsk)) {
    const classified = classifySelectedAskMovement(issuanceAsk, observation.selectedAsk!);
    if (!classified) return previous;
    next.preSubmit = {
      at: observation.at, selectedAsk: observation.selectedAsk!, ...classified,
      candidateDecision: classified.direction === 'adverse' ? 'refuse' : 'continue',
    };
    return next;
  }
  if (!next.firstUnfilledManagement && next.preSubmit && observation.event === 'management_quote'
    && (observation.filledCount ?? 0) <= 1e-8 && Number.isFinite(observation.selectedAsk)) {
    const classified = classifySelectedAskMovement(next.preSubmit.selectedAsk, observation.selectedAsk!);
    if (!classified) return previous;
    next.firstUnfilledManagement = {
      at: observation.at, selectedAsk: observation.selectedAsk!, ...classified,
      candidateDecision: classified.direction === 'adverse' ? 'cancel' : 'continue',
    };
    return next;
  }
  return previous;
}
