import { DEFAULT_STRATEGY_ID, normalizeStrategyId } from './strategy-registry';
import type { PaperOrder, PositionSide, StrategyId } from './types';

export const ENTRY_EXECUTION_POLICY_VERSION = 'maker-high30-one-attempt-fresh1c-v4';
export const HIGH_EDGE_TAKER_THRESHOLD = 0.30;
export const ADAPTIVE_ENTRY_ATTEMPTS = 1;
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
  minimumMedianNetEdge: number;
  minimumConfidence: number;
  maximumSpread: number;
  /** Historical compatibility only. V4 permits one attempt and refuses fallback authority. */
  makerMissFallback?: boolean;
  fallbackFromOrderId?: string;
}

export interface EntryExecutionDecision {
  policyVersion: typeof ENTRY_EXECUTION_POLICY_VERSION;
  configuredMode: EntryExecutionMode;
  executedStyle: EntryExecutionStyle;
  recommendedStyle: EntryExecutionStyle;
  route: 'ordinary-maker' | 'high-edge-taker';
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

/** Uses only prior accepted maker attempts in a comparable price/spread cohort. Reporting-only in v4. */
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
 * V4 spends the spread only on a 30pp edge that survives the exact signed-path refresh. Lower-edge
 * decisions remain maker and receive one attempt. The old fill-rate comparison is retained for audit but
 * cannot gate execution because it treats outcome-selected maker fills as random capture.
 */
export function evaluateEntryExecutionPolicy(input: EntryExecutionPolicyInput): EntryExecutionDecision {
  const fillRate = input.makerEvidence.fillRate;
  const makerExpectedCapturedEdge = fillRate === null ? null : Math.max(0, input.makerNetEdge) * fillRate;
  const takerAdvantage = makerExpectedCapturedEdge === null ? null : input.currentNetEdge - makerExpectedCapturedEdge;
  const failures: string[] = [];
  if (input.currentNetEdge + 1e-12 < HIGH_EDGE_TAKER_THRESHOLD) failures.push(`fresh taker edge ${(input.currentNetEdge * 100).toFixed(1)}pp < ${HIGH_EDGE_TAKER_THRESHOLD * 100}pp`);
  if (input.medianNetEdge + 1e-12 < input.minimumMedianNetEdge) failures.push(`median edge ${(input.medianNetEdge * 100).toFixed(1)}pp < ${(input.minimumMedianNetEdge * 100).toFixed(1)}pp`);
  if (input.confidence + 1e-12 < input.minimumConfidence) failures.push(`quality ${(input.confidence * 100).toFixed(1)}% < ${(input.minimumConfidence * 100).toFixed(1)}%`);
  if (input.spread > input.maximumSpread + 1e-12) failures.push(`spread ${(input.spread * 100).toFixed(1)}c > ${(input.maximumSpread * 100).toFixed(1)}c`);
  if (input.makerMissFallback) failures.push('v4 permits one entry attempt; maker misses do not open fallback authority');
  const recommendedStyle: EntryExecutionStyle = failures.length ? 'maker' : 'taker';
  const executedStyle: EntryExecutionStyle = input.mode === 'maker' ? 'maker' : recommendedStyle;
  const route = recommendedStyle === 'taker' ? 'high-edge-taker' : 'ordinary-maker';
  const reason = recommendedStyle === 'taker'
    ? `Fresh edge clears ${HIGH_EDGE_TAKER_THRESHOLD * 100}pp with persistent edge, quality, and spread gates; submit one capped IOC.${input.mode === 'maker' ? ' Shadow only; live remains maker.' : ''}`
    : `One ordinary maker attempt retained: ${failures.join('; ')}.`;
  return {
    policyVersion: ENTRY_EXECUTION_POLICY_VERSION, configuredMode: input.mode,
    executedStyle, recommendedStyle, route, reason,
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
