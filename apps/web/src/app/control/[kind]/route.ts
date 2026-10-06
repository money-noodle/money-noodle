// Recording a control, from a plain form post.
//
// A route handler rather than a Server Action, for the same reason the sign-in
// form is a `<form>`: the page works without JavaScript, which keeps the control
// surface usable with a keyboard and a screen reader and keeps this site free of
// client components.
//
// It decides nothing. The API verifies the session, validates the action and
// appends the row; this handler forwards the session, forwards the action, and
// redirects back with a result the page can state. It performs no effect for the
// same reason the API does not: there is nothing here to perform (ADR-0013 §3).

import { submitControl } from '../../../adapters/platform-api/load-control-reads';
import { readSessionId } from '../../../adapters/platform-api/session';

const ACTIONS = ['configure', 'pause', 'resume', 'reset', 'provider-enable'] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isKind(value: unknown): value is 'paper' | 'live' {
  return value === 'paper' || value === 'live';
}

function back(kind: string, result: string): Response {
  // Both values are encoded. The identifier half of `result` is the API's own
  // opaque value, and a redirect target is the wrong place to assume anything
  // about a string that arrived over the wire.
  return new Response(null, {
    headers: {
      location: `/control?budget=${encodeURIComponent(kind)}&recorded=${encodeURIComponent(result)}`,
    },
    status: 303,
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await context.params;
  if (!isKind(kind)) return back('paper', 'failed');

  let action: unknown;
  try {
    action = (await request.formData()).get('action');
  } catch {
    return back(kind, 'failed');
  }
  if (!isAction(action)) return back(kind, 'failed');

  const outcome = await submitControl(kind, action, { sessionId: await readSessionId() });
  // The intent identifier travels in the redirect so the page can name the row it
  // recorded. It is the API's own opaque identifier and carries nothing else.
  return back(kind, outcome.ok ? `${action}:${outcome.value.intentId}` : 'failed');
}
