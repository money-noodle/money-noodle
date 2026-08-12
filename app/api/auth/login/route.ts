import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, createSessionToken, passwordMatches, sessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const password = String(formData.get('password') ?? '');
  if (!passwordMatches(password)) return NextResponse.redirect(new URL('/login?error=1', request.url), 303);

  const response = NextResponse.redirect(new URL('/', request.url), 303);
  response.cookies.set(AUTH_COOKIE, createSessionToken(), sessionCookie);
  return response;
}