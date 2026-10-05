// The four views, composed.
//
// Each takes outcomes rather than loaders, so every state a reader can land on — a
// populated record, a stale feed, a refused read, an unreachable API — is a value a test
// can pass in. The route modules do the reading; nothing here touches the network, a
// clock, or the environment.
//
// Every view carries the navigation and the research notice, and every view that shows a
// simulated figure shows the time the simulation recorded it.

import type {
  HourlyThresholdMarkets,
  MarketOverview,
  PaperBudget,
  PaperPerformance,
  PaperPerformanceSummary,
} from '@money-noodle/platform-api-client';
import type { ReactNode } from 'react';

import { HourlyThresholdsView } from './hourly-thresholds-view';
import { MarketOverviewView } from './market-overview-view';
import { ReadFailureNotice, ResearchNotice, SiteNavigation } from './page-shell';
import { PaperBudgetHeadline, PaperBudgetView } from './paper-budget-view';
import { PaperPerformanceView } from './paper-performance-view';
import { PaperSummaryView } from './paper-summary-view';
import { PlatformStatusCard } from './platform-status-card';
import {
  presentPlatformStatus,
  type PlatformStatusObservation,
} from './platform-status-view-model';
import type { ReadOutcome } from './read-outcome';

function Shell({
  children,
  current,
  lede,
  title,
}: {
  readonly children: ReactNode;
  readonly current: string;
  readonly lede: string;
  readonly title: string;
}) {
  return (
    <main>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
      <SiteNavigation current={current} />
      <ResearchNotice />
      {children}
    </main>
  );
}

/** A read's value, or the notice that says why there is none. */
function Resolved<T>({
  heading,
  headingId,
  outcome,
  render,
}: {
  readonly heading: string;
  readonly headingId: string;
  readonly outcome: ReadOutcome<T>;
  readonly render: (value: T) => ReactNode;
}) {
  return outcome.ok ? (
    <>{render(outcome.value)}</>
  ) : (
    <ReadFailureNotice failure={outcome.failure} heading={heading} headingId={headingId} />
  );
}

export interface HomeViewProps {
  readonly budget: ReadOutcome<PaperBudget>;
  readonly market: ReadOutcome<MarketOverview>;
  readonly status: PlatformStatusObservation | undefined;
  readonly summary: ReadOutcome<PaperPerformanceSummary>;
}

export function HomeView({ budget, market, status, summary }: HomeViewProps) {
  return (
    <Shell
      current="/"
      lede="A clear view of the platform, one trustworthy noodle at a time."
      title="Money Noodle"
    >
      <PlatformStatusCard status={presentPlatformStatus(status)} />
      <Resolved
        heading="Market data"
        headingId="market-heading"
        outcome={market}
        render={(overview) => <MarketOverviewView overview={overview} />}
      />
      <Resolved
        heading="Simulated bankroll"
        headingId="budget-headline-heading"
        outcome={budget}
        render={(record) => <PaperBudgetHeadline budget={record} />}
      />
      <Resolved
        heading="Simulated record"
        headingId="paper-summary-heading"
        outcome={summary}
        render={(record) => <PaperSummaryView compact summary={record} />}
      />
      <p className="footnote">
        Every release here ships from a reviewed merge to main, with no second approval.
      </p>
    </Shell>
  );
}

export function PaperBudgetPageView({ budget }: { readonly budget: ReadOutcome<PaperBudget> }) {
  return (
    <Shell
      current="/paper/budget"
      lede="The simulated bankroll, as the simulation last recorded it."
      title="Simulated budget"
    >
      <Resolved
        heading="Simulated bankroll"
        headingId="budget-heading"
        outcome={budget}
        render={(record) => <PaperBudgetView budget={record} />}
      />
    </Shell>
  );
}

export interface PaperPerformancePageViewProps {
  readonly record: ReadOutcome<PaperPerformance>;
  readonly summary: ReadOutcome<PaperPerformanceSummary>;
}

export function PaperPerformancePageView({ record, summary }: PaperPerformancePageViewProps) {
  return (
    <Shell
      current="/paper/performance"
      lede="The forecast and simulated-trade record, as the simulation last computed it."
      title="Simulated record"
    >
      <Resolved
        heading="Simulated record"
        headingId="paper-summary-heading"
        outcome={summary}
        render={(value) => <PaperSummaryView summary={value} />}
      />
      <Resolved
        heading="Full simulated record"
        headingId="record-heading"
        outcome={record}
        render={(value) => <PaperPerformanceView record={value} />}
      />
    </Shell>
  );
}

export function HourlyThresholdsPageView({
  markets,
}: {
  readonly markets: ReadOutcome<HourlyThresholdMarkets>;
}) {
  return (
    <Shell
      current="/market/hourly"
      lede="Hourly above-and-below contracts, with the model beside each asking price."
      title="Hourly thresholds"
    >
      <Resolved
        heading="Hourly threshold contracts"
        headingId="hourly-heading"
        outcome={markets}
        render={(value) => <HourlyThresholdsView markets={value} />}
      />
    </Shell>
  );
}
