// The signed-in views: sign in, the two budgets, and the control record.
//
// Presentation only, in the same sense as every other view on this site. Nothing
// here computes a figure, decides an authority, or interprets a state the API did
// not publish — `hasExecutionAuthority` arrives as a boolean and is rendered as a
// sentence, it is not inferred from the budget's name.
//
// Two rules the markup has to carry rather than imply:
//
//   * A control records intent. The buttons say "Record", the heading says what
//     that means, and the result message says a row exists. None of them says
//     anything happened, because nothing did.
//   * The live budget has no execution authority. That is a standing notice on
//     the page, not a tooltip, and it comes from the API's own field.
//
// Accessible for the same reasons the public views are: semantic tables, text
// alternatives, no colour-only status, and every control inside a labelled form.

import type { ReactNode } from 'react';

export interface BudgetView {
  readonly appliedState: string | null;
  readonly budget: {
    readonly createdAt: string;
    readonly hasExecutionAuthority: boolean;
    readonly id: string;
    readonly kind: string;
  };
  readonly capability: string;
  readonly desiredState: string;
  readonly epoch: number;
  readonly latestIntentAt: string | null;
}

export interface IntentEntryView {
  readonly intent: {
    readonly action: string;
    readonly actor: string;
    readonly epoch: number;
    readonly id: string;
    readonly recordedAt: string;
  };
  readonly outcomes: readonly { readonly outcome: string; readonly reason: string }[];
}

const CONTROLS = ['pause', 'resume', 'reset', 'configure', 'provider-enable'] as const;

/** The standing statement about what a control on this site can and cannot do. */
export function ControlNotice() {
  return (
    <p className="research-notice">
      <strong>Controls record intent; they do not act.</strong> Every control here appends a durable
      request that the job owning that capability reads at the start of its next run. Nothing on
      this page performs an effect, and no engine job exists yet, so no request recorded here has
      been acted on.
    </p>
  );
}

/** The live budget's standing notice. Not a tooltip, and not conditional on hover. */
export function LiveBudgetNotice({
  hasExecutionAuthority,
}: {
  readonly hasExecutionAuthority: boolean;
}) {
  if (hasExecutionAuthority) return null;
  return (
    <p className="research-notice" role="note">
      <strong>The live budget has no execution authority.</strong> It exists as a record with the
      same schema and the same controls as the simulated budget. There is no venue credential, no
      execution path, no reconciliation and no way to arm it from this site. Controls recorded
      against it are audited and acted on by nothing.
    </p>
  );
}

export function SignInView({ failed }: { readonly failed?: boolean | undefined }) {
  return (
    <section aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading">Sign in</h1>
      <p>
        The signed-in area shows the account&rsquo;s two budget records, their recorded control
        intent, and the health of the engine jobs. Sign-in requires an identity token from the
        configured identity provider, issued through a sign-in that used a second factor.
      </p>
      {failed === true ? (
        <p role="alert">
          <strong>That sign-in was not accepted.</strong> No reason is published here. Check that
          the token is current and that the sign-in used a second factor.
        </p>
      ) : null}
      <form action="/session" method="post">
        <p>
          <label htmlFor="idToken">Identity token</label>
          <br />
          <textarea
            autoComplete="off"
            id="idToken"
            name="idToken"
            required
            rows={4}
            spellCheck={false}
          />
        </p>
        <p>
          <button type="submit">Sign in</button>
        </p>
      </form>
      <p>
        <small>
          The token is sent to this server, forwarded to the platform API for verification, and
          never stored by this site. The session this site keeps is an opaque identifier in a cookie
          that no script can read.
        </small>
      </p>
    </section>
  );
}

export function UnauthenticatedNotice({ heading }: { readonly heading: string }) {
  return (
    <section aria-labelledby="unauthenticated-heading">
      <h2 id="unauthenticated-heading">{heading}</h2>
      <p>
        This view needs a signed-in session. <a href="/control">Sign in</a> to see it.
      </p>
    </section>
  );
}

export function UnavailableNotice({ heading }: { readonly heading: string }) {
  return (
    <section aria-labelledby="unavailable-heading">
      <h2 id="unavailable-heading">{heading}</h2>
      <p>
        This view is not available right now. Nothing is shown rather than a figure this site made
        up.
      </p>
    </section>
  );
}

function describeState(value: string): string {
  if (value === 'unset') return 'No control has ever been recorded';
  if (value === 'paused') return 'Paused was the last request';
  if (value === 'running') return 'Running was the last request';
  return value;
}

