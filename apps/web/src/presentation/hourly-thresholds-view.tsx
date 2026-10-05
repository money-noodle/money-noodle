// The hourly threshold research view.
//
// Per asset: the hour the venue is trading, the price and volatility the model reads, and
// each contract with its own strike, its own quote and its own probability. The two sides
// are not complements of one another — they carry different strikes — so each is shown
// against its own asking price and nothing is inferred from the other.
//
// The probability beside a quote is arithmetic over public data whose inputs are published
// next to it. It is not advice, not a position and not an entry decision, and the
// difference from the asking price is shown because it is the obvious subtraction of two
// numbers already on the page.
//
// The completed-minutes note is deliberate and belongs on this view: the API reads only
// finished one-minute candles, where the earlier generation of this dashboard used the
// minute still forming. A reader comparing the two should know which one this is.

import type {
  HourlyThresholdCandidate,
  HourlyThresholdMarket,
  HourlyThresholdMarkets,
  HourlyUnavailableReason,
} from '@money-noodle/platform-api-client';

import { FeedFreshness } from './feed-freshness';
import {
  formatContractPrice,
  formatCount,
  formatModelProbability,
  formatNumber,
  formatSignedPoints,
  formatSpotPrice,
} from './format';
import { Panel, SourceTime } from './page-shell';

/** Each reason the API can publish, said in a sentence. */
const REASONS: Readonly<Record<HourlyUnavailableReason, string>> = Object.freeze({
  'above-ambiguous': 'the venue listed more than one contract above a strike',
  'above-missing': 'the venue listed no contract above a strike',
  'below-ambiguous': 'the venue listed more than one contract below a strike',
  'below-missing': 'the venue listed no contract below a strike',
  'no-active-hour-group': 'the venue lists no exact one-hour contract trading now',
  'upstream-invalid': 'the venue answered with something unusable',
  'upstream-rate-limited': 'the venue declined for rate reasons',
  'upstream-timeout': 'the venue did not answer in time',
  'upstream-unavailable': 'the venue could not be reached',
});

const METHODS = {
  'point-in-time': 'a single price at a stated moment',
  'simple-average': 'a simple average over the stated window',
  'time-weighted-average': 'a time-weighted average over the stated window',
  unknown: 'not determined from the published rules',
} as const;

function CandidateRow({ candidate }: { readonly candidate: HourlyThresholdCandidate }) {
  return (
    <tr>
      <th scope="row">{candidate.label}</th>
      <td>{candidate.displaySide}</td>
      <td>{formatSpotPrice(candidate.strike)}</td>
      <td>{formatContractPrice(candidate.bidYes)}</td>
      <td>{formatContractPrice(candidate.askYes)}</td>
      <td>{formatContractPrice(candidate.bidNo)}</td>
      <td>{formatContractPrice(candidate.askNo)}</td>
      <td>{formatModelProbability(candidate.modelProbabilityYes)}</td>
      <td>{formatSignedPoints(candidate.modelMinusAsk)}</td>
    </tr>
  );
}

