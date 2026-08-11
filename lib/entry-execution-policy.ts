import type { PaperOrder, PositionSide } from './types';

export const ENTRY_EXECUTION_POLICY_VERSION = 'maker-taker-adaptive-shadow-v1';
export type EntryExecutionMode = 'maker' | 'adaptive' | 'taker';
export type EntryExecutionStyle = 'maker' | 'taker';

export interface MakerCohortEvidence {
  label: string;
  accepted: number;
  fills: number;
  fillRate: number | null;
}

export interface EntryExecutionPolicyInput {
  mode: EntryExecutionMode;
  currentNetEdge: number;
  medianNetEdge: number;
  confidence: number;
  spread: number;
  makerNetEdge: number;
  makerEvidence: MakerCohortEvidence;
  minimumTakerNetEdge: number;
  minimumMedianNetEdge: number;
  minimumConfidence: number;
  maximumSpread: number;
  minimumMakerSamples: number;
  minimumTakerAdvantage: number;
}

export interface EntryExecutionDecision {
  policyVersion: typeof ENTRY_EXECUTION_POLICY_VERSION;
  configuredMode: EntryExecutionMode;
  executedStyle: EntryExecutionStyle;
  recommendedStyle: EntryExecutionStyle;
  reason: string;
  takerNetEdge: number;
  medianNetEdge: number;
  makerNetEdge: number;
  makerExpectedCapturedEdge: number | null;
  takerAdvantage: number | null;
  makerCohort: string;
  makerSamples: number;
  makerFillRate: number | null;
}

const priceBand = (price: number): string => price < 0.10 ? '<10c' : price < 0.25 ? '10-25c' : price < 0.50 ? '25-50c' : '50c+';
const spreadBand = (spread: number): string => spread < 0.01 ? '<1c' : spread <= 0.02 ? '1-2c' : '2c+';

/** Uses only prior accepted maker attempts in a comparable price/spread cohort. */
export function makerCohortEvidence(orders: PaperOrder[], price: number, spread: number): MakerCohortEvidence {
  const label = `${priceBand(price)} · ${spreadBand(spread)}`;
  const comparable = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi'
    && !order.id.includes(':exit:') && order.entryExecutionDecision?.executedStyle !== 'taker'
    && order.liquidityRole !== 'taker' && Boolean(order.venueOrderId)
    && priceBand(order.askPrice) === priceBand(price) && spreadBand(order.spread) === spreadBand(spread));
  const fills = comparable.filter((order) => (order.filledCount ?? 0) > 0).length;
  return { label, accepted: comparable.length, fills, fillRate: comparable.length ? fills / comparable.length : null };
}

/**
 * Recommends a marketable IOC limit only when its conservative edge exceeds both hard quality gates
 * and the empirically captured value of waiting passively. In maker mode this recommendation remains
 * shadow-only; adaptive mode is the explicit switch that may act on it.
 */
export function evaluateEntryExecutionPolicy(input: EntryExecutionPolicyInput): EntryExecutionDecision {
  const fillRate = input.makerEvidence.fillRate;
  const makerExpectedCapturedEdge = fillRate === null ? null : Math.max(0, input.makerNetEdge) * fillRate;
  const takerAdvantage = makerExpectedCapturedEdge === null ? null : input.currentNetEdge - makerExpectedCapturedEdge;
  const failures: string[] = [];
  if (input.currentNetEdge + 1e-12 < input.minimumTakerNetEdge) failures.push(`taker edge ${(input.currentNetEdge * 100).toFixed(1)}pp < ${(input.minimumTakerNetEdge * 100).toFixed(1)}pp`);
  if (input.medianNetEdge + 1e-12 < input.minimumMedianNetEdge) failures.push(`median edge ${(input.medianNetEdge * 100).toFixed(1)}pp < ${(input.minimumMedianNetEdge * 100).toFixed(1)}pp`);
  if (input.confidence + 1e-12 < input.minimumConfidence) failures.push(`quality ${(input.confidence * 100).toFixed(1)}% < ${(input.minimumConfidence * 100).toFixed(1)}%`);
  if (input.spread > input.maximumSpread + 1e-12) failures.push(`spread ${(input.spread * 100).toFixed(1)}c > ${(input.maximumSpread * 100).toFixed(1)}c`);
  if (input.makerEvidence.accepted < input.minimumMakerSamples) failures.push(`maker cohort ${input.makerEvidence.accepted}/${input.minimumMakerSamples}`);
  if (takerAdvantage === null || takerAdvantage + 1e-12 < input.minimumTakerAdvantage) failures.push(`taker advantage ${takerAdvantage === null ? 'unknown' : `${(takerAdvantage * 100).toFixed(1)}pp`} < ${(input.minimumTakerAdvantage * 100).toFixed(1)}pp`);
  const recommendedStyle: EntryExecutionStyle = failures.length ? 'maker' : 'taker';
  // Even explicit taker mode retains every hard gate; it is not an unsafe unconditional market mode.
  const executedStyle: EntryExecutionStyle = input.mode === 'maker' ? 'maker' : recommendedStyle;
  const reason = recommendedStyle === 'taker'
    ? `Taker clears strict edge/quality/spread gates and beats ${input.makerEvidence.label} maker captured edge by ${(takerAdvantage! * 100).toFixed(1)}pp across ${input.makerEvidence.accepted} accepted attempts.${input.mode === 'maker' ? ' Shadow only; live remains maker.' : ''}`
    : `Maker retained: ${failures.join('; ')}.`;
  return {
    policyVersion: ENTRY_EXECUTION_POLICY_VERSION, configuredMode: input.mode,
    executedStyle, recommendedStyle, reason,
    takerNetEdge: input.currentNetEdge, medianNetEdge: input.medianNetEdge,
    makerNetEdge: input.makerNetEdge, makerExpectedCapturedEdge, takerAdvantage,
    makerCohort: input.makerEvidence.label, makerSamples: input.makerEvidence.accepted,
    makerFillRate: fillRate,
  };
}

export function parseEntryExecutionMode(value: string | undefined): EntryExecutionMode {
  return value === 'adaptive' || value === 'taker' ? value : 'maker';
}

export function entrySideProbability(probabilityUp: number, side: PositionSide): number {
  return side === 'UP' ? probabilityUp : 1 - probabilityUp;
}
