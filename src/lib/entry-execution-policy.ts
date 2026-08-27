import { makerExecutionStyle } from './execution-order-evidence';
import { DEFAULT_STRATEGY_ID, normalizeStrategyId } from './strategy-registry';
import type { PaperOrder, PositionSide, StrategyId } from './types';

export const ENTRY_EXECUTION_POLICY_VERSION = 'maker-then-positive-edge-taker2-fresh2tick-v8';
/** Historical manifest/reporting threshold; v8 no longer grants an immediate high-edge taker route. */
export const HIGH_EDGE_TAKER_THRESHOLD = 0.30;
/** One maker intent plus at most two bounded IOC intents. */
export const MAX_ENTRY_EPISODES_PER_WINDOW = 3;
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
  /** An authoritative zero-spend predecessor permits this bounded fallback evaluation. */
  makerMissFallback?: boolean;
  fallbackFromOrderId?: string;
}

export interface EntryExecutionDecision {
  policyVersion: typeof ENTRY_EXECUTION_POLICY_VERSION;
  configuredMode: EntryExecutionMode;
  executedStyle: EntryExecutionStyle;
  recommendedStyle: EntryExecutionStyle;
  route: 'ordinary-maker' | 'high-edge-taker' | 'maker-miss-taker-fallback' | 'bounded-taker-experiment';
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

/** Uses only prior accepted maker attempts in a comparable price/spread cohort. Reporting-only in v5. */
export function makerCohortEvidence(orders: PaperOrder[], price: number, spread: number, strategyId: StrategyId = DEFAULT_STRATEGY_ID): MakerCohortEvidence {
  const label = `${priceBand(price)} · ${spreadBand(spread)}`;
  const comparable = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi'
    && normalizeStrategyId(order.strategyId) === strategyId
    && !order.id.includes(':exit:') && makerExecutionStyle(order) !== 'taker'
    && order.liquidityRole !== 'taker' && Boolean(order.venueOrderId)
    && priceBand(order.askPrice) === priceBand(price) && spreadBand(order.spread) === spreadBand(spread));
  const fills = comparable.filter((order) => (order.filledCount ?? 0) > 0).length;
  return { label, accepted: comparable.length, fills, fillRate: comparable.length ? fills / comparable.length : null };
}

/**
 * Attempt one is always the managed maker. Only an authoritative predecessor selected by the lifecycle
 * policy may request a taker fallback. The signed quote authorizer separately evaluates positive edge at
 * the actual two-tick limit; this issuance decision preserves quality and spread gates without requiring
 * post-miss persistence or the ordinary 5pp admission margin again.
 */
export function evaluateEntryExecutionPolicy(input: EntryExecutionPolicyInput): EntryExecutionDecision {
  const fillRate = input.makerEvidence.fillRate;
  const makerExpectedCapturedEdge = fillRate === null ? null : Math.max(0, input.makerNetEdge) * fillRate;
  const takerAdvantage = makerExpectedCapturedEdge === null ? null : input.currentNetEdge - makerExpectedCapturedEdge;
  const failures: string[] = [];
  if (input.makerMissFallback) {
    if (!(input.currentNetEdge > 1e-12)) failures.push(`fresh taker edge ${(input.currentNetEdge * 100).toFixed(1)}pp is not positive`);
    if (input.confidence + 1e-12 < input.minimumConfidence) failures.push(`quality ${(input.confidence * 100).toFixed(1)}% < ${(input.minimumConfidence * 100).toFixed(1)}%`);
    if (input.spread > input.maximumSpread + 1e-12) failures.push(`spread ${(input.spread * 100).toFixed(1)}c > ${(input.maximumSpread * 100).toFixed(1)}c`);
  }
  const recommendedStyle: EntryExecutionStyle = input.makerMissFallback && !failures.length ? 'taker' : 'maker';
  const executedStyle: EntryExecutionStyle = input.mode === 'maker' ? 'maker' : recommendedStyle;
  const route = recommendedStyle === 'taker' ? 'maker-miss-taker-fallback' : 'ordinary-maker';
  const reason = recommendedStyle === 'taker'
    ? `Authoritative zero-spend predecessor permits one bounded fresh-quote IOC.${input.mode === 'maker' ? ' Shadow only; live remains maker.' : ''}`
    : input.makerMissFallback ? `Taker fallback withheld: ${failures.join('; ')}.` : 'First intent uses the managed maker route.';
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
