// The market overview: what the venues and price sources say right now.
//
// One article per asset, in the API's own order. That order is registry order and carries
// no ranking — the earlier generation of this dashboard sorted by a policy score, which is
// model output and is not part of this capability — so nothing here re-sorts, re-ranks or
// filters the list.
//
// What is absent stays absent. An asset the venues have not listed shows no quote; a feed
// that is unavailable shows no figures from it. There is no forecast, no signal, no
// expected value and no fill estimate anywhere on this page, and nothing stands in for
// them: they arrive with the engine, and a placeholder now would imply data that does not
// exist.

import type {
  MarketAssetOverview,
  MarketContractBasis,
  MarketHeadline,
  MarketOverview,
  MarketVenueQuote,
} from '@money-noodle/platform-api-client';

import { FeedFreshness } from './feed-freshness';
import {
  DASH,
  formatCompactUsd,
  formatContractPrice,
  formatCount,
  formatNumber,
  formatPercentUnits,
  formatRatio,
  formatRemaining,
  formatSpotPrice,
} from './format';
import { Panel, SourceTime } from './page-shell';
import { Sparkline } from './sparkline';

const VENUE_NAMES = { kalshi: 'Kalshi', polymarket: 'Polymarket' } as const;

const FEED_LABELS = [
  ['spot', 'Spot prices and 7-day series'],
  ['polymarketQuotes', 'Polymarket 15-minute quotes'],
  ['kalshiQuotes', 'Kalshi 15-minute quotes'],
  ['referencePrices', 'Exchange 1-minute reference series'],
  ['longHistory', 'Weekly price history'],
  ['news', 'Headlines'],
] as const;

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function QuoteRow({ quote }: { readonly quote: MarketVenueQuote }) {
  return (
    <tr>
      <th scope="row">{VENUE_NAMES[quote.venue]}</th>
      <td>{formatRatio(quote.probabilityUp)}</td>
      <td>{formatContractPrice(quote.bidUp)}</td>
      <td>{formatContractPrice(quote.askUp)}</td>
      <td>{formatContractPrice(quote.bidDown)}</td>
      <td>{formatContractPrice(quote.askDown)}</td>
      <td>{formatCompactUsd(quote.liquidityUsd)}</td>
      <td>
        {quote.volumeUsd === undefined
          ? quote.volumeContracts === undefined
            ? DASH
            : `${formatCount(quote.volumeContracts)} contracts`
          : formatCompactUsd(quote.volumeUsd)}
      </td>
      <td>
        <time dateTime={quote.closesAt}>{quote.closesAt}</time>
      </td>
      <td>{quote.live ? 'Accepting orders' : 'Not accepting orders'}</td>
    </tr>
  );
}

function VenueQuotes({ asset }: { readonly asset: MarketAssetOverview }) {
  const quotes = [asset.polymarket, asset.kalshi].filter(
    (quote): quote is MarketVenueQuote => quote !== undefined,
  );

  if (quotes.length === 0) {
    return (
      <p className="asset__absent">
        Neither venue published a quote for the cycle now trading. No placeholder quote is shown.
      </p>
    );
  }

  return (
    <table className="quotes">
      <caption>
        Fifteen-minute up/down quotes for {asset.name}. Prices are cents of a one-dollar settlement.
        {asset.kalshi === undefined
          ? ' Only one venue is shown: the other published no contract settling in this window.'
          : ''}
      </caption>
      <thead>
        <tr>
          <th scope="col">Venue</th>
          <th scope="col">Implied up</th>
          <th scope="col">Bid up</th>
          <th scope="col">Ask up</th>
          <th scope="col">Bid down</th>
          <th scope="col">Ask down</th>
          <th scope="col">Liquidity</th>
          <th scope="col">Volume</th>
          <th scope="col">Settles</th>
          <th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        {quotes.map((quote) => (
          <QuoteRow key={quote.venue} quote={quote} />
        ))}
      </tbody>
    </table>
  );
}

function ContractBasis({ basis }: { readonly basis: MarketContractBasis }) {
  return (
    <dl className="figures">
      <Figure label="Settlement reference" value={formatSpotPrice(basis.referencePrice)} />
      <Figure label="Reference source" value={basis.referenceSource} />
      <Figure label="Current price" value={formatSpotPrice(basis.currentPrice)} />
      <Figure label="Distance from reference" value={formatPercentUnits(basis.basisPercent)} />
      <Figure label="Time to settlement" value={formatRemaining(basis.secondsRemaining)} />
      <Figure
        label="Realized volatility (per root second)"
        value={formatNumber(basis.volatilityPerSecond)}
      />
      <Figure label="One-minute returns used" value={formatCount(basis.volatilitySamples)} />
      <Figure
        label="Expected movement to settlement"
        value={formatPercentUnits(basis.standardDeviationPercent)}
      />
      <Figure label="Distance in standard deviations" value={formatNumber(basis.zScore, 4)} />
      <Figure label="Probability above reference" value={formatRatio(basis.probabilityUp)} />
      <Figure
        label="Volatility implied by the venues"
        value={formatNumber(basis.impliedVolatilityPerSecond)}
      />
      <Figure label="Realized over implied" value={formatNumber(basis.volatilityRatio, 4)} />
    </dl>
  );
}

