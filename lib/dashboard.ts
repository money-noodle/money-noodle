import { basisProbability, clampProbability, impliedVolatility, logit, realizedVolatility, resolveVolatility, sigmoid } from './basis-model';
import { PRODUCTION_BASIS_LOG_ODDS_WEIGHT, PRODUCTION_PROBABILITY_CAP, createCalibrationReplaySnapshot } from './calibration-replay';
import { compareContractTargets } from './contract-provenance';
import { cached, recordOracleHistory, recordPriceHistory, recordVenueHistory, type OracleSnapshot, type PriceSnapshot, type VenueSnapshot } from './cache';
import { collectorStatus } from './collector-state';
import { recordCyclePathObservations } from './cycle-path-store';
import { fetchCoinSnapshots, fetchCryptoNews, fetchKalshiQuotes, fetchPolymarketQuotes, fetchPriceSeries, fetchSeasonalHistory, type ContractReference, type CoinSnapshot, type PriceSeries } from './feeds';
import { DATA_FRESHNESS } from './freshness';
import { getPerformanceSummary } from './forecast-tracker';
import { estimateMakerTouch } from './maker-fill-model';
import { readPromotionLedger } from './model-promotion-store';
import { summarizePerformance } from './performance';
import { activePolicyManifest } from './policy-manifest';
import { bestEntry, edgeStrength, qualifiesAsBuyEdge, venueEntryOptions } from './prediction-policy';
import { buildQuoteTrajectorySpreadObservation, type QuotePathSample } from './quote-trajectory-spread';
import { estimateSettlementAverage } from './settlement-average';
import { getEnabledTradingVenues } from './trading-control';
import { getTradingProviderConfiguration, normalizeTradingProviderConfiguration } from './trading-provider-config-store';
import { isStatelessDeployment } from './runtime-environment';
import { tradingProviderRegistry } from './trading-provider-registry';
import { beginTaskCadenceRun, taskCadenceStatuses } from './task-cadence-runtime';
import type { ChartPoint, ContractBasis, DashboardData, Direction, Factor, MarketQuote, NewsItem, PolicyManifest, Prediction, PublicDashboardData, VenueQuote } from './types';

const minute = 60_000;
export const MODEL_VERSION = 'Blend 0.4';

// The contract resolves on distance from a fixed open reference, so that term carries the forecast.
// Venue quotes stay a secondary cross-check, and slow regime features are bounded nudges only.
// The tradeable forecast is venue-independent: edge is measured against the venue price, so mixing
// that price into the forecast would shrink the disagreement the desk exists to trade. The venue is
// blended only into a separate reference figure used for comparison and calibration benchmarking.
// One definition, shared with the replay path and the published policy manifest. It was previously
// declared here as a second literal 0.55 beside the exported one; they agreed by coincidence, and the
// manifest quoted a third literal of its own, so a change to any of them would have left the desk
// describing a weight it was not using.
const BASIS_LOG_ODDS_WEIGHT = PRODUCTION_BASIS_LOG_ODDS_WEIGHT;
/** Tradeable probability is clamped this far from certainty at both ends. */
export const MIN_TRADEABLE_PROBABILITY = PRODUCTION_PROBABILITY_CAP;
export const MAX_TRADEABLE_PROBABILITY = 1 - PRODUCTION_PROBABILITY_CAP;
const VENUE_LOG_ODDS_WEIGHT = 0.30;
const VENUE_ONLY_LOG_ODDS_WEIGHT = 0.80;
const TILT_SCALE = 0.8;
const MAX_TILT_LOG_ODDS = 0.4;
const clamp = (value: number, min = -1, max = 1) => Math.min(max, Math.max(min, value));
const direction = (score: number): Direction => score > 0.08 ? 'bullish' : score < -0.08 ? 'bearish' : 'neutral';
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

interface WeightedFactor {
  factor: Factor;
  logOdds: number;
}

function makeFactor(input: Omit<Factor, 'direction' | 'contribution'>): Factor {
  return { ...input, direction: direction(input.score), contribution: 0 };
}

/** Slow features may only nudge a 15-minute forecast, and only in proportion to their own confidence. */
function tilt(input: Omit<Factor, 'direction' | 'contribution'>): WeightedFactor {
  return { factor: makeFactor(input), logOdds: input.score * input.weight * input.confidence * TILT_SCALE };
}

