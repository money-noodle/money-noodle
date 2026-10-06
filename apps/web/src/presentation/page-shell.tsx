// The parts every view carries: the navigation, the research notice, and the two ways a
// read can come back with nothing.
//
// The research notice is on every view because every figure on this site is an
// observation of a simulation and of public market data, and nothing here is advice or a
// position. The notice says so where the numbers are, not on a page a reader has to go
// looking for.

import type { ReactNode } from 'react';

import { describeReadFailure, type ReadFailureKind } from './read-outcome';

const VIEWS = [
  { href: '/', label: 'Overview' },
  { href: '/market/hourly', label: 'Hourly thresholds' },
  { href: '/paper/budget', label: 'Simulated budget' },
  { href: '/paper/performance', label: 'Simulated record' },
  { href: '/control', label: 'Account controls' },
] as const;

export function SiteNavigation({ current }: { readonly current: string }) {
  return (
    <nav aria-label="Dashboard views" className="site-nav">
      <ul>
        {VIEWS.map((view) => (
          <li key={view.href}>
            {view.href === current ? (
              <span aria-current="page">{view.label}</span>
            ) : (
              <a href={view.href}>{view.label}</a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The standing notice.
 *
 * Simulation and public market data only: this platform has no real-money authority, and
 * the probabilities beside the contracts are arithmetic over public data rather than a
 * recommendation.
 */
export function ResearchNotice() {
  return (
    <p className="research-notice">
      <strong>Research and observation only.</strong> Every figure here is public market data or a
      simulated (&ldquo;paper&rdquo;) record read from the platform API. Nothing on this site is
      advice, an offer, or a real-money position, and no figure is estimated or filled in by this
      site.
    </p>
  );
}

export interface ReadFailureNoticeProps {
  readonly failure: ReadFailureKind;
  readonly heading: string;
  readonly headingId: string;
}

/** What a view shows instead of figures it could not read. */
export function ReadFailureNotice({ failure, heading, headingId }: ReadFailureNoticeProps) {
  const described = describeReadFailure(failure);
  return (
    <section aria-labelledby={headingId} className="panel panel--unavailable">
      <h2 id={headingId}>{heading}</h2>
      <p className="panel__state">{described.label}</p>
      <p>{described.explanation}</p>
    </section>
  );
}

export interface SourceTimeProps {
  readonly label: string;
  readonly value: string;
}

/**
 * A time the source recorded, shown prominently.
 *
 * The simulation's writer is stopped, so these records carry times from early September
 * 2026. Showing the source time beside every paper figure is what keeps an old record from
 * being read as a current one; this site never substitutes its own clock for it.
 */
export function SourceTime({ label, value }: SourceTimeProps) {
  return (
    <p className="source-time">
      <span className="source-time__label">{label}</span> <time dateTime={value}>{value}</time>
    </p>
  );
}

export function Panel({
  children,
  heading,
  headingId,
}: {
  readonly children: ReactNode;
  readonly heading: string;
  readonly headingId: string;
}) {
  return (
    <section aria-labelledby={headingId} className="panel">
      <h2 id={headingId}>{heading}</h2>
      {children}
    </section>
  );
}
