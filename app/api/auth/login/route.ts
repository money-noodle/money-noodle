import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, createSessionToken, passwordMatches, sessionCookie } from '@/lib/auth';
import {
  clearLoginFailures, FAILURE_DELAY_MS, loginAttemptAllowed, loginClientKey, recordLoginFailure,
} from '@/lib/login-rate-limit';

export const runtime = 'nodejs';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: NextRequest) {
  const client = loginClientKey(request.headers);
  const gate = loginAttemptAllowed(client);
  if (!gate.allowed) {
    // Delayed even when already locked out, so probing lockout state costs the same as guessing.
    await delay(FAILURE_DELAY_MS);
    return NextResponse.json({ error: 'Too many failed sign-in attempts. Try again later.' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSeconds) } });
  }

  let password = '';
  try {
    const formData = await request.formData();
    password = String(formData.get('password') ?? '');
  } catch {
    // A body this route cannot parse is a malformed request, not a server fault. It is deliberately not
    // counted as a failed attempt: parsing never reached the password, so it proves nothing about it.
    return NextResponse.json({ error: 'Expected a form-encoded body with a password field.' }, { status: 400 });
  }

  if (!passwordMatches(password)) {
    recordLoginFailure(client);
    // The delay is the control that bounds guessing throughput regardless of instance count or source
    // address rotation, so it applies to every failure rather than only to locked-out ones.
    await delay(FAILURE_DELAY_MS);
    return NextResponse.redirect(new URL('/login?error=1', request.url), 303);
  }

  clearLoginFailures(client);
  const response = NextResponse.redirect(new URL('/', request.url), 303);
  response.cookies.set(AUTH_COOKIE, createSessionToken(), sessionCookie);
  return response;
}