function seasonalFactor(symbol: string, history: PriceSnapshot[], weeklyHistory: ChartPoint[] = []): Factor {
  const now = new Date();
  const byYear = new Map<number, number[]>();
  for (const point of weeklyHistory) {
    const date = new Date(point.time);
    if (date.getUTCFullYear() === now.getUTCFullYear() || date.getUTCMonth() !== now.getUTCMonth()) continue;
    const prices = byYear.get(date.getUTCFullYear()) ?? [];
    prices.push(point.price);
    byYear.set(date.getUTCFullYear(), prices);
  }
  const samples = [...byYear.values()].filter((prices) => prices.length >= 3).map((prices) => ((prices.at(-1)! / prices[0]) - 1) * 100);

  // The hourly local record becomes a fallback after it has accumulated enough prior-year observations.
  if (samples.length < 2) {
    const localYears = new Map<number, number[]>();
    for (const point of history) {
      const date = new Date(point.time);
      if (date.getUTCFullYear() === now.getUTCFullYear() || date.getUTCMonth() !== now.getUTCMonth() || !point.prices[symbol]) continue;
      const prices = localYears.get(date.getUTCFullYear()) ?? [];
      prices.push(point.prices[symbol]);
      localYears.set(date.getUTCFullYear(), prices);
    }
    for (const prices of localYears.values()) if (prices.length >= 24) samples.push(((prices.at(-1)! / prices[0]) - 1) * 100);
  }

  const available = samples.length >= 2;
  const average = available ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
  return makeFactor({
    id: 'seasonal',
    label: 'Seasonal pattern',
    eyebrow: `${samples.length}-year same-month sample`,
    score: available ? clamp(average / 18) : 0,
    weight: 0.12,
    confidence: available ? clamp(samples.length / 5, 0.35, 1) : 0.1,
    summary: available ? `${pct(average)} average return in this calendar month` : 'Building a multi-year baseline',
    detail: available
      ? `Compares weekly closes during this calendar month across ${samples.length} prior years. The average is directional; sample size still controls confidence.`
      : 'This factor requires at least two prior years with three weekly observations. It remains neutral until enough genuine history exists.',
    source: weeklyHistory.length ? 'Kraken weekly OHLC' : 'Local history cache',
    available,
  });
}

