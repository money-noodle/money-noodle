// The full simulated record, disclosed progressively.
//
// This document is the largest thing the API publishes: segments, benchmarks, calibration
// bins, per-venue records, fundings and a bounded forecast history. It is rendered on the
// server and delivered as markup — there is no client component here, so none of it is
// shipped to the browser as data to be re-rendered — and each part sits behind a closed
// disclosure so a reader opens what they came for rather than scrolling past all of it.
//
// Two lists are deliberately bounded below, and both say so where they are bounded: the
// timeline and the forecast history. The rest is published whole, because its size is the
// number of segments the source found rather than a page of a longer list.
//
// Every figure is the API's. `null` means the source has no value for it — usually a zero
// denominator — and is shown as a dash.

import type {
  ActionCounterfactualArm,
  BankrollEpoch,
  BenchmarkScore,
  CalibrationBin,
  CyclePathReport,
  EdgeBucket,
  ForecastRecordSummary,
  ForecastSlice,
  LeadTimeSlice,
  PaperPerformance,
  PaperTrackRecord,
  ProviderTrackRecord,
  SegmentGroup,
} from '@money-noodle/platform-api-client';

import { DASH, formatCount, formatNumber, formatRatio, formatSignedCents } from './format';
import { Panel, SourceTime } from './page-shell';
import { RecentForecasts } from './paper-summary-view';

