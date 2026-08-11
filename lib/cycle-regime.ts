import type { CyclePathPoint, CycleRegimeFeatures, CycleRegimeLabel } from './types';

const finite = (value: number): number | null => Number.isFinite(value) ? value : null;

function lagOneAutocorrelation(values: number[]): number | null {
  if (values.length < 3) return null;
  const left = values.slice(0, -1), right = values.slice(1);
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftSquares = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightSquares = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator > 1e-20 ? Math.max(-1, Math.min(1, numerator / denominator)) : null;
}

function regimeLabel(count: number, flips: number | null, autocorrelation: number | null, efficiency: number | null): CycleRegimeLabel {
  if (count < 4 || efficiency === null) return 'insufficient';
  if (efficiency >= 0.65 && (autocorrelation === null || autocorrelation >= -0.15)) return 'trending';
  if ((flips ?? 0) >= 0.65 && (autocorrelation ?? 0) < 0) return 'mean-reverting';
  return 'mixed';
}

/** Computes path shape only. It deliberately has no dependency on forecasts, venue prices, or policy. */
export function summarizeCyclePath(input: Array<Pick<CyclePathPoint, 'at' | 'price'>>): CycleRegimeFeatures {
  const points = input
    .filter((point) => Number.isFinite(Date.parse(point.at)) && Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const observedAt = points.at(-1)?.at ?? new Date(0).toISOString();
  const coverageSeconds = points.length > 1 ? Math.max(0, (Date.parse(points.at(-1)!.at) - Date.parse(points[0].at)) / 1000) : 0;
  const returns: number[] = [];
  let elapsedSeconds = 0;
  let squaredLogMovement = 0;
  let pathDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const change = Math.log(points[index].price / points[index - 1].price);
    const seconds = (Date.parse(points[index].at) - Date.parse(points[index - 1].at)) / 1000;
    if (!Number.isFinite(change) || !(seconds > 0)) continue;
    returns.push(change);
    elapsedSeconds += seconds;
    squaredLogMovement += change ** 2;
    pathDistance += Math.abs(points[index].price - points[index - 1].price);
  }
  const signs = returns.map((value) => value > 1e-12 ? 1 : value < -1e-12 ? -1 : 0).filter((value) => value !== 0);
  let flips = 0;
  for (let index = 1; index < signs.length; index += 1) if (signs[index] !== signs[index - 1]) flips += 1;
  const signFlipRate = signs.length > 1 ? flips / (signs.length - 1) : null;
  const prices = points.map((point) => point.price);
  const trendEfficiency = points.length > 1 && pathDistance > 0 ? Math.abs(points.at(-1)!.price - points[0].price) / pathDistance : null;
  const rangePercent = prices.length ? (Math.max(...prices) / Math.min(...prices) - 1) * 100 : null;
  const localVolatilityPerSecond = elapsedSeconds > 0 ? Math.sqrt(squaredLogMovement / elapsedSeconds) : null;
  const autocorrelation = lagOneAutocorrelation(returns);
  return {
    observedAt, observationCount: points.length, coverageSeconds,
    signFlipRate: finite(signFlipRate as number), lagOneAutocorrelation: finite(autocorrelation as number),
    trendEfficiency: finite(trendEfficiency as number), rangePercent: finite(rangePercent as number),
    localVolatilityPerSecond: finite(localVolatilityPerSecond as number),
    localVolatility15mPercent: localVolatilityPerSecond === null ? null : localVolatilityPerSecond * Math.sqrt(900) * 100,
    regime: regimeLabel(points.length, signFlipRate, autocorrelation, trendEfficiency),
  };
}
