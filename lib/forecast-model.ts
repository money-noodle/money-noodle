import { basisProbability, clampProbability, logit, sigmoid, type BasisInput, type BasisResult } from './basis-model';

/**
 * Pure venue-independent forecast model.
 *
 * Data acquisition and factor explanations remain in `dashboard`; this module owns the arithmetic that turns
 * one contract-basis probability plus bounded slow terms into the probability the buy policy receives. Keeping
 * that boundary pure lets observation-only candidates call the same implementation without importing a
 * dashboard, store, execution mode, or order path.
 */
export interface ForecastModelSpec {
  version: string;
  basisLogOddsWeight: number;
  /** Scale applied to each score × declared weight × factor-confidence term before the aggregate cap. */
  slowTermScale: number;
  /** Candidate-level multiplier applied after production's aggregate slow-tilt cap. */
  slowTiltScale: number;
  maximumSlowTiltLogOdds: number;
  temperature: number;
  probabilityFloor: number;
  probabilityCeiling: number;
}

export interface ForecastSlowTermInput {
  id: string;
  /** Factor score × factor weight × factor confidence, before the production slow-term scale and cap. */
  baseLogOdds: number;
}

export interface ForecastModelInput {
  basisProbabilityUp?: number;
  slowTerms: ForecastSlowTermInput[];
}

export interface ForecastModelResult {
  basisLogOdds: number;
  rawSlowTiltLogOdds: number;
  slowTiltLogOdds: number;
  slowTiltScaling: number;
  slowTerms: Array<{ id: string; logOdds: number }>;
  totalLogOdds: number;
  probabilityUp: number;
}

/** Exact constants used by Blend 0.4 before this extraction. Changing one changes production behavior. */
export const PRODUCTION_FORECAST_MODEL: Readonly<ForecastModelSpec> = Object.freeze({
  version: 'blend-0.4-forecast-model-v1',
  basisLogOddsWeight: 0.55,
  slowTermScale: 0.8,
  slowTiltScale: 1,
  maximumSlowTiltLogOdds: 0.4,
  temperature: 1,
  probabilityFloor: 0.03,
  probabilityCeiling: 0.97,
});

/** The current settlement-basis calculation, exposed behind the model boundary for exact candidate parity. */
export function evaluateForecastBasis(input: BasisInput | undefined): BasisResult | null {
  return input ? basisProbability(input) : null;
}

/**
 * Combines an already-computed basis probability and slow tilt. Calibration replay calls this same primitive,
 * so production and candidates cannot silently diverge on log-odds weighting, temperature, or final caps.
 */
export function combineForecastProbability(input: {
  basisProbabilityUp?: number;
  slowTiltLogOdds: number;
}, parameters: Pick<ForecastModelSpec,
  'basisLogOddsWeight' | 'slowTiltScale' | 'temperature' | 'probabilityFloor' | 'probabilityCeiling'>): Pick<ForecastModelResult,
    'basisLogOdds' | 'slowTiltLogOdds' | 'totalLogOdds' | 'probabilityUp'> {
  const basisLogOdds = input.basisProbabilityUp === undefined
    ? 0 : logit(input.basisProbabilityUp) * parameters.basisLogOddsWeight;
  const slowTiltLogOdds = input.slowTiltLogOdds * parameters.slowTiltScale;
  const totalLogOdds = (basisLogOdds + slowTiltLogOdds) * parameters.temperature;
  return {
    basisLogOdds, slowTiltLogOdds, totalLogOdds,
    probabilityUp: clampProbability(sigmoid(totalLogOdds), parameters.probabilityFloor, parameters.probabilityCeiling),
  };
}

export function evaluateForecastModel(
  input: ForecastModelInput,
  spec: ForecastModelSpec = PRODUCTION_FORECAST_MODEL,
): ForecastModelResult {
  const scaledTerms = input.slowTerms.map((term) => ({
    id: term.id,
    logOdds: term.baseLogOdds * spec.slowTermScale,
  }));
  const rawSlowTiltLogOdds = scaledTerms.reduce((sum, term) => sum + term.logOdds, 0);
  const boundedSlowTiltLogOdds = Math.max(
    -spec.maximumSlowTiltLogOdds,
    Math.min(spec.maximumSlowTiltLogOdds, rawSlowTiltLogOdds),
  );
  const capScaling = rawSlowTiltLogOdds === 0 ? 1 : boundedSlowTiltLogOdds / rawSlowTiltLogOdds;
  const combined = combineForecastProbability({
    basisProbabilityUp: input.basisProbabilityUp,
    slowTiltLogOdds: boundedSlowTiltLogOdds,
  }, spec);
  return {
    ...combined,
    rawSlowTiltLogOdds,
    // Includes both aggregate-cap scaling and the candidate-level slow multiplier. Production's multiplier is 1.
    slowTiltScaling: capScaling * spec.slowTiltScale,
    slowTerms: scaledTerms.map((term) => ({
      ...term,
      logOdds: term.logOdds * capScaling * spec.slowTiltScale,
    })),
  };
}
