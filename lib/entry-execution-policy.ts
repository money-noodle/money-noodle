import { DEFAULT_STRATEGY_ID, normalizeStrategyId } from './strategy-registry';
import type { PaperOrder, PositionSide, StrategyId } from './types';

export const ENTRY_EXECUTION_POLICY_VERSION = 'maker-taker-adaptive-one-miss-slippage1c-v3';
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
  /** An authoritative zero-fill maker attempt precedes this fresh attempt for the same logical entry. */
  makerMissFallback?: boolean;
  fallbackFromOrderId?: string;
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
  makerMissFallback: boolean;
  fallbackFromOrderId?: string;
}

const priceBand = (price: number): string => price < 0.10 ? '<10c' : price < 0.25 ? '10-25c' : price < 0.50 ? '25-50c' : '50c+';
const spreadBand = (spread: number): string => spread < 0.01 ? '<1c' : spread <= 0.02 ? '1-2c' : '2c+';

/** Uses only prior accepted maker attempts in a comparable price/spread cohort. */
/**
 * Scoped to one strategy. The bands would otherwise pool the long-shot policy's attempts with the edge
 * policy's cheapest ones: both sit in the same low price band, but a resting limit at a fixed mark and a
 * repriced managed maker are not the same execution, so a shared fill rate would describe neither.
 */
export function makerCohortEvidence(orders: PaperOrder[], price: number, spread: number, strategyId: StrategyId = DEFAULT_STRATEGY_ID): MakerCohortEvidence {
  const label = `${priceBand(price)} · ${spreadBand(spread)}`;
  const comparable = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi'
    && normalizeStrategyId(order.strategyId) === strategyId
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
  const absoluteFailures: string[] = [];
  if (input.currentNetEdge + 1e-12 < input.minimumTakerNetEdge) absoluteFailures.push(`taker edge ${(input.currentNetEdge * 100).toFixed(1)}pp < ${(input.minimumTakerNetEdge * 100).toFixed(1)}pp`);
  if (input.medianNetEdge + 1e-12 < input.minimumMedianNetEdge) absoluteFailures.push(`median edge ${(input.medianNetEdge * 100).toFixed(1)}pp < ${(input.minimumMedianNetEdge * 100).toFixed(1)}pp`);
  if (input.confidence + 1e-12 < input.minimumConfidence) absoluteFailures.push(`quality ${(input.confidence * 100).toFixed(1)}% < ${(input.minimumConfidence * 100).toFixed(1)}%`);
  if (input.spread > input.maximumSpread + 1e-12) absoluteFailures.push(`spread ${(input.spread * 100).toFixed(1)}c > ${(input.maximumSpread * 100).toFixed(1)}c`);
  const comparativeFailures: string[] = [];
  if (input.makerEvidence.accepted < input.minimumMakerSamples) comparativeFailures.push(`maker cohort ${input.makerEvidence.accepted}/${input.minimumMakerSamples}`);
  if (takerAdvantage === null || takerAdvantage + 1e-12 < input.minimumTakerAdvantage) comparativeFailures.push(`taker advantage ${takerAdvantage === null ? 'unknown' : `${(takerAdvantage * 100).toFixed(1)}pp`} < ${(input.minimumTakerAdvantage * 100).toFixed(1)}pp`);
  // One authoritative maker miss replaces only the comparative estimate for this exact sequence. It
  // never relaxes current edge, persistent edge, quality, or the 2c taker cost ceiling.
  const failures = input.makerMissFallback ? absoluteFailures : [...absoluteFailures, ...comparativeFailures];
  const recommendedStyle: EntryExecutionStyle = failures.length ? 'maker' : 'taker';
  const executedStyle: EntryExecutionStyle = input.mode === 'maker' ? 'maker' : recommendedStyle;
  const reason = recommendedStyle === 'taker'
    ? input.makerMissFallback
      ? `Taker fallback follows authoritative maker miss ${input.fallbackFromOrderId ?? 'unknown'}; fresh absolute edge/quality/spread gates clear and comparative maker gates are waived for this sequence.`
      : `Taker clears strict edge/quality/spread gates and beats ${input.makerEvidence.label} maker captured edge by ${(takerAdvantage! * 100).toFixed(1)}pp across ${input.makerEvidence.accepted} accepted attempts.${input.mode === 'maker' ? ' Shadow only; live remains maker.' : ''}`
    : `${input.makerMissFallback ? 'Taker fallback withheld' : 'Maker retained'}: ${failures.join('; ')}.`;
  return {
    policyVersion: ENTRY_EXECUTION_POLICY_VERSION, configuredMode: input.mode,
    executedStyle, recommendedStyle, reason,
    takerNetEdge: input.currentNetEdge, medianNetEdge: input.medianNetEdge,
    makerNetEdge: input.makerNetEdge, makerExpectedCapturedEdge, takerAdvantage,
    makerCohort: input.makerEvidence.label, makerSamples: input.makerEvidence.accepted,
    makerFillRate: fillRate, makerMissFallback: Boolean(input.makerMissFallback),
    fallbackFromOrderId: input.fallbackFromOrderId,
  };
}

export function parseEntryExecutionMode(value: string | undefined): EntryExecutionMode {
  return value === 'adaptive' || value === 'taker' ? value : 'maker';
}

export function entrySideProbability(probabilityUp: number, side: PositionSide): number {
  return side === 'UP' ? probabilityUp : 1 - probabilityUp;
}
