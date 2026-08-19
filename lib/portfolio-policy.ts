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

/**
 * Concurrent positions the desk may hold.
 *
 * **Raised 3 -> 9 on 2026-08-18.** The cap was refusing 39% of the decisions the desk could actually have
 * executed: 1,633 executable decisions across 632 settlement windows, of which the 2-per-window and
 * 1-per-group limits admitted only 992. Candidates do not all present at once, so a three-slot desk fills
 * with the first arrivals rather than the best of the window — measured, it held no live position 75% of
 * the time yet still passed over decisions in the 15-31pp band that returns +44% per $1.
 *
 * Stacking has been the better cohort for this strategy, which is why this is a raise rather than a
 * tightening: multi-position windows returned +2.3% live against -5.7% for single-position windows, and
 * positions sharing a correlation group returned +19.3%. That is the opposite of the long-shot policy,
 * where stacked windows lost together 7 times in 9 — long-shot buys sides that got cheap *because* the
 * underlying moved, so its stacked positions are one directional bet repeated.
 */
export const DEFAULT_MAX_OPEN_POSITIONS = 9;
export const MAX_CONFIGURABLE_OPEN_POSITIONS = 10;

export function parseMaximumOpenPositions(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_MAX_OPEN_POSITIONS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_CONFIGURABLE_OPEN_POSITIONS)
    : DEFAULT_MAX_OPEN_POSITIONS;
}

export const DEFAULT_PORTFOLIO_CONSTRAINTS: PortfolioConstraints = {
  maximumPositions: DEFAULT_MAX_OPEN_POSITIONS,
  // Raised 2 -> 6 and 1 -> 3 with the position cap. The per-group limit is the lever: 1 -> 2 captures
  // +31% of executable decisions and 1 -> 3 captures +57%. Per-window capture saturates at 6 — nine
  // slots per window would catch nine more decisions out of 1,633 — so the total cap, not the per-window
  // one, is what leaves headroom across overlapping settlement times.
  maximumSameWindow: 6,
  maximumSameGroupPerWindow: 3,
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
