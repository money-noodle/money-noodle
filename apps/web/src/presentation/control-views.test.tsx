import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BudgetDetailView,
  ControlFormView,
  ControlNotice,
  IntentHistoryView,
  JobHealthView,
  LiveBudgetNotice,
  SignInView,
  type BudgetView,
} from './control-views';

const view = (overrides: Partial<BudgetView> = {}): BudgetView => ({
  appliedState: null,
  budget: {
    createdAt: '2026-10-06T12:00:00.000Z',
    hasExecutionAuthority: true,
    id: 'account:paper',
    kind: 'paper',
  },
  capability: 'budget:paper',
  desiredState: 'unset',
  epoch: 0,
  latestIntentAt: null,
  ...overrides,
});

describe('the live budget notice', () => {
  it('states plainly that there is no execution authority', () => {
    const markup = renderToStaticMarkup(<LiveBudgetNotice hasExecutionAuthority={false} />);

    expect(markup).toContain('no execution authority');
    expect(markup).toContain('no venue credential');
    expect(markup).toContain('no way to arm it');
    // A standing notice, not a tooltip and not colour-only.
    expect(markup).toContain('role="note"');
  });

  it('says nothing about a budget that does have authority', () => {
    expect(renderToStaticMarkup(<LiveBudgetNotice hasExecutionAuthority />)).toBe('');
  });

  it('is shown on the live budget’s own detail view', () => {
    const markup = renderToStaticMarkup(
      <BudgetDetailView
        view={view({
          budget: {
            createdAt: '2026-10-06T12:00:00.000Z',
            hasExecutionAuthority: false,
            id: 'account:live',
            kind: 'live',
          },
          capability: 'budget:live',
        })}
      />,
    );

    expect(markup).toContain('no execution authority');
    expect(markup).toContain('Live budget');
  });
});

describe('the control notice', () => {
  it('says a control records intent and performs nothing', () => {
    const markup = renderToStaticMarkup(<ControlNotice />);

    expect(markup).toContain('record intent');
    expect(markup).toContain('do not act');
    expect(markup).toContain('no engine job exists yet');
  });
});

describe('budget detail', () => {
  it('distinguishes what was asked from what a job said', () => {
    const markup = renderToStaticMarkup(<BudgetDetailView view={view()} />);

    expect(markup).toContain('No control has ever been recorded');
    // The absence of a job's answer is stated, not rendered as a zero or a dash.
    expect(markup).toContain('no job has read this intent');
    expect(markup).toContain('None recorded');
  });

  it('renders a recorded request and the outcome a job appended', () => {
    const markup = renderToStaticMarkup(
      <BudgetDetailView
        view={view({
          appliedState: 'refused',
          desiredState: 'paused',
          epoch: 3,
          latestIntentAt: '2026-10-06T13:00:00.000Z',
        })}
      />,
    );

    expect(markup).toContain('Paused was the last request');
    expect(markup).toContain('refused');
    expect(markup).toContain('dateTime="2026-10-06T13:00:00.000Z"');
  });

  it('uses a semantic table with row headers', () => {
    const markup = renderToStaticMarkup(<BudgetDetailView view={view()} />);
    expect(markup).toContain('<caption>');
    expect(markup).toContain('scope="row"');
  });
});

describe('the control form', () => {
  it('offers every published control and says what recording one means', () => {
    const markup = renderToStaticMarkup(<ControlFormView kind="paper" recorded={undefined} />);

    for (const action of ['pause', 'resume', 'reset', 'configure', 'provider-enable']) {
      expect(markup).toContain(`value="${action}"`);
      expect(markup).toContain(`Record ${action}`);
    }
    expect(markup).toContain('<fieldset>');
    expect(markup).toContain('<legend>');
  });

  it('reports a recorded row without claiming anything happened', () => {
    const markup = renderToStaticMarkup(
      <ControlFormView kind="paper" recorded={{ action: 'pause', intentId: 'intent-1' }} />,
    );

    expect(markup).toContain('Recorded');
    expect(markup).toContain('intent-1');
    expect(markup).toContain('Nothing has been performed');
    expect(markup).toContain('role="status"');
  });

  it('reports a failure as nothing recorded', () => {
    const markup = renderToStaticMarkup(<ControlFormView kind="live" recorded="failed" />);

    expect(markup).toContain('Nothing was recorded');
    expect(markup).toContain('role="alert"');
  });
});

describe('intent history', () => {
  it('says plainly when nothing has ever been recorded', () => {
    const markup = renderToStaticMarkup(
      <IntentHistoryView capability="budget:paper" entries={[]} />,
    );
    expect(markup).toContain('No control has ever been recorded');
  });

  it('renders each row and marks the ones no job has read', () => {
    const markup = renderToStaticMarkup(
      <IntentHistoryView
        capability="budget:paper"
        entries={[
          {
            intent: {
              action: 'pause',
              actor: 'account',
              epoch: 2,
              id: 'intent-1',
              recordedAt: '2026-10-06T12:00:00.000Z',
            },
            outcomes: [],
          },
          {
            intent: {
              action: 'resume',
              actor: 'account',
              epoch: 1,
              id: 'intent-2',
              recordedAt: '2026-10-05T12:00:00.000Z',
            },
            outcomes: [{ outcome: 'applied', reason: 'ok' }],
          },
        ]}
      />,
    );

    expect(markup).toContain('Not yet read by any job');
    expect(markup).toContain('applied (ok)');
    expect(markup).toContain('scope="col"');
  });
});

describe('job health', () => {
  it('reports a job that has never run as exactly that', () => {
    const markup = renderToStaticMarkup(
      <JobHealthView jobs={[{ capability: 'budget:paper', lastOutcome: null, lastRunAt: null }]} />,
    );

    expect(markup).toContain('Never run');
    expect(markup).toContain('None');
  });

  it('renders a run that happened', () => {
    const markup = renderToStaticMarkup(
      <JobHealthView
        jobs={[
          {
            capability: 'budget:paper',
            lastOutcome: 'applied',
            lastRunAt: '2026-10-06T12:00:00.000Z',
          },
        ]}
      />,
    );

    expect(markup).toContain('dateTime="2026-10-06T12:00:00.000Z"');
    expect(markup).toContain('applied');
  });
});

describe('the sign-in view', () => {
  it('is a plain labelled form that works without JavaScript', () => {
    const markup = renderToStaticMarkup(<SignInView />);

    expect(markup).toContain('action="/session"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain('for="idToken"');
    expect(markup).toContain('id="idToken"');
  });

  it('says a sign-in was refused without publishing why', () => {
    const markup = renderToStaticMarkup(<SignInView failed />);

    expect(markup).toContain('was not accepted');
    expect(markup).toContain('No reason is published here');
    expect(markup).toContain('role="alert"');
  });
});
