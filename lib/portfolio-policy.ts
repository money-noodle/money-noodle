export type CryptoExposureGroup = 'majors' | 'layer1-beta' | 'alt-beta';

export interface PortfolioCandidate {
  id: string;
  symbol: string;
  closesAt: string;
  expectedProfitCents: number;
}
export interface PortfolioExposure { symbol: string; closesAt: string }
export interface PortfolioSelection {
  id: string;
  symbol: string;
  selected: boolean;
  rank: number | null;
  expectedProfitCents: number;
  adjustedExpectedContributionCents: number;
  correlatedPositions: number;
  reason: string;
}
export interface PortfolioConstraints {
  maximumPositions: number;
  maximumSameWindow: number;
  maximumSameGroupPerWindow: number;
  correlationPenaltyCents: number;
  sameGroupPenaltyCents: number;
}

export const DEFAULT_MAX_OPEN_POSITIONS = 3;
export const MAX_CONFIGURABLE_OPEN_POSITIONS = 10;

export function parseMaximumOpenPositions(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_MAX_OPEN_POSITIONS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_CONFIGURABLE_OPEN_POSITIONS)
    : DEFAULT_MAX_OPEN_POSITIONS;
}

export const DEFAULT_PORTFOLIO_CONSTRAINTS: PortfolioConstraints = {
  maximumPositions: DEFAULT_MAX_OPEN_POSITIONS,
  maximumSameWindow: 2,
  maximumSameGroupPerWindow: 1,
  correlationPenaltyCents: 1,
  sameGroupPenaltyCents: 1,
};

export function cryptoExposureGroup(symbol: string): CryptoExposureGroup {
  if (symbol === 'BTC' || symbol === 'ETH') return 'majors';
  if (symbol === 'SOL' || symbol === 'BNB' || symbol === 'HYPE') return 'layer1-beta';
  return 'alt-beta';
}

function adjusted(candidate: PortfolioCandidate, exposures: PortfolioExposure[], constraints: PortfolioConstraints): { value: number; correlated: number; sameGroup: number } {
  const sameWindow = exposures.filter((item) => item.closesAt === candidate.closesAt);
  const group = cryptoExposureGroup(candidate.symbol);
  const sameGroup = sameWindow.filter((item) => cryptoExposureGroup(item.symbol) === group).length;
  return {
    value: candidate.expectedProfitCents - sameWindow.length * constraints.correlationPenaltyCents - sameGroup * constraints.sameGroupPenaltyCents,
    correlated: sameWindow.length, sameGroup,
  };
}

/** Greedy constrained selection by expected dollar contribution after costs and correlation penalties. */
export function selectPortfolio(candidates: PortfolioCandidate[], existing: PortfolioExposure[], constraints: PortfolioConstraints = DEFAULT_PORTFOLIO_CONSTRAINTS): PortfolioSelection[] {
  const remaining = [...candidates];
  const exposures = [...existing];
  const selected = new Map<string, PortfolioSelection>();
  let rank = 1;
  while (remaining.length && exposures.length < constraints.maximumPositions) {
    const scored = remaining.map((candidate) => ({ candidate, ...adjusted(candidate, exposures, constraints) }))
      .sort((a, b) => b.value - a.value || b.candidate.expectedProfitCents - a.candidate.expectedProfitCents || a.candidate.symbol.localeCompare(b.candidate.symbol));
    const viable = scored.find((item) => {
      const sameWindow = exposures.filter((exposure) => exposure.closesAt === item.candidate.closesAt).length;
      const sameAssetWindow = exposures.some((exposure) => exposure.symbol === item.candidate.symbol && exposure.closesAt === item.candidate.closesAt);
      return !sameAssetWindow && sameWindow < constraints.maximumSameWindow && item.sameGroup < constraints.maximumSameGroupPerWindow && item.value > 0;
    });
    if (!viable) break;
    selected.set(viable.candidate.id, {
      id: viable.candidate.id, symbol: viable.candidate.symbol, selected: true, rank,
      expectedProfitCents: viable.candidate.expectedProfitCents,
      adjustedExpectedContributionCents: viable.value, correlatedPositions: viable.correlated,
      reason: `Portfolio rank #${rank}: ${viable.value.toFixed(2)}c expected contribution after correlation penalties.`,
    });
    exposures.push({ symbol: viable.candidate.symbol, closesAt: viable.candidate.closesAt });
    remaining.splice(remaining.findIndex((item) => item.id === viable.candidate.id), 1);
    rank += 1;
  }
  for (const candidate of remaining) {
    const score = adjusted(candidate, exposures, constraints);
    const sameWindow = exposures.filter((item) => item.closesAt === candidate.closesAt).length;
    const sameAssetWindow = exposures.some((exposure) => exposure.symbol === candidate.symbol && exposure.closesAt === candidate.closesAt);
    const reason = exposures.length >= constraints.maximumPositions ? `Blocked: portfolio already has ${constraints.maximumPositions} positions.`
      : sameAssetWindow ? `Blocked: ${candidate.symbol} already has exposure in this contract window; opposite-side exposure requires a validated reduce-only switch.`
      : score.sameGroup >= constraints.maximumSameGroupPerWindow ? `Blocked: ${cryptoExposureGroup(candidate.symbol)} group limit ${constraints.maximumSameGroupPerWindow} reached for this window.`
      : sameWindow >= constraints.maximumSameWindow ? `Blocked: same-window exposure limit ${constraints.maximumSameWindow} reached.`
      : score.value <= 0 ? `Blocked: correlation-adjusted expected contribution is ${score.value.toFixed(2)}c.`
      : 'Blocked by a higher-ranked constrained portfolio candidate.';
    selected.set(candidate.id, {
      id: candidate.id, symbol: candidate.symbol, selected: false, rank: null,
      expectedProfitCents: candidate.expectedProfitCents,
      adjustedExpectedContributionCents: score.value, correlatedPositions: score.correlated, reason,
    });
  }
  return candidates.map((candidate) => selected.get(candidate.id)!);
}