/** Timeline points shown, newest last. The source publishes the whole run. */
export const TIMELINE_POINTS_SHOWN = 30;
/** Forecasts shown of the bounded history the source publishes. */
export const FORECASTS_SHOWN = 25;

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Disclosure({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) {
  return (
    <details className="record-section">
      <summary>{title}</summary>
      {children}
    </details>
  );
}

function SliceTable({
  caption,
  slices,
}: {
  readonly caption: string;
  readonly slices: readonly ForecastSlice[];
}) {
  if (slices.length === 0) {
    return <p className="panel__state">{caption}: nothing qualified.</p>;
  }
  return (
    <table className="record">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Resolved</th>
          <th scope="col">Correct</th>
          <th scope="col">Accuracy</th>
        </tr>
      </thead>
      <tbody>
        {slices.map((slice) => (
          <tr key={slice.label}>
            <th scope="row">{slice.label}</th>
            <td>{formatCount(slice.resolved)}</td>
            <td>{formatCount(slice.correct)}</td>
            <td>{formatRatio(slice.accuracy)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BenchmarkTable({ benchmarks }: { readonly benchmarks: readonly BenchmarkScore[] }) {
  if (benchmarks.length === 0) return <p className="panel__state">No benchmarks published.</p>;
  return (
    <table className="record">
      <caption>Benchmarks the source scored the forecasts against.</caption>
      <thead>
        <tr>
          <th scope="col">Benchmark</th>
          <th scope="col">Resolved</th>
          <th scope="col">Accuracy</th>
          <th scope="col">Brier</th>
          <th scope="col">Log loss</th>
        </tr>
      </thead>
      <tbody>
        {benchmarks.map((benchmark) => (
          <tr key={benchmark.label}>
            <th scope="row">{benchmark.label}</th>
            <td>{formatCount(benchmark.resolved)}</td>
            <td>{formatRatio(benchmark.accuracy)}</td>
            <td>{formatNumber(benchmark.brierScore, 4)}</td>
            <td>{formatNumber(benchmark.logLoss, 4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CalibrationTable({ bins }: { readonly bins: readonly CalibrationBin[] }) {
  if (bins.length === 0) return <p className="panel__state">No calibration bins published.</p>;
  return (
    <table className="record">
      <caption>
        Forecast probability against the rate actually observed, per bin, as the source computed
        them.
      </caption>
      <thead>
        <tr>
          <th scope="col">Bin</th>
          <th scope="col">Resolved</th>
          <th scope="col">Mean forecast</th>
          <th scope="col">Observed rate</th>
        </tr>
      </thead>
      <tbody>
        {bins.map((bin) => (
          <tr key={bin.label}>
            <th scope="row">{bin.label}</th>
            <td>{formatCount(bin.resolved)}</td>
            <td>{formatRatio(bin.meanForecast)}</td>
            <td>{formatRatio(bin.observedRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EdgeBucketTable({ buckets }: { readonly buckets: readonly EdgeBucket[] }) {
  if (buckets.length === 0) return <p className="panel__state">No edge buckets published.</p>;
  return (
    <table className="record">
      <caption>Predicted edge against realized return, per bucket.</caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          <th scope="col">Positions</th>
          <th scope="col">Predicted edge</th>
          <th scope="col">Realized return</th>
          <th scope="col">Win rate</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr key={bucket.label}>
            <th scope="row">{bucket.label}</th>
            <td>{formatCount(bucket.trades)}</td>
            <td>{formatRatio(bucket.predictedEdge)}</td>
            <td>{formatNumber(bucket.realizedReturn, 4)}</td>
            <td>{formatRatio(bucket.winRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LeadTimeTable({ slices }: { readonly slices: readonly LeadTimeSlice[] }) {
  if (slices.length === 0) return <p className="panel__state">No lead-time slices published.</p>;
  return (
    <table className="record">
      <caption>Accuracy by how long before settlement the forecast was issued.</caption>
      <thead>
        <tr>
          <th scope="col">Lead time</th>
          <th scope="col">Resolved</th>
          <th scope="col">Correct</th>
          <th scope="col">Accuracy</th>
          <th scope="col">Brier</th>
        </tr>
      </thead>
      <tbody>
        {slices.map((slice) => (
          <tr key={slice.label}>
            <th scope="row">{slice.label}</th>
            <td>{formatCount(slice.resolved)}</td>
            <td>{formatCount(slice.correct)}</td>
            <td>{formatRatio(slice.accuracy)}</td>
            <td>{formatNumber(slice.brierScore, 4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SegmentGroups({ groups }: { readonly groups: readonly SegmentGroup[] }) {
  if (groups.length === 0) return <p className="panel__state">No segments published.</p>;
  return (
    <>
      {groups.map((group) => (
        <table className="record" key={group.dimension}>
          <caption>
            {group.dimension}: {group.description}
          </caption>
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col">Positions</th>
              <th scope="col">Windows</th>
              <th scope="col">Mean predicted edge</th>
              <th scope="col">Mean realized return</th>
              <th scope="col">Standard error</th>
              <th scope="col">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {group.segments.map((segment) => (
              <tr key={segment.label}>
                <th scope="row">{segment.label}</th>
                <td>{formatCount(segment.trades)}</td>
                <td>{formatCount(segment.windows)}</td>
                <td>{formatRatio(segment.meanPredictedEdge)}</td>
                <td>{formatNumber(segment.meanRealizedReturn, 4)}</td>
                <td>{formatNumber(segment.standardError, 4)}</td>
                <td>{formatRatio(segment.winRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </>
  );
}

function TrackRecord({ record }: { readonly record: PaperTrackRecord }) {
  return (
    <dl className="figures">
      <Row label="Settled" value={formatCount(record.settled)} />
      <Row label="Pending" value={formatCount(record.pending)} />
      <Row label="Settlement windows" value={formatCount(record.windows)} />
      <Row label="Wins" value={formatCount(record.wins)} />
      <Row label="Losses" value={formatCount(record.losses)} />
      <Row label="Void" value={formatCount(record.invalid)} />
      <Row label="Exited early" value={formatCount(record.sold)} />
      <Row label="Unfilled" value={formatCount(record.unfilled)} />
      <Row label="Rejected" value={formatCount(record.rejected)} />
      <Row label="Staked" value={formatSignedCents(record.stakedCents)} />
      <Row label="Returned" value={formatSignedCents(record.returnedCents)} />
      <Row label="Realized profit and loss" value={formatSignedCents(record.realizedPnlCents)} />
      <Row label="Return on stake" value={formatRatio(record.roi)} />
      <Row label="Win rate (over settled)" value={formatRatio(record.winRate)} />
      <Row label="Mean predicted edge" value={formatRatio(record.meanPredictedEdge)} />
      <Row label="Mean realized return" value={formatNumber(record.meanRealizedReturn, 4)} />
      <Row label="Standard error" value={formatNumber(record.standardError, 4)} />
    </dl>
  );
}

function CounterfactualArms({ arms }: { readonly arms: readonly ActionCounterfactualArm[] }) {
  if (arms.length === 0) {
    return <p className="panel__state">No action comparisons published.</p>;
  }
  return (
    <table className="record">
      <caption>
        What the simulation&rsquo;s recorded decisions returned against the stated alternative, as
        the source computed it. Observation only.
      </caption>
      <thead>
        <tr>
          <th scope="col">Action</th>
          <th scope="col">Alternative</th>
          <th scope="col">Decisions</th>
          <th scope="col">Beat the alternative</th>
          <th scope="col">Hit rate</th>
          <th scope="col">Incremental</th>
          <th scope="col">Credible</th>
        </tr>
      </thead>
      <tbody>
        {arms.map((arm) => (
          <tr key={`${arm.action}-${arm.alternative}-${arm.policy}`}>
            <th scope="row">{arm.action}</th>
            <td>{arm.alternative}</td>
            <td>{formatCount(arm.decisions)}</td>
            <td>{formatCount(arm.decisionsBeatingAlternative)}</td>
            <td>{formatRatio(arm.hitRate)}</td>
            <td>{formatSignedCents(arm.incrementalCents)}</td>
            <td>{arm.credible ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProviderRecords({ records }: { readonly records: readonly ProviderTrackRecord[] }) {
  if (records.length === 0) {
    return <p className="panel__state">No per-venue records published.</p>;
  }
  return (
    <>
      {records.map((record) => (
        <section key={`${record.providerId}-${record.marketId}`}>
          <h4>
            {record.providerId} — {record.marketId}
          </h4>
          <TrackRecord record={record.record} />
        </section>
      ))}
    </>
  );
}

function Epochs({ epochs }: { readonly epochs: readonly BankrollEpoch[] }) {
  if (epochs.length === 0) return <p className="panel__state">No fundings published.</p>;
  return (
    <table className="record">
      <caption>One row per bankroll funding, oldest first.</caption>
      <thead>
        <tr>
          <th scope="col">Funding</th>
          <th scope="col">Positions</th>
          <th scope="col">Settled</th>
          <th scope="col">Realized</th>
          <th scope="col">Budget-basis realized</th>
          <th scope="col">Staked</th>
          <th scope="col">First</th>
          <th scope="col">Last</th>
          <th scope="col">Current</th>
        </tr>
      </thead>
      <tbody>
        {epochs.map((epoch) => (
          <tr key={epoch.epochId}>
            <th scope="row">{epoch.epochId}</th>
            <td>{formatCount(epoch.trades)}</td>
            <td>{formatCount(epoch.settled)}</td>
            <td>{formatSignedCents(epoch.realizedPnlCents)}</td>
            <td>{formatSignedCents(epoch.budgetPnlCents)}</td>
            <td>{formatSignedCents(epoch.stakedCents)}</td>
            <td>
              {epoch.firstAt === undefined ? (
                DASH
              ) : (
                <time dateTime={epoch.firstAt}>{epoch.firstAt}</time>
              )}
            </td>
            <td>
              {epoch.lastAt === undefined ? (
                DASH
              ) : (
                <time dateTime={epoch.lastAt}>{epoch.lastAt}</time>
              )}
            </td>
            <td>{epoch.current ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CyclePaths({ report }: { readonly report: CyclePathReport }) {
  return (
    <>
      <dl className="figures">
        <Row label="Policy version" value={report.policyVersion} />
        <Row label="Cycles observed" value={formatCount(report.totalCycles)} />
        <Row label="Cycles completed" value={formatCount(report.completedCycles)} />
        <Row label="Observations" value={formatCount(report.totalPoints)} />
      </dl>
      {report.latestByAsset.length === 0 ? (
        <p className="panel__state">No per-asset paths published.</p>
      ) : (
        <table className="record">
          <caption>The most recent observed path per asset. Observation-only diagnostics.</caption>
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Settles</th>
              <th scope="col">Observations</th>
              <th scope="col">Regime</th>
              <th scope="col">Sign-flip rate</th>
              <th scope="col">Range</th>
            </tr>
          </thead>
          <tbody>
            {report.latestByAsset.map((latest) => (
              <tr key={`${latest.symbol}-${latest.closesAt}`}>
                <th scope="row">{latest.symbol}</th>
                <td>
                  <time dateTime={latest.closesAt}>{latest.closesAt}</time>
                </td>
                <td>{formatCount(latest.features.observationCount)}</td>
                <td>{latest.features.regime}</td>
                <td>{formatRatio(latest.features.signFlipRate)}</td>
                <td>{formatNumber(latest.features.rangePercent, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function RecordSummary({ summary }: { readonly summary: ForecastRecordSummary }) {
  return (
    <dl className="figures">
      <Row label="Issued" value={formatCount(summary.issued)} />
      <Row label="Pending" value={formatCount(summary.pending)} />
      <Row label="Resolved" value={formatCount(summary.resolved)} />
      <Row label="Correct" value={formatCount(summary.correct)} />
      <Row label="Void" value={formatCount(summary.invalid)} />
      <Row label="Accuracy" value={formatRatio(summary.accuracy)} />
      <Row label="Cycle-balanced accuracy" value={formatRatio(summary.cycleBalancedAccuracy)} />
      <Row label="Brier score" value={formatNumber(summary.brierScore, 4)} />
      <Row label="Log loss" value={formatNumber(summary.logLoss, 4)} />
      <Row label="Current streak" value={formatCount(summary.currentStreak)} />
      <Row label="Current cycle streak" value={formatCount(summary.currentCycleStreak)} />
      <Row label="Resolved windows" value={formatCount(summary.resolvedWindows)} />
      <Row
        label="Windows required before evaluation is meaningful"
        value={formatCount(summary.evaluationMinimumWindows)}
      />
      <Row label="Evaluation meaningful" value={summary.evaluationMeaningful ? 'Yes' : 'Not yet'} />
      <Row label="Mean predicted edge" value={formatRatio(summary.meanPredictedEdge)} />
      <Row label="Mean realized return" value={formatNumber(summary.meanRealizedReturn, 4)} />
      <Row
        label="Calibration windows"
        value={`${formatCount(summary.calibrationWindows)} of ${formatCount(
          summary.calibrationMinimum,
        )} required`}
      />
      <Row label="Calibration readable" value={summary.calibrationReady ? 'Yes' : 'Not yet'} />
    </dl>
  );
}

export function PaperPerformanceView({ record }: { readonly record: PaperPerformance }) {
  const timeline = record.summary.timeline.slice(-TIMELINE_POINTS_SHOWN);

  return (
    <Panel heading="Full simulated record" headingId="record-heading">
      <SourceTime label="Computed by the simulation at" value={record.generatedAt} />
      <SourceTime label="Stored record last written at" value={record.sourceUpdatedAt} />
      <p className="panel__note">
        Each section below opens on demand. Everything is rendered by the server from one read of
        the record; nothing on this page polls or re-reads.
      </p>

      <RecordSummary summary={record.summary} />

      <Disclosure title="Accuracy by group">
        <SliceTable caption="By asset" slices={record.summary.byAsset} />
        <SliceTable caption="By direction" slices={record.summary.byDirection} />
        <SliceTable caption="By model version" slices={record.summary.byModelVersion} />
        <SliceTable caption="By confidence bucket" slices={record.summary.byConfidenceBucket} />
        <LeadTimeTable slices={record.summary.byLeadTime} />
      </Disclosure>

      <Disclosure title="Benchmarks and calibration">
        <BenchmarkTable benchmarks={record.summary.benchmarks} />
        <CalibrationTable bins={record.summary.calibrationBins} />
      </Disclosure>

      <Disclosure title="Edge and segments">
        <EdgeBucketTable buckets={record.summary.edgeBuckets} />
        <SegmentGroups groups={record.summary.segments} />
      </Disclosure>

      <Disclosure title="Forecast timeline">
        {timeline.length === 0 ? (
          <p className="panel__state">No timeline published.</p>
        ) : (
          <table className="record">
            <caption>
              The {formatCount(timeline.length)} most recent of{' '}
              {formatCount(record.summary.timeline.length)} published timeline points.
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Resolved</th>
                <th scope="col">Cumulative accuracy</th>
                <th scope="col">Rolling accuracy</th>
                <th scope="col">Cumulative Brier</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((point) => (
                <tr key={point.time}>
                  <th scope="row">
                    <time dateTime={point.time}>{point.time}</time>
                  </th>
                  <td>{formatCount(point.resolved)}</td>
                  <td>{formatRatio(point.cumulativeAccuracy)}</td>
                  <td>{formatRatio(point.rollingAccuracy)}</td>
                  <td>{formatNumber(point.cumulativeBrier, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Disclosure>

      <Disclosure title="Simulated trade record">
        <TrackRecord record={record.paperRecord} />
        <SegmentGroups groups={record.paperRecord.segments} />
        <CounterfactualArms arms={record.paperRecord.actionCounterfactuals} />
      </Disclosure>

      <Disclosure title="Per-venue records">
        <ProviderRecords records={record.paperProviderRecords} />
      </Disclosure>

      <Disclosure title="Bankroll fundings">
        <Epochs epochs={record.paperEpochs} />
      </Disclosure>

      <Disclosure title="Forecast history">
        <RecentForecasts forecasts={record.forecasts} limit={FORECASTS_SHOWN} />
      </Disclosure>

      {record.cyclePaths === undefined ? null : (
        <Disclosure title="Cycle path diagnostics">
          <CyclePaths report={record.cyclePaths} />
        </Disclosure>
      )}
    </Panel>
  );
}