function newsFactor(coin: CoinSnapshot, news: NewsItem[]): Factor {
  const aliases: Record<string, string[]> = {
    BTC: ['bitcoin', 'btc', 'crypto'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana', 'sol'],
    XRP: ['xrp', 'ripple'], DOGE: ['dogecoin', 'doge'], BNB: ['bnb', 'binance'], HYPE: ['hyperliquid', 'hype'],
  };
  const relevant = news.filter((item) => aliases[coin.symbol]?.some((alias) => item.title.toLowerCase().includes(alias)));
  const selected = relevant.length ? relevant : news.slice(0, 5);
  const score = selected.length ? selected.reduce((sum, item) => sum + item.score, 0) / selected.length : 0;
  return makeFactor({
    id: 'news',
    label: 'News pulse',
    eyebrow: `${relevant.length} asset-specific headlines`,
    score: clamp(score),
    weight: 0.09,
    confidence: relevant.length ? clamp(relevant.length / 4, 0.25, 1) : 0.2,
    summary: direction(score) === 'neutral' ? 'Headline flow is balanced' : `${direction(score) === 'bullish' ? 'Constructive' : 'Cautious'} headline sentiment`,
    detail: `Rule-based sentiment over recent CoinDesk RSS headlines. ${relevant.length ? 'Asset-specific matches are used.' : 'No direct matches; the broad crypto pulse is used at low confidence.'}`,
    source: 'CoinDesk RSS · lexical v0.1',
    available: news.length > 0,
  });
}

export function buildPrediction(coin: CoinSnapshot, market: MarketQuote | undefined, news: NewsItem[], history: PriceSnapshot[], weeklyHistory: ChartPoint[], kalshi?: VenueQuote, venueHistory: VenueSnapshot[] = [], enabledTradingVenues: Array<'polymarket' | 'kalshi'> = ['polymarket', 'kalshi'], reference?: ContractReference, minuteCloses: number[] = [], oracleHistory: OracleSnapshot[] = []): Prediction {
  const quote: MarketQuote = market ?? {
    probabilityUp: 0.5, probabilityDown: 0.5, liquidity: 0, volume: 0, url: 'https://polymarket.com/crypto/15M',
    closesAt: new Date(Math.ceil(Date.now() / (15 * minute)) * 15 * minute).toISOString(), live: false,
  };
  const range = coin.price ? ((coin.high24h - coin.low24h) / coin.price) * 100 : 0;
  const liveVenueProbabilities = [quote.live ? quote.probabilityUp : null, kalshi?.live ? kalshi.probabilityUp : null].filter((value): value is number => value !== null);
  const recentVenueHistory = venueHistory.filter((point) => point.time >= Date.now() - DATA_FRESHNESS.venueSmoothingWindowMs && point.closesAt?.[coin.symbol] === quote.closesAt);
  const mean = (values: number[], fallback: number) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
  const smoothedPolymarket = mean(recentVenueHistory.map((point) => point.polymarket[coin.symbol]).filter(Number.isFinite), quote.probabilityUp);
  const smoothedKalshi = kalshi ? mean(recentVenueHistory.map((point) => point.kalshi[coin.symbol]).filter(Number.isFinite), kalshi.probabilityUp) : null;
  const makerFillEstimates = kalshi ? {
    UP: estimateMakerTouch({
      currentAsk: kalshi.askUp, passiveBid: kalshi.bidUp,
      quoteHistory: recentVenueHistory.flatMap((point) => {
        const ask = point.kalshiAskUp?.[coin.symbol];
        return ask === undefined ? [] : [{ time: point.time, ask }];
      }),
    }) ?? undefined,
    DOWN: estimateMakerTouch({
      currentAsk: kalshi.askDown, passiveBid: kalshi.bidDown,
      // Kalshi NO ask is the complement of the YES bid. Persisted YES books therefore reproduce
      // the exact selected-side quote path without inventing midpoint observations.
      quoteHistory: recentVenueHistory.flatMap((point) => {
        const yesBid = point.kalshiBidUp?.[coin.symbol];
        return yesBid === undefined ? [] : [{ time: point.time, ask: 1 - yesBid }];
      }),
    }) ?? undefined,
  } : undefined;
  // Venue quotes are short-lived context, not the forecast. A three-minute mean reduces quote chasing, Polymarket
  // remains primary for its target contract, and the complete venue factor contributes only 15% of the model.
  const venueProbability = quote.live && smoothedKalshi !== null
    ? smoothedPolymarket * 0.75 + smoothedKalshi * 0.25
    : quote.live ? smoothedPolymarket : smoothedKalshi ?? 0.5;
  const venueDivergence = quote.live && kalshi?.live ? Math.abs(quote.probabilityUp - kalshi.probabilityUp) : 0;
  const venueLabel = [quote.live ? `Poly ${Math.round(quote.probabilityUp * 100)}¢` : null, kalshi?.live ? `Kalshi ${Math.round(kalshi.probabilityUp * 100)}¢` : null].filter(Boolean).join(' · ');
  const secondsRemaining = Math.max(0, (new Date(quote.closesAt).getTime() - Date.now()) / 1000);
  const referencePrice = reference?.referencePrice ?? kalshi?.floorStrike;
  const currentPrice = reference?.currentPrice ?? coin.price;
  const oracleSamples = oracleHistory.filter((point) => Number.isFinite(point.prices[coin.symbol]));
  const oracleSpacingSeconds = oracleSamples.length > 1
    ? (oracleSamples.at(-1)!.time - oracleSamples[0].time) / (oracleSamples.length - 1) / 1000
    : 0;
  // One-minute returns are the primary estimator: higher-frequency sampling mostly adds
  // microstructure noise, which would inflate volatility and fabricate edge.
  const volatility = resolveVolatility([
    realizedVolatility(minuteCloses, 60),
    realizedVolatility(oracleSamples.map((point) => point.prices[coin.symbol]), oracleSpacingSeconds),
  ]);
  const basisResult = referencePrice && volatility
    ? basisProbability({ referencePrice, currentPrice, secondsRemaining, volatilityPerSecond: volatility.perSecond, volatilitySamples: volatility.samples })
    : null;
  const basis: ContractBasis | undefined = basisResult && referencePrice ? {
    referencePrice, currentPrice, referenceSource: reference?.referenceSource ?? 'Kalshi floor strike',
    basisPercent: (currentPrice / referencePrice - 1) * 100,
    secondsRemaining, volatilityPerSecond: volatility!.perSecond, volatilitySamples: volatility!.samples,
    standardDeviationPercent: basisResult.standardDeviation * 100,
    zScore: basisResult.zScore, probabilityUp: basisResult.probabilityUp,
  } : undefined;
  const settlementAverageEstimate = basis && referencePrice ? estimateSettlementAverage({
    referencePrice, currentPrice, closesAtMs: Date.parse(quote.closesAt), nowMs: Date.now(),
    volatilityPerSecond: basis.volatilityPerSecond,
    windowSeconds: quote.contract?.settlementWindowSeconds ?? kalshi?.contract?.settlementWindowSeconds,
    observations: oracleHistory.flatMap((point) => {
      const price = point.prices[coin.symbol];
      return price === undefined ? [] : [{ time: point.time, price }];
    }),
  }) ?? undefined : undefined;
  if (basis && liveVenueProbabilities.length) {
    const implied = impliedVolatility({ logBasis: basisResult!.logBasis, marketProbability: venueProbability, secondsRemaining });
    if (implied) {
      basis.impliedVolatilityPerSecond = implied;
      basis.volatilityRatio = basis.volatilityPerSecond / implied;
    }
  }

  const basisFactor = makeFactor({
    id: 'basis', label: 'Contract basis', eyebrow: basis ? `${pct(basis.basisPercent)} vs open · ${Math.round(secondsRemaining)}s left` : 'Reference price unavailable',
    score: basis ? clamp((basis.probabilityUp - 0.5) * 2) : 0,
    weight: BASIS_LOG_ODDS_WEIGHT,
    confidence: basis ? clamp(0.4 + Math.min(1, basis.volatilitySamples / 60) * 0.4 + (1 - Math.min(1, secondsRemaining / 900)) * 0.2, 0.3, 1) : 0.1,
    summary: basis
      ? `${basis.basisPercent >= 0 ? 'Above' : 'Below'} the settlement reference by ${Math.abs(basis.basisPercent).toFixed(3)}% (${basis.zScore >= 0 ? '+' : ''}${basis.zScore.toFixed(2)}σ)`
      : 'No oracle reference price; falling back to venue pricing',
    detail: basis
      ? `These contracts settle by comparing the closing average against a reference fixed at cycle open, so the forecast is P(settlement ≥ reference). Current distance is ${basis.basisPercent.toFixed(3)}% against a ${basis.standardDeviationPercent.toFixed(3)}% expected move over the remaining ${Math.round(secondsRemaining)} seconds, using realized volatility from ${basis.volatilitySamples} one-minute returns and no assumed drift.`
      : 'Requires the venue oracle reference price and a realized-volatility sample. Without both, this term is withheld instead of guessed and model confidence is reduced.',
    source: basis ? `${basis.referenceSource} · Kraken 1m realized volatility` : 'Unavailable',
    available: Boolean(basis),
  });

  const marketFactor = makeFactor({
    id: 'market', label: 'Prediction markets', eyebrow: venueLabel || 'No live venue quote',
    score: (venueProbability - 0.5) * 2, weight: basis ? VENUE_LOG_ODDS_WEIGHT : VENUE_ONLY_LOG_ODDS_WEIGHT,
    confidence: liveVenueProbabilities.length ? clamp(0.45 + liveVenueProbabilities.length * 0.18 + Math.log10(Math.max(quote.liquidity, 10)) / 12 - venueDivergence * 0.5, 0.25, 1) : 0.15,
    summary: liveVenueProbabilities.length > 1 ? `Smoothed cross-venue prior is ${(venueProbability * 100).toFixed(0)}% UP` : liveVenueProbabilities.length ? `Smoothed venue prior is ${(venueProbability * 100).toFixed(0)}% UP` : 'Live markets unavailable; neutral prior used',
    detail: `A rolling ${DATA_FRESHNESS.venueSmoothingWindowMs / 60_000}-minute venue average acts as an independent cross-check on the basis term rather than the primary forecast. ${liveVenueProbabilities.length > 1 ? `Current Polymarket/Kalshi divergence is ${(venueDivergence * 100).toFixed(1)} points, which lowers this factor's confidence and overall model confidence. ` : ''}${basis ? '' : 'Because no oracle reference is available, this term temporarily carries most of the forecast at reduced confidence. '}The forecast targets contract settlement, not the next ${DATA_FRESHNESS.dashboardPollMs / 1000}-second refresh.`,
    source: liveVenueProbabilities.length > 1 ? 'Polymarket Gamma · Kalshi Trade API' : quote.live ? 'Polymarket Gamma API' : 'Kalshi Trade API', available: liveVenueProbabilities.length > 0,
  });

  const tilts: WeightedFactor[] = [
    tilt({
      id: 'intraday', label: 'Intraday momentum', eyebrow: `1h ${pct(coin.change1h)} · 24h ${pct(coin.change24h)}`,
      score: clamp((coin.change1h * 0.7 + coin.change24h * 0.3) / 2.5), weight: 0.34,
      confidence: clamp(0.5 + Math.abs(coin.change1h) / 10, 0, 0.9),
      summary: `${direction(coin.change1h) === 'neutral' ? 'Flat' : direction(coin.change1h) === 'bullish' ? 'Positive' : 'Negative'} short-term tape`,
      detail: 'The strongest of the slow features for a 15-minute horizon, but still only a bounded nudge because the reported one-hour change lags the oracle price the contract settles on.',
      source: 'CoinGecko', available: true,
    }),
    tilt({
      id: 'monthly', label: 'Monthly trend', eyebrow: `30d ${pct(coin.change30d)}`,
      score: clamp(coin.change30d / 20), weight: 0.06, confidence: 0.5,
      summary: `${coin.change30d >= 0 ? 'Trading above' : 'Trading below'} its monthly starting level`,
      detail: 'A 30-day regime prior has almost no measured value over 15 minutes, so its weight was cut sharply after review of the resolved track record.',
      source: 'CoinGecko', available: true,
    }),
    tilt({
      id: 'yearly', label: 'Yearly regime', eyebrow: `1y ${pct(coin.change1y)}`,
      score: clamp(coin.change1y / 80), weight: 0.03, confidence: 0.4,
      summary: `${direction(coin.change1y) === 'bullish' ? 'Risk-on' : direction(coin.change1y) === 'bearish' ? 'Risk-off' : 'Sideways'} long-cycle backdrop`,
      detail: 'Retained only as background context. A persistent yearly return previously imposed a standing directional bias on every 15-minute forecast.',
      source: 'CoinGecko', available: true,
    }),
    (() => { const factor = seasonalFactor(coin.symbol, history, weeklyHistory); return { factor, logOdds: factor.score * factor.weight * factor.confidence * TILT_SCALE }; })(),
    (() => { const factor = newsFactor(coin, news); return { factor, logOdds: factor.score * factor.weight * factor.confidence * TILT_SCALE }; })(),
  ];

  const basisLogOdds = basis ? logit(basis.probabilityUp) * BASIS_LOG_ODDS_WEIGHT : 0;
  const venueLogOdds = liveVenueProbabilities.length ? logit(venueProbability) * (basis ? VENUE_LOG_ODDS_WEIGHT : VENUE_ONLY_LOG_ODDS_WEIGHT) : 0;
  const rawTilt = tilts.reduce((sum, item) => sum + item.logOdds, 0);
  const tiltLogOdds = Math.max(-MAX_TILT_LOG_ODDS, Math.min(MAX_TILT_LOG_ODDS, rawTilt));
  const tiltScaling = rawTilt === 0 ? 1 : tiltLogOdds / rawTilt;
  const weighted: WeightedFactor[] = [
    { factor: basisFactor, logOdds: basisLogOdds },
    { factor: marketFactor, logOdds: venueLogOdds },
    ...tilts.map((item) => ({ factor: item.factor, logOdds: item.logOdds * tiltScaling })),
  ];
  // The tradeable estimate excludes the venue term entirely.
  const independentLogOdds = weighted.filter((item) => item.factor.id !== 'market').reduce((sum, item) => sum + item.logOdds, 0);
  const totalLogOdds = weighted.reduce((sum, item) => sum + item.logOdds, 0);
  const probability = clampProbability(sigmoid(independentLogOdds), MIN_TRADEABLE_PROBABILITY, MAX_TRADEABLE_PROBABILITY);
  const blendedProbabilityUp = clampProbability(sigmoid(totalLogOdds), MIN_TRADEABLE_PROBABILITY, MAX_TRADEABLE_PROBABILITY);
  // Each contribution is the exact marginal effect of removing that term from the blended reference.
  for (const item of weighted) item.factor.contribution = (blendedProbabilityUp - clampProbability(sigmoid(totalLogOdds - item.logOdds), MIN_TRADEABLE_PROBABILITY, MAX_TRADEABLE_PROBABILITY)) * 100;
  const factors = weighted.map((item) => item.factor);

  const edge = probability - quote.probabilityUp;
  // Confidence measures trust in our own estimate only. Agreement with the venue is excluded on
  // purpose: penalising disagreement would block precisely the mispricings this desk targets.
  const confidenceBreakdown = {
    base: 0.30,
    dataQuality: (basis ? 0.20 : 0) + (liveVenueProbabilities.length ? 0.04 : 0),
    sampleQuality: basis ? Math.min(1, basis.volatilitySamples / 60) * 0.22 : 0,
    uncertaintyPenalty: Math.min(0.12, (secondsRemaining / 900) * 0.12)
      + (basis ? 0 : 0.16)
      + Math.min(0.04, range / 60),
  };
  const confidence = clamp(confidenceBreakdown.base + confidenceBreakdown.dataQuality + confidenceBreakdown.sampleQuality - confidenceBreakdown.uncertaintyPenalty, 0.25, 0.86);
  // Persisted after confidence exists so the snapshot carries the exact inputs it was computed from,
  // and can verify its own replay against the value production actually used.
  const calibrationReplay = createCalibrationReplaySnapshot({
    basis,
    slowTiltLogOdds: tiltLogOdds,
    slowTerms: tilts.map((item) => ({ id: item.factor.id, logOdds: item.logOdds * tiltScaling })),
    productionProbabilityUp: probability,
    confidence: {
      productionConfidence: confidence,
      input: {
        basisPresent: Boolean(basis),
        venueProbabilityCount: liveVenueProbabilities.length,
        volatilitySamples: basis?.volatilitySamples ?? 0,
        secondsRemaining, rangePercent: range,
      },
    },
  });
  const targetComparison = quote.contract && kalshi?.contract
    ? compareContractTargets(quote.contract, kalshi.contract) : undefined;
  const prediction: Prediction = {
    symbol: coin.symbol, name: coin.name, iconUrl: coin.iconUrl, price: coin.price, priceChange24h: coin.change24h,
    modelProbabilityUp: probability, edge, confidence, confidenceBreakdown, basis, calibrationReplay,
    settlementAverageEstimate, makerFillEstimates, blendedProbabilityUp, targetComparison,
    venueProbabilityUp: liveVenueProbabilities.length ? venueProbability : undefined,
    venueDisagreement: quote.live && kalshi?.live ? venueDivergence : undefined,
    signal: 'PASS', market: quote, kalshi, enabledTradingVenues, factors, chart: coin.chart,
  };
  const selectedEntry = bestEntry(prediction);
  prediction.signal = qualifiesAsBuyEdge(prediction) && selectedEntry ? selectedEntry.side : Math.abs(edge) >= 0.04 ? 'WATCH' : 'PASS';
  prediction.makerFillEstimate = selectedEntry ? makerFillEstimates?.[selectedEntry.side] : undefined;
  return prediction;
}

/** Cached venue data may survive a boundary fetch failure; never carry a prior Kalshi contract into the new window. */
export function alignedKalshiQuote(market: MarketQuote | undefined, quote: VenueQuote | undefined, nowMs = Date.now()): VenueQuote | undefined {
  if (!market || !quote) return undefined;
  const marketClose = Date.parse(market.closesAt), kalshiClose = Date.parse(quote.closesAt);
  if (!Number.isFinite(marketClose) || !Number.isFinite(kalshiClose) || kalshiClose <= nowMs || Math.abs(marketClose - kalshiClose) > 5_000) return undefined;
  return quote;
}

function polymarketContractId(symbol: string, quote: MarketQuote): string {
  return quote.contract?.contractId ?? quote.url.split('/').filter(Boolean).at(-1) ?? symbol;
}

function quotePathSamples(input: {
  market: Record<string, MarketQuote>;
  kalshi: Record<string, VenueQuote>;
  polymarketSourceObservedAt: number;
  kalshiSourceObservedAt: number;
}): QuotePathSample[] {
  const samples: QuotePathSample[] = [];
  for (const [symbol, quote] of Object.entries(input.market)) {
    if (!quote.live || [quote.bidUp, quote.askUp, quote.bidDown, quote.askDown].some((value) => value === undefined)) continue;
    samples.push({
      providerId: 'polymarket', symbol, contractId: polymarketContractId(symbol, quote), closesAt: quote.closesAt,
      sourceObservedAt: input.polymarketSourceObservedAt,
      bidUp: quote.bidUp!, askUp: quote.askUp!, bidDown: quote.bidDown!, askDown: quote.askDown!,
    });
  }
  for (const [symbol, quote] of Object.entries(input.kalshi)) {
    if (!quote.live) continue;
    samples.push({
      providerId: 'kalshi', symbol, contractId: quote.ticker, closesAt: quote.closesAt,
      sourceObservedAt: input.kalshiSourceObservedAt,
      bidUp: quote.bidUp, askUp: quote.askUp, bidDown: quote.bidDown, askDown: quote.askDown,
    });
  }
  return samples;
}

async function buildDashboard(force = false, liveOnly = false): Promise<DashboardData> {
  const refreshSlowFeeds = force && !liveOnly;
  const [coinsResult, marketResult, kalshiResult, newsResult, seasonalResult, referenceResult] = await Promise.all([
    cached('coingecko', DATA_FRESHNESS.coinGeckoCacheMs, fetchCoinSnapshots, refreshSlowFeeds),
    cached('polymarket', DATA_FRESHNESS.polymarketCacheMs, fetchPolymarketQuotes, force),
    cached('kalshi', DATA_FRESHNESS.kalshiCacheMs, fetchKalshiQuotes, force)
      .catch(() => ({ value: {} as Record<string, VenueQuote>, fromCache: false, savedAt: Date.now() })),
    cached('news', DATA_FRESHNESS.newsCacheMs, fetchCryptoNews, refreshSlowFeeds),
    cached('seasonal-history', DATA_FRESHNESS.seasonalCacheMs, fetchSeasonalHistory, false)
      .catch(() => ({ value: {} as Record<string, ChartPoint[]>, fromCache: false, savedAt: Date.now() })),
    cached('price-series', DATA_FRESHNESS.contractReferenceCacheMs, fetchPriceSeries, force)
      .catch(() => ({ value: {} as Record<string, PriceSeries>, fromCache: false, savedAt: Date.now() })),
  ]);
  const calculationAtMs = Date.now();
  const minuteResult = { value: Object.fromEntries(Object.values(referenceResult.value).map((entry) => [entry.symbol, entry.closes])), fromCache: referenceResult.fromCache };
  const alignedKalshi = Object.fromEntries(Object.entries(kalshiResult.value).flatMap(([symbol, quote]) => {
    const aligned = alignedKalshiQuote(marketResult.value[symbol], quote, calculationAtMs);
    return aligned ? [[symbol, aligned]] : [];
  })) as Record<string, VenueQuote>;
  const prices = Object.fromEntries(coinsResult.value.map((coin) => [coin.symbol, coin.price]));
  const history = await recordPriceHistory(prices);
  const oracleHistory = await recordOracleHistory(
    Object.fromEntries(Object.values(referenceResult.value).map((entry) => [entry.symbol, entry.currentPrice])),
    referenceResult.savedAt,
  );
  const venueHistory = await recordVenueHistory(
    Object.fromEntries(Object.entries(marketResult.value).map(([symbol, quote]) => [symbol, quote.probabilityUp])),
    Object.fromEntries(Object.entries(alignedKalshi).map(([symbol, quote]) => [symbol, quote.probabilityUp])),
    Object.fromEntries(Object.entries(marketResult.value).map(([symbol, quote]) => [symbol, quote.closesAt])),
    {
      polymarketBidUp: Object.fromEntries(Object.entries(marketResult.value).flatMap(([symbol, quote]) => quote.bidUp === undefined ? [] : [[symbol, quote.bidUp]])),
      polymarketAskUp: Object.fromEntries(Object.entries(marketResult.value).flatMap(([symbol, quote]) => quote.askUp === undefined ? [] : [[symbol, quote.askUp]])),
      kalshiBidUp: Object.fromEntries(Object.entries(alignedKalshi).map(([symbol, quote]) => [symbol, quote.bidUp])),
      kalshiAskUp: Object.fromEntries(Object.entries(alignedKalshi).map(([symbol, quote]) => [symbol, quote.askUp])),
      quotePathSamples: quotePathSamples({
        market: marketResult.value, kalshi: alignedKalshi,
        polymarketSourceObservedAt: marketResult.savedAt, kalshiSourceObservedAt: kalshiResult.savedAt,
      }),
    },
  );
  const stateless = isStatelessDeployment();
  // The hosted dashboard can research public markets but has no durable provider-control store.
  // Never migrate/write local permissions from a serverless request.
  const enabledTradingVenues = stateless
    ? ['polymarket', 'kalshi'] as Array<'polymarket' | 'kalshi'>
    : await getEnabledTradingVenues().catch(() => ['polymarket', 'kalshi'] as Array<'polymarket' | 'kalshi'>);
  const providerConfiguration = stateless
    ? normalizeTradingProviderConfiguration({ executionAuthority: 'provider-registry-v1' })
    : await getTradingProviderConfiguration(enabledTradingVenues);
  const tradingProviders = tradingProviderRegistry(providerConfiguration);
  // A missing or unreadable ledger must not fail the dashboard: an empty ledger is reported as an
  // unrecorded production model, which is exactly what an unreadable one means for the operator.
  const promotions = stateless ? [] : await readPromotionLedger().catch((error) => {
    console.error('Model promotion ledger read failed:', error);
    return [];
  });
  const predictions = coinsResult.value
    .map((coin) => buildPrediction(coin, marketResult.value[coin.symbol], newsResult.value, history, seasonalResult.value[coin.symbol] ?? [], alignedKalshi[coin.symbol], venueHistory, enabledTradingVenues, referenceResult.value[coin.symbol], minuteResult.value[coin.symbol] ?? [], oracleHistory))
    .sort((a, b) => edgeStrength(b) - edgeStrength(a));
  // Persist regime diagnostics separately and attach the current path prefix for later outcome
  // analysis. Nothing below reads these features into probability, confidence, ranking, or gates.
  const cycleRegimes = stateless ? {} as Record<string, NonNullable<Prediction['cycleRegime']>>
    : await recordCyclePathObservations(predictions, oracleHistory, calculationAtMs).catch((error) => {
      console.error('Cycle path tracking failed:', error);
      return {} as Record<string, NonNullable<Prediction['cycleRegime']>>;
    });
  const collectedQuoteSamples = venueHistory.flatMap((point) => point.quotePathSamples ?? []);
  for (const prediction of predictions) {
    prediction.cycleRegime = cycleRegimes[prediction.symbol];
    const underlyingSamples = oracleHistory.flatMap((point) => {
      const price = point.prices[prediction.symbol];
      return point.sourceObservedAt === undefined || !Number.isFinite(price)
        ? [] : [{ sourceObservedAt: point.sourceObservedAt, price }];
    });
    const quoteTrajectorySpreads = venueEntryOptions(prediction).flatMap((option) => {
      const contractId = option.venue === 'kalshi'
        ? prediction.kalshi?.ticker
        : polymarketContractId(prediction.symbol, prediction.market);
      const closesAt = option.venue === 'kalshi' ? prediction.kalshi?.closesAt : prediction.market.closesAt;
      if (!contractId || !closesAt) return [];
      return [buildQuoteTrajectorySpreadObservation({
        calculationAtMs, symbol: prediction.symbol, providerId: option.venue,
        contractId, side: option.side, closesAt, underlyingSamples, quoteSamples: collectedQuoteSamples,
      })];
    });
    // Alternate execution slices exist only on the process-local object used by the order builder. Keeping
    // them non-enumerable prevents the signed dashboard and forecast persistence from duplicating raw choices.
    Object.defineProperty(prediction, 'quoteTrajectorySpreads', {
      value: quoteTrajectorySpreads, enumerable: false, configurable: false, writable: false,
    });
    const entry = bestEntry(prediction);
    prediction.quoteTrajectorySpread = entry
      ? quoteTrajectorySpreads.find((observation) => observation.providerId === entry.venue
        && observation.side === entry.side) : undefined;
  }
  // Request-triggered dashboard builds are read-only for forecast evidence. Only the durable collector
  // records this completed calculation; Next.js bundles request and instrumentation entrypoints separately.
  const performance = stateless ? summarizePerformance([]) : await getPerformanceSummary().catch((error) => {
    console.error('Forecast performance read failed:', error);
    return summarizePerformance([]);
  });
  const generatedAt = new Date(calculationAtMs);
  return {
    generatedAt: generatedAt.toISOString(), expiresAt: new Date(generatedAt.getTime() + minute).toISOString(),
    modelVersion: MODEL_VERSION,
    tradingProviders,
    policyManifest: activePolicyManifest(tradingProviders, MODEL_VERSION, promotions),
    collector: collectorStatus(),
    taskCadences: taskCadenceStatuses({ stateless }),
    sourceStatus: {
      polymarket: Object.values(marketResult.value).some((quote) => quote.live),
      kalshi: Object.values(alignedKalshi).some((quote) => quote.live), coinGecko: coinsResult.value.length > 0,
      news: newsResult.value.length > 0, historical: Object.keys(seasonalResult.value).length > 0,
      contractReference: Object.keys(referenceResult.value).length > 0,
      volatility: Object.keys(minuteResult.value).length > 0,
      cache: coinsResult.fromCache || marketResult.fromCache || kalshiResult.fromCache || newsResult.fromCache || seasonalResult.fromCache || referenceResult.fromCache || minuteResult.fromCache,
    },
    predictions, performance, news: newsResult.value,
    disclaimer: 'Research only—not financial advice. Prediction-market prices and model outputs can be wrong. Verify liquidity, spread, and source data before acting.',
  };
}

let latestDashboard: DashboardData | undefined;
let buildInFlight: Promise<DashboardData> | undefined;
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Public policy explains immutable model rules but never provider permissions or readiness, and never
 * the promotion record: its reasons and held-out evidence are derived from the private track record.
 */
function publicPolicyManifest(manifest: PolicyManifest): PolicyManifest {
  const { model: _model, ...publicManifest } = manifest;
  return { ...publicManifest, components: manifest.components.filter((component) => component.kind !== 'provider') };
}

/** Removes every control/performance field from the unauthenticated server response. */
export function publicDashboardData(dashboard: DashboardData): PublicDashboardData {
  const { tradingProviders: _providers, performance: _performance, policyManifest, ...publicData } = dashboard;
  const predictions = publicData.predictions.map(({
    quoteTrajectorySpread: _trajectory, quoteTrajectorySpreads: _trajectories, ...prediction
  }) => prediction);
  return { ...publicData, predictions, policyManifest: publicPolicyManifest(policyManifest) };
}

/**
 * How far ahead of expiry the next calculation begins.
 *
 * A calculation that starts when the previous one expires is late by however long it takes. Starting
 * this early means a fresh result exists at the boundary instead of arriving after it — so the lead
 * must exceed a normal build, including one feed spending its full timeout.
 */
const REFRESH_AFTER_MS = DATA_FRESHNESS.calculationRefreshMs;
/** Hard floor between builds, so no future scheduling change can turn this into a hot loop. */
const MIN_REBUILD_SPACING_MS = 5_000;

const dashboardAge = () => latestDashboard ? Date.now() - Date.parse(latestDashboard.generatedAt) : Number.POSITIVE_INFINITY;

/** One build at a time. Concurrent callers join the running build rather than queueing another. */
function startDashboardBuild(force: boolean, liveOnly: boolean): Promise<DashboardData> {
  if (buildInFlight) return buildInFlight;
  const started = Date.now();
  const taskRun = beginTaskCadenceRun('dashboard-calculation', started);
  buildInFlight = buildDashboard(force, liveOnly)
    .then((dashboard) => {
      taskRun.succeed();
      dashboard.taskCadences = taskCadenceStatuses({ stateless: isStatelessDeployment() });
      latestDashboard = dashboard;
      return dashboard;
    })
    .catch((error) => {
      taskRun.fail(error);
      throw error;
    })
    .finally(() => {
      const elapsed = Date.now() - started;
      // A build slower than the window it serves means the cycle cannot keep up; say so rather than
      // silently rebuilding faster and consuming the capacity that reconciliation needs.
      if (elapsed > DATA_FRESHNESS.dashboardPollMs) console.warn(`Dashboard build took ${elapsed}ms, longer than the ${DATA_FRESHNESS.dashboardPollMs}ms window.`);
      buildInFlight = undefined;
      scheduleDashboardPrefetch();
    });
  return buildInFlight;
}

/**
 * Keeps the cached calculation continuously ahead of its own expiry, so neither the browser poll nor
 * the trading cycle ever waits on feed assembly. Without this the two fixed clocks beat against each
 * other: a slow build shifted the phase so every second tick landed inside the cache window and was
 * discarded, halving the real calculation rate to one per 30 seconds.
 */
function scheduleDashboardPrefetch(): void {
  if (isStatelessDeployment() || prefetchTimer) return;
  // A fixed gap after the previous build, deliberately not shortened by how long that build took.
  // Subtracting the build duration to "catch up" inverts under load: once a build exceeds the lead the
  // delay collapses to its floor, so the server rebuilds continuously, which saturates the CPU and
  // makes builds slower still. That loop pegged a machine for nine hours and starved Kalshi
  // reconciliation of event-loop time until it timed out and suspended live trading. When builds are
  // slower than the window, the correct response is to fall behind, not to spin.
  const delay = Math.max(MIN_REBUILD_SPACING_MS, REFRESH_AFTER_MS);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = undefined;
    void startDashboardBuild(false, false).catch((error) => console.error('Dashboard prefetch failed:', error));
  }, delay);
  prefetchTimer.unref?.();
}

export function getDashboard(force = false, liveOnly = false): Promise<DashboardData> {
  // Browser polling and the background collector share one calculation rather than duplicating feed
  // assembly, history scoring, persistence, and multi-megabyte serialization.
  if (!force && latestDashboard && dashboardAge() >= 0 && dashboardAge() < REFRESH_AFTER_MS) {
    scheduleDashboardPrefetch();
    return Promise.resolve(latestDashboard);
  }
  return startDashboardBuild(force, liveOnly);
}
