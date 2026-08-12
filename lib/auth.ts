import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

export const AUTH_COOKIE = 'money_noodle_session';
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 14;

function sessionSecret() {
  return process.env.AUTH_SECRET;
}

function sign(value: string) {
  const secret = sessionSecret();
  return secret ? createHmac('sha256', secret).update(value).digest('base64url') : '';
}

export function createSessionToken() {
  const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_DURATION_SECONDS;
  return `${expiresAt}.${sign(String(expiresAt))}`;
}

export function isValidSession(token: string | undefined) {
  const [expiresAt, signature, ...extra] = token?.split('.') ?? [];
  if (!expiresAt || !signature || extra.length || !sessionSecret() || Number(expiresAt) < Date.now() / 1_000) return false;
  const expected = sign(expiresAt);
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export async function isAuthenticated() {
  return isValidSession((await cookies()).get(AUTH_COOKIE)?.value);
}

export function isAuthenticatedRequest(request: NextRequest) {
  return isValidSession(request.cookies.get(AUTH_COOKIE)?.value);
}

export function passwordMatches(password: string) {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected || !sessionSecret()) return false;
  return password.length === expected.length && timingSafeEqual(Buffer.from(password), Buffer.from(expected));
}

export const sessionCookie = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_DURATION_SECONDS,
};