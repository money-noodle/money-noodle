// The signed-in page: the two budget records, their controls, the recorded
// intent, and the health of the engine jobs.
//
// One page rather than four, because in this milestone there is very little to
// show and splitting it would make a reader navigate between facts that only mean
// something together: what was requested, what a job said about it, and whether a
// job exists at all.
//
// Everything on it comes from the API. The page reads the session cookie, hands
// the opaque identifier to the adapter, and renders what comes back. It computes
// nothing, and an unauthenticated reader sees the sign-in form rather than an
// error.

import {
  loadBudgetDetail,
  loadIntentHistory,
  loadJobHealth,
} from '../../adapters/platform-api/load-control-reads';
import { readSessionId } from '../../adapters/platform-api/session';
import {
  BudgetDetailView,
  ControlFormView,
  IntentHistoryView,
  JobHealthView,
  SignInView,
  UnavailableNotice,
  type BudgetView,
  type IntentEntryView,
} from '../../presentation/control-views';
import { ResearchNotice, SiteNavigation } from '../../presentation/page-shell';

export const dynamic = 'force-dynamic';

function budgetKind(value: string | string[] | undefined): 'paper' | 'live' {
  return value === 'live' ? 'live' : 'paper';
}

/** What the redirect from a control post said, reduced to what the view takes. */
function recorded(
  value: string | string[] | undefined,
): { action: string; intentId: string } | 'failed' | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value === 'failed') return 'failed';
  const separator = value.indexOf(':');
  if (separator < 1) return undefined;
  return { action: value.slice(0, separator), intentId: value.slice(separator + 1) };
}

export default async function ControlPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const sessionId = await readSessionId();

  if (sessionId === undefined) {
    return (
      <>
        <SiteNavigation current="/control" />
        <ResearchNotice />
        <SignInView failed={parameters['signIn'] === 'refused'} />
      </>
    );
  }

  const kind = budgetKind(parameters['budget']);
  const options = { sessionId };
  const [detail, history, jobs] = await Promise.all([
    loadBudgetDetail(kind, options),
    loadIntentHistory(kind, options),
    loadJobHealth(options),
  ]);

  // A session the API no longer accepts is a sign-in prompt, not an error: the
  // cookie this site holds outlived the row the API owns, which is exactly what
  // revocation looks like from here.
  if (detail.ok === false && detail.failure === 'unauthenticated') {
    return (
      <>
        <SiteNavigation current="/control" />
        <ResearchNotice />
        <SignInView />
      </>
    );
  }

  return (
    <>
      <SiteNavigation current="/control" />
      <ResearchNotice />
      <h1>Account controls</h1>
      <p>
        One account, two budget records with the same schema and the same controls.{' '}
        <a href={`/control?budget=${kind === 'paper' ? 'live' : 'paper'}`}>
          Show the {kind === 'paper' ? 'live' : 'simulated'} budget
        </a>
        .
      </p>

      {detail.ok ? (
        <BudgetDetailView view={detail.value as unknown as BudgetView} />
      ) : (
        <UnavailableNotice heading={`${kind} budget`} />
      )}

      <ControlFormView kind={kind} recorded={recorded(parameters['recorded'])} />

      {history.ok ? (
        <IntentHistoryView
          capability={history.value.capability}
          entries={history.value.entries as unknown as readonly IntentEntryView[]}
        />
      ) : (
        <UnavailableNotice heading="Recorded control intent" />
      )}

      {jobs.ok ? (
        <JobHealthView jobs={jobs.value.jobs} />
      ) : (
        <UnavailableNotice heading="Engine jobs" />
      )}

      <form action="/session/end" method="post">
        <p>
          <button type="submit">Sign out</button>
        </p>
        {parameters['signOut'] === 'unconfirmed' ? (
          <p role="alert">
            This browser no longer holds the session, but the platform could not confirm that it was
            revoked. It will stop being accepted when it expires.
          </p>
        ) : null}
      </form>
    </>
  );
}