function AssetArticle({ asset }: { readonly asset: MarketAssetOverview }) {
  const headingId = `asset-${asset.symbol.toLowerCase()}`;
  const spot = asset.spot;

  return (
    <article aria-labelledby={headingId} className="asset">
      <h3 id={headingId}>
        {asset.name} <span className="asset__symbol">{asset.symbol}</span>
      </h3>

      {spot === undefined ? (
        <p className="asset__absent">No spot snapshot was published for this asset.</p>
      ) : (
        <>
          <dl className="figures">
            <Figure label="Price" value={formatSpotPrice(spot.price)} />
            <Figure label="Change, 24 hours" value={formatPercentUnits(spot.change24hPercent)} />
            <Figure label="Change, 7 days" value={formatPercentUnits(spot.change7dPercent)} />
            <Figure label="High, 24 hours" value={formatSpotPrice(spot.high24h)} />
            <Figure label="Low, 24 hours" value={formatSpotPrice(spot.low24h)} />
            <Figure label="Volume, 24 hours" value={formatCompactUsd(spot.volume24h)} />
          </dl>
          <Sparkline
            points={spot.chart}
            title={`${asset.name} price over the published seven-day series`}
            titleId={`${headingId}-chart`}
          />
          <p className="asset__note">
            Series times are estimated by the API: the source publishes prices without times, so
            points are spaced evenly back from when the value was obtained.
          </p>
        </>
      )}

      <VenueQuotes asset={asset} />

      <dl className="figures">
        <Figure
          label="Combined venue probability (up)"
          value={formatRatio(asset.venueProbabilityUp)}
        />
        <Figure label="Venue disagreement" value={formatRatio(asset.venueDisagreement)} />
        <Figure label="Weekly closes published" value={formatCount(asset.longHistory.length)} />
      </dl>

      {asset.basis === undefined ? (
        <p className="asset__absent">
          No distance-to-reference figures: the API publishes them only with both a settlement
          reference and a usable volatility sample.
        </p>
      ) : (
        <ContractBasis basis={asset.basis} />
      )}
    </article>
  );
}

function Headlines({ headlines }: { readonly headlines: readonly MarketHeadline[] }) {
  if (headlines.length === 0) {
    return <p className="panel__state">No headlines were published by the source.</p>;
  }

  return (
    <ul className="headlines">
      {headlines.map((headline) => (
        <li key={headline.link ?? headline.title}>
          {headline.link === undefined ? (
            <span>{headline.title}</span>
          ) : (
            <a href={headline.link} rel="nofollow noopener noreferrer">
              {headline.title}
            </a>
          )}
          {headline.publishedAt === undefined ? null : (
            <>
              {' '}
              <time dateTime={headline.publishedAt}>{headline.publishedAt}</time>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MarketOverviewView({ overview }: { readonly overview: MarketOverview }) {
  return (
    <>
      <Panel heading="Market data" headingId="market-heading">
        <SourceTime label="Assembled by the API at" value={overview.generatedAt} />
        <div className="feeds">
          {FEED_LABELS.map(([key, label]) => (
            <FeedFreshness feed={overview.feeds[key]} key={key} label={label} />
          ))}
        </div>
        <p className="panel__note">
          Each source states its own freshness above. A stale source is a value whose refresh failed
          and which is still inside the API&rsquo;s five-minute limit; an unavailable source shows
          no figures at all rather than a zero. Reloading re-reads what the API has — there is no
          way to make it ask a source sooner.
        </p>
        {overview.assets.length === 0 ? (
          <p className="panel__state">The API published no assets for this market.</p>
        ) : (
          overview.assets.map((asset) => <AssetArticle asset={asset} key={asset.symbol} />)
        )}
      </Panel>

      <Panel heading="Headlines" headingId="headlines-heading">
        <Headlines headlines={overview.headlines} />
        <p className="panel__note">
          Published in the source&rsquo;s own order, as plain text. No sentiment or score is derived
          from a headline.
        </p>
      </Panel>
    </>
  );
}
