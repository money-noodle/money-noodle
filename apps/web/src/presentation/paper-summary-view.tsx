// The compact simulated summary: the forecast counters and the trade record.
//
// Two source times, because the record carries two and they mean different things: when
// the source last recomputed the document, and when the row it lives in was last written.
// Both are the source's clock, and neither is this site's.
//
// `null` is published where a denominator is zero, and it is shown as a dash. That is a
// real answer — "nothing has resolved yet" — and substituting a zero would turn it into a
// measurement of nothing.

import type {
  ForecastHistoryEntry,
  ForecastSignalSummary,
  PaperPerformanceSummary,
  PaperTrackSummary,
} from '@money-noodle/platform-api-client';

import { DASH, formatCount, formatNumber, formatRatio, formatSignedCents } from './format';
import { Panel, SourceTime } from './page-shell';

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function ForecastCounters({ summary }: { readonly summary: ForecastSignalSummary }) {
  return (
    <dl className="figures">
      <Row label="Forecasts issued" value={formatCount(summary.issued)} />
      <Row label="Resolved" value={formatCount(summary.resolved)} />
      <Row label="Accuracy" value={formatRatio(summary.accuracy)} />
      <Row label="Cycle-balanced accuracy" value={formatRatio(summary.cycleBalancedAccuracy)} />
      <Row label="Brier score (lower is better)" value={formatNumber(summary.brierScore, 4)} />
      <Row label="Current cycle streak" value={formatCount(summary.currentCycleStreak)} />
      <Row
        label="Calibration windows"
        value={`${formatCount(summary.calibrationWindows)} of ${formatCount(
          summary.calibrationMinimum,
        )} required`}
      />
      <Row
        label="Calibration readable"
        value={
          summary.calibrationReady ? 'Yes' : `Not yet (${formatRatio(summary.calibrationProgress)})`
        }
      />
    </dl>
  );
}

export function PaperRecordCounters({ record }: { readonly record: PaperTrackSummary }) {
  return (
    <dl className="figures">
      <Row label="Settled positions" value={formatCount(record.settled)} />
      <Row label="Settlement windows" value={formatCount(record.windows)} />
      <Row label="Wins" value={formatCount(record.wins)} />
      <Row label="Losses" value={formatCount(record.losses)} />
      <Row label="Win rate (over settled)" value={formatRatio(record.winRate)} />
      <Row label="Return on stake" value={formatRatio(record.roi)} />
      <Row
        label="Realized profit and loss, lifetime"
        value={formatSignedCents(record.realizedPnlCents)}
      />
      <Row label="Mean predicted edge" value={formatRatio(record.meanPredictedEdge)} />
      <Row label="Mean realized return" value={formatNumber(record.meanRealizedReturn, 4)} />
    </dl>
  );
}

export function RecentForecasts({
  forecasts,
  limit,
}: {
  readonly forecasts: readonly ForecastHistoryEntry[];
  readonly limit?: number;
}) {
  const shown = limit === undefined ? forecasts : forecasts.slice(0, limit);
  if (shown.length === 0) {
    return <p className="panel__state">The record carries no forecasts.</p>;
  }

  return (
    <table className="forecasts">
      <caption>
        {limit === undefined || forecasts.length <= shown.length
          ? `All ${formatCount(forecasts.length)} forecasts the record publishes, newest first.`
          : `The ${formatCount(shown.length)} newest of ${formatCount(
              forecasts.length,
            )} published forecasts.`}
      </caption>
      <thead>
        <tr>
          <th scope="col">Asset</th>
          <th scope="col">Direction</th>
          <th scope="col">Likelihood</th>
          <th scope="col">Confidence</th>
          <th scope="col">Issued</th>
          <th scope="col">State</th>
          <th scope="col">Outcome</th>
          <th scope="col">Correct</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((forecast) => (
          <tr key={forecast.id}>
            <th scope="row">{forecast.symbol}</th>
            <td>{forecast.direction}</td>
            <td>{formatRatio(forecast.directionalLikelihood)}</td>
            <td>{formatRatio(forecast.confidence)}</td>
            <td>
              <time dateTime={forecast.issuedAt}>{forecast.issuedAt}</time>
            </td>
            <td>{forecast.status}</td>
            <td>{forecast.outcome ?? DASH}</td>
            <td>{forecast.correct === undefined ? DASH : forecast.correct ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PaperSummaryView({
  compact = false,
  summary,
}: {
  readonly compact?: boolean;
  readonly summary: PaperPerformanceSummary;
}) {
  return (
    <Panel heading="Simulated record" headingId="paper-summary-heading">
      <SourceTime label="Computed by the simulation at" value={summary.generatedAt} />
      <SourceTime label="Stored record last written at" value={summary.sourceUpdatedAt} />
      <ForecastCounters summary={summary.summary} />
      <PaperRecordCounters record={summary.paperRecord} />
      {compact ? (
        <p className="panel__note">
          The full forecast and simulated-trade record, with its segments, benchmarks and
          calibration bins, is on the <a href="/paper/performance">simulated record</a> view.
        </p>
      ) : (
        <RecentForecasts forecasts={summary.summary.recent} />
      )}
    </Panel>
  );
}
