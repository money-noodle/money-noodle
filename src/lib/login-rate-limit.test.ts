import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  clearLoginFailures, LOCKOUT_MS, loginAttemptAllowed, loginClientKey, MAX_FAILURES,
  MAX_TRACKED_CLIENTS, recordLoginFailure, resetLoginRateLimit, WINDOW_MS,
} from './login-rate-limit';

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

describe('login throttling', () => {
  beforeEach(() => resetLoginRateLimit());

  it('allows an untouched client the full budget', () => {
    expect(loginAttemptAllowed('1.2.3.4')).toEqual({ allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILURES });
  });

  it('locks out after the burst limit and reports when to retry', () => {
    const now = 1_000_000;
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect(recordLoginFailure('ip', now).allowed).toBe(true);
    }
    const final = recordLoginFailure('ip', now);
    expect(final.allowed).toBe(false);
    expect(final.remainingAttempts).toBe(0);
    const gate = loginAttemptAllowed('ip', now + 1_000);
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterSeconds).toBeGreaterThan(0);
    expect(gate.retryAfterSeconds).toBeLessThanOrEqual(LOCKOUT_MS / 1000);
  });

  it('releases the lockout once it expires rather than banning permanently', () => {
    const now = 2_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) recordLoginFailure('ip', now);
    expect(loginAttemptAllowed('ip', now + LOCKOUT_MS - 1).allowed).toBe(false);
    expect(loginAttemptAllowed('ip', now + LOCKOUT_MS + 1).allowed).toBe(true);
  });

  it('forgives failures spread beyond the window, so slow typos never accumulate into a lockout', () => {
    let now = 3_000_000;
    for (let i = 0; i < MAX_FAILURES * 3; i++) {
      expect(recordLoginFailure('ip', now).allowed).toBe(true);
      now += WINDOW_MS + 1;
    }
  });

  it('clears state on success so an operator is not throttled by earlier typos', () => {
    const now = 4_000_000;
    for (let i = 0; i < MAX_FAILURES - 1; i++) recordLoginFailure('ip', now);
    clearLoginFailures('ip');
    expect(loginAttemptAllowed('ip', now).remainingAttempts).toBe(MAX_FAILURES);
  });

  it('keeps clients independent, so one attacker cannot lock the operator out', () => {
    const now = 5_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) recordLoginFailure('attacker', now);
    expect(loginAttemptAllowed('attacker', now).allowed).toBe(false);
    expect(loginAttemptAllowed('operator', now).allowed).toBe(true);
  });

  it('bounds memory under source-address rotation instead of growing without limit', () => {
    const now = 6_000_000;
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 500; i++) recordLoginFailure(`ip-${i}`, now);
    // Still throttling the most recent attacker despite eviction pressure.
    expect(loginAttemptAllowed(`ip-${MAX_TRACKED_CLIENTS + 499}`, now).remainingAttempts).toBeLessThan(MAX_FAILURES);
  });
});

describe('client identity', () => {
  it('takes the left-most forwarded address, which is the original client', () => {
    expect(loginClientKey(headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' }))).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to a shared bucket rather than treating everyone as distinct', () => {
    expect(loginClientKey(headers({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
    expect(loginClientKey(headers({}))).toBe('unknown');
    // An empty header must not read as a unique client, which would hand out a fresh budget each time.
    expect(loginClientKey(headers({ 'x-forwarded-for': '   ' }))).toBe('unknown');
  });
});