export function BudgetDetailView({ view }: { readonly view: BudgetView }) {
  const heading = `${view.budget.kind === 'paper' ? 'Simulated' : 'Live'} budget`;
  return (
    <section aria-labelledby={`budget-${view.budget.kind}`}>
      <h2 id={`budget-${view.budget.kind}`}>{heading}</h2>
      <LiveBudgetNotice hasExecutionAuthority={view.budget.hasExecutionAuthority} />
      <table>
        <caption>Recorded state of the {view.budget.kind} budget</caption>
        <tbody>
          <tr>
            <th scope="row">Capability</th>
            <td>{view.capability}</td>
          </tr>
          <tr>
            <th scope="row">Last requested</th>
            <td>{describeState(view.desiredState)}</td>
          </tr>
          <tr>
            <th scope="row">Reported by a job</th>
            <td>{view.appliedState ?? 'Nothing — no job has read this intent'}</td>
          </tr>
          <tr>
            <th scope="row">Control epoch</th>
            <td>{view.epoch === 0 ? 'None recorded' : view.epoch}</td>
          </tr>
          <tr>
            <th scope="row">Latest intent recorded</th>
            <td>
              {view.latestIntentAt === null ? (
                'Never'
              ) : (
                <time dateTime={view.latestIntentAt}>{view.latestIntentAt}</time>
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">Execution authority</th>
            <td>{view.budget.hasExecutionAuthority ? 'Simulation only' : 'None'}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function ControlFormView({
  kind,
  recorded,
}: {
  readonly kind: string;
  readonly recorded: { readonly action: string; readonly intentId: string } | 'failed' | undefined;
}) {
  return (
    <section aria-labelledby={`controls-${kind}`}>
      <h2 id={`controls-${kind}`}>Record a control against the {kind} budget</h2>
      <ControlNotice />
      {recorded === 'failed' ? (
        <p role="alert">
          <strong>Nothing was recorded.</strong> The control was not appended, so no job will see
          it.
        </p>
      ) : recorded === undefined ? null : (
        <p role="status">
          <strong>Recorded.</strong> A <code>{recorded.action}</code> request is now durable as{' '}
          <code>{recorded.intentId}</code>. Nothing has been performed.
        </p>
      )}
      <form action={`/control/${kind}`} method="post">
        <fieldset>
          <legend>Control to record</legend>
          {CONTROLS.map((action) => (
            <p key={action}>
              <button name="action" type="submit" value={action}>
                Record {action}
              </button>
            </p>
          ))}
        </fieldset>
      </form>
    </section>
  );
}

export function IntentHistoryView({
  entries,
  capability,
}: {
  readonly capability: string;
  readonly entries: readonly IntentEntryView[];
}): ReactNode {
  return (
    <section aria-labelledby="intent-history">
      <h2 id="intent-history">Recorded control intent</h2>
      <p>
        Newest first, for <code>{capability}</code>. Each row is a durable request; the outcome
        column is what a job said it did with it.
      </p>
      {entries.length === 0 ? (
        <p>No control has ever been recorded for this capability.</p>
      ) : (
        <table>
          <caption>Control intent and the outcomes jobs appended against it</caption>
          <thead>
            <tr>
              <th scope="col">Recorded</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Epoch</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.intent.id}>
                <td>
                  <time dateTime={entry.intent.recordedAt}>{entry.intent.recordedAt}</time>
                </td>
                <td>{entry.intent.action}</td>
                <td>{entry.intent.actor}</td>
                <td>{entry.intent.epoch}</td>
                <td>
                  {entry.outcomes.length === 0
                    ? 'Not yet read by any job'
                    : `${entry.outcomes[0]?.outcome} (${entry.outcomes[0]?.reason})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function JobHealthView({
  jobs,
}: {
  readonly jobs: readonly {
    readonly capability: string;
    readonly lastOutcome: string | null;
    readonly lastRunAt: string | null;
  }[];
}) {
  return (
    <section aria-labelledby="job-health">
      <h2 id="job-health">Engine jobs</h2>
      <table>
        <caption>Last recorded run of each engine job</caption>
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col">Last run</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.capability}>
              <td>{job.capability}</td>
              <td>
                {job.lastRunAt === null ? (
                  'Never run'
                ) : (
                  <time dateTime={job.lastRunAt}>{job.lastRunAt}</time>
                )}
              </td>
              <td>{job.lastOutcome ?? 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
