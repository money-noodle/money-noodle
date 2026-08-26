import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, sessionCookie } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/', request.url), 303);
  response.cookies.set(AUTH_COOKIE, '', { ...sessionCookie, maxAge: 0 });
  return response;
}