function MarketArticle({ market }: { readonly market: HourlyThresholdMarket }) {
  const headingId = `hourly-${market.symbol.toLowerCase()}`;

  return (
    <article aria-labelledby={headingId} className="asset">
      <h3 id={headingId}>
        {market.name} <span className="asset__symbol">{market.symbol}</span>
      </h3>

      <p className="panel__state">
        {market.marketDataAvailable
          ? 'A complete, unambiguous pair is listed for the hour now trading.'
          : 'No complete pair for this asset.'}
        {market.unavailableReasons.length === 0
          ? ''
          : ` Reported: ${market.unavailableReasons.map((reason) => REASONS[reason]).join('; ')}.`}
      </p>

      <FeedFreshness feed={market.listing} label="Contract listing" />
      {market.spot === undefined ? (
        <p className="asset__note">
          The price series was not read for this asset: the API reads it only when a contract
          survived, so there is nothing to price.
        </p>
      ) : (
        <FeedFreshness feed={market.spot} label="Price series" />
      )}

      <dl className="figures">
        <div>
          <dt>Hour opened</dt>
          <dd>
            {market.openAt === undefined ? (
              '—'
            ) : (
              <time dateTime={market.openAt}>{market.openAt}</time>
            )}
          </dd>
        </div>
        <div>
          <dt>Hour settles</dt>
          <dd>
            {market.closesAt === undefined ? (
              '—'
            ) : (
              <time dateTime={market.closesAt}>{market.closesAt}</time>
            )}
          </dd>
        </div>
        <div>
          <dt>Current price (last completed minute)</dt>
          <dd>{formatSpotPrice(market.currentPrice)}</dd>
        </div>
        <div>
          <dt>Realized volatility (per root second)</dt>
          <dd>{formatNumber(market.volatilityPerSecond)}</dd>
        </div>
        <div>
          <dt>One-minute returns used</dt>
          <dd>{formatCount(market.volatilitySamples)}</dd>
        </div>
      </dl>

      {market.candidates.length === 0 ? (
        <p className="asset__absent">No contracts are shown for this asset.</p>
      ) : (
        <>
          <table className="candidates">
            <caption>
              Contracts for {market.name}, above the strike before below. Quotes are cents of a
              one-dollar settlement; the probability is the model&rsquo;s, and the difference is
              that probability minus the asking price.
            </caption>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Shown as</th>
                <th scope="col">Strike</th>
                <th scope="col">Bid, yes</th>
                <th scope="col">Ask, yes</th>
                <th scope="col">Bid, no</th>
                <th scope="col">Ask, no</th>
                <th scope="col">Model probability, yes</th>
                <th scope="col">Model minus ask</th>
              </tr>
            </thead>
            <tbody>
              {market.candidates.map((candidate) => (
                <CandidateRow candidate={candidate} key={candidate.ticker} />
              ))}
            </tbody>
          </table>

          {market.candidates.some((candidate) => candidate.modelUnavailableReason !== undefined) ? (
            <p className="asset__note">
              A contract with no model probability had no usable volatility estimate. The quote is
              still the venue&rsquo;s.
            </p>
          ) : null}

          <details className="terms">
            <summary>Settlement terms for these contracts</summary>
            <dl className="figures">
              {market.candidates.map((candidate) => (
                <div key={candidate.ticker}>
                  <dt>{candidate.ticker}</dt>
                  <dd>
                    Settles {candidate.relation === 'greater-than' ? 'above' : 'below'}{' '}
                    {formatSpotPrice(candidate.strike)} on{' '}
                    {METHODS[candidate.settlementPriceMethod]}. Terms fingerprint{' '}
                    <code>{candidate.rulesFingerprint}</code>.{' '}
                    <a href={candidate.marketUrl} rel="nofollow noopener noreferrer">
                      Venue page for this series
                    </a>
                    .
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </article>
  );
}

export function HourlyThresholdsView({ markets }: { readonly markets: HourlyThresholdMarkets }) {
  const available = markets.markets.filter((market) => market.marketDataAvailable).length;

  return (
    <Panel heading="Hourly threshold contracts" headingId="hourly-heading">
      <SourceTime label="Assembled by the API at" value={markets.generatedAt} />
      <p className="panel__state">
        {formatCount(available)} of {formatCount(markets.markets.length)} assets have a complete
        pair for the hour now trading.
      </p>
      <dl className="figures">
        <div>
          <dt>Venue</dt>
          <dd>{markets.providerId}</dd>
        </div>
        <div>
          <dt>Settlement reference</dt>
          <dd>{markets.referenceSource}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{markets.modelVersion}</dd>
        </div>
        <div>
          <dt>Read</dt>
          <dd>{markets.marketDataVersion}</dd>
        </div>
      </dl>
      <p className="panel__note">
        <strong>Completed minutes only.</strong> The current price and the volatility sample are
        taken from finished one-minute candles; the minute still forming is dropped before either is
        computed. The earlier generation of this dashboard used that forming minute, so its
        &ldquo;current price&rdquo; moved within the minute and its newest return described part of
        one. This is an intentional difference.
      </p>
      <p className="panel__note">
        Observation only: market data, no simulated or funded position. The probability is a
        zero-drift log-normal estimate from the volatility above, unclamped and with no fee or
        spread assumption.
      </p>
      {markets.markets.length === 0 ? (
        <p className="panel__state">The API published no assets for this market.</p>
      ) : (
        markets.markets.map((market) => <MarketArticle key={market.symbol} market={market} />)
      )}
    </Panel>
  );
}
