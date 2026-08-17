/**
 * How the span behind a track's P&L and equity is written, wherever those figures are shown.
 *
 * A budget figure means nothing without the moment it counts from: live's counter was rebased when the
 * control was reconfigured, and paper's is rebased by a bankroll reset. One formatter, so the automation
 * panel and the budget dialog can never date the same funding differently.
 *
 * The instants are the facts the records hold; the elapsed span beside them is derived for reading only,
 * which is why the clock is a parameter (§2) and why a label is never a key.
 */

export interface FundingScope {
  /** What the headline P&L covers. */
  pnlScope?: 'budget-epoch' | 'lifetime';
  /** When the funding opened. Written by a live reconfiguration or a paper bankroll reset. */
  epochStartedAt?: string;
  /** Earliest order the headline covers — the only anchor a funding that predates reset stamping has. */
  fundingFirstOrderAt?: string;
  /** How many times this bankroll has been reset. Absent means the counter has never moved. */
  bankrollResets?: number;
}

function stamp(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function elapsedLabel(ms: number): string | undefined {
  // A funding stamped ahead of the reader's clock says nothing rather than "-1d ago".
  if (ms < 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * `Funded Aug 15, 1:15 AM · 2d ago`, or `undefined` when the record carries no opening timestamp — as
 * paper's original bankroll does not. A funding date is never inferred, because a guessed one
 * misattributes every figure shown beside it.
 */
export function fundingOpenedLabel(startedAt: string | undefined, nowMs = Date.now()): string | undefined {
  const when = stamp(startedAt);
  if (!when) return undefined;
  const since = elapsedLabel(nowMs - Date.parse(startedAt as string));
  return since ? `Funded ${when} · ${since}` : `Funded ${when}`;
}

/**
 * The one line under a track's P&L and equity saying what span they cover.
 *
 * A funding that was opened deliberately is dated by the record that opened it. One that predates reset
 * stamping — paper's original bankroll, which has never been reset — has no such moment, so the line
 * falls back to the first trade it bought and says so in those words. First trade is not funding time;
 * conflating them would date the bankroll by when it happened to start working.
 */
export function fundingScopeLine(scope: FundingScope, nowMs = Date.now()): string {
  const resets = scope.bankrollResets ?? 0;
  const opened = fundingOpenedLabel(scope.epochStartedAt, nowMs);
  const parts = [
    opened ?? (scope.pnlScope === 'budget-epoch' ? 'Current budget only' : 'Whole bankroll life'),
  ];
  const firstTrade = stamp(scope.fundingFirstOrderAt);
  if (!opened && firstTrade) parts.push(`first trade ${firstTrade}`);
  // Silent for live, whose budget is re-funded through the control rather than reset, and which
  // therefore never carries this counter.
  if (scope.bankrollResets !== undefined) parts.push(resets ? `reset ${resets}×` : 'no reset recorded');
  return parts.join(' · ');
}

/** The unabbreviated instants, for a tooltip beside the short line. */
export function fundingScopeTitle(scope: FundingScope): string | undefined {
  const opened = scope.epochStartedAt && Number.isFinite(Date.parse(scope.epochStartedAt))
    ? `This funding opened ${new Date(scope.epochStartedAt).toLocaleString()} (${scope.epochStartedAt}). Every figure beside it counts from that moment.`
    : undefined;
  const first = scope.fundingFirstOrderAt && Number.isFinite(Date.parse(scope.fundingFirstOrderAt))
    ? `The record holds no funding timestamp for this bankroll, so it is anchored to its first trade, ${new Date(scope.fundingFirstOrderAt).toLocaleString()} (${scope.fundingFirstOrderAt}).`
    : undefined;
  return opened ?? first;
}
