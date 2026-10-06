// Verifier tests against a key this test generates, and a `fetch` it supplies.
//
// No network: the certificate set is served by a function, and the signing key
// exists only for the duration of the run. That is what lets these assertions run
// in CI, and it is also the only honest way to test a verifier — a test that
// reached the real provider would prove that the provider was up.

import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createGoogleIdentityPlatformVerifier } from './google-identity-platform-verifier.js';

const ISSUER = 'https://issuer.test/project-under-test';
const AUDIENCE = 'project-under-test';
const KID = 'test-key';
const NOW = new Date('2026-10-06T12:00:00.000Z');

/**
 * A key pair generated for this run, served where the provider would serve a
 * certificate. `createPublicKey` accepts either form, and no private key is
 * committed to this repository — which is the reason a fixture certificate was
 * not used instead (SECURITY.md).
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const PRIVATE_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

function sign(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID },
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(PRIVATE_PEM);
  return `${signingInput}.${signature.toString('base64url')}`;
}

const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: AUDIENCE,
  auth_time: Math.floor(NOW.getTime() / 1000) - 10,
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
  firebase: { sign_in_second_factor: 'phone' },
  iat: Math.floor(NOW.getTime() / 1000) - 10,
  iss: ISSUER,
  sub: 'provider-subject',
  ...overrides,
});

function keyServer(
  body: unknown = { [KID]: PUBLIC_PEM },
  init: { status?: number; cacheControl?: string } = {},
): { fetchImplementation: typeof fetch; calls: number } {
  const state = {
    calls: 0,
    fetchImplementation: (async () => {
      state.calls += 1;
      return new Response(JSON.stringify(body), {
        headers: {
          'cache-control': init.cacheControl ?? 'public, max-age=3600',
          'content-type': 'application/json',
        },
        status: init.status ?? 200,
      });
    }) as unknown as typeof fetch,
  };
  return state;
}

function verifier(server = keyServer()): ReturnType<typeof createGoogleIdentityPlatformVerifier> {
  return createGoogleIdentityPlatformVerifier({
    audience: AUDIENCE,
    clock: { now: () => NOW },
    fetchImplementation: server.fetchImplementation,
    issuer: ISSUER,
    keysUrl: 'https://keys.test/certs',
  });
}

describe('verifying an identity token', () => {
  it('accepts a correctly signed token and reports the second factor', async () => {
    const identity = await verifier().verify(sign(claims()));

    expect(identity).not.toBeNull();
    expect(identity?.subject).toBe('provider-subject');
    expect(identity?.secondFactorUsed).toBe(true);
    expect(identity?.expiresAt).toEqual(new Date((claims()['exp'] as number) * 1000));
  });

  it('reports no second factor when the provider did not say one was used', async () => {
    // Enrolment is not the question. A token from an account that *has* a factor
    // but did not use it carries no `sign_in_second_factor`, and that is refused
    // one layer up rather than being treated as MFA.
    for (const firebase of [undefined, {}, { sign_in_second_factor: '' }, { identities: {} }]) {
      const identity = await verifier().verify(sign(claims({ firebase })));
      expect(identity?.secondFactorUsed).toBe(false);
    }
  });

  it('refuses a token signed by a key it did not fetch', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signingInput = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID })).toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}`;
    const forged = `${signingInput}.${createSign('RSA-SHA256')
      .update(signingInput)
      .sign(other.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
      .toString('base64url')}`;

    expect(await verifier().verify(forged)).toBeNull();
  });

  it('refuses a wrong issuer, a wrong audience, and a token that is not yet or no longer valid', async () => {
    const subject = verifier();
    expect(await subject.verify(sign(claims({ iss: 'https://issuer.test/other' })))).toBeNull();
    expect(await subject.verify(sign(claims({ aud: 'other-project' })))).toBeNull();
    expect(
      await subject.verify(sign(claims({ exp: Math.floor(NOW.getTime() / 1000) - 3600 }))),
    ).toBeNull();
    expect(
      await subject.verify(sign(claims({ iat: Math.floor(NOW.getTime() / 1000) + 3600 }))),
    ).toBeNull();
    expect(
      await subject.verify(sign(claims({ auth_time: Math.floor(NOW.getTime() / 1000) + 3600 }))),
    ).toBeNull();
    expect(await subject.verify(sign(claims({ exp: 'soon' })))).toBeNull();
    expect(await subject.verify(sign(claims({ iat: undefined })))).toBeNull();
    expect(await subject.verify(sign(claims({ sub: '' })))).toBeNull();
    expect(await subject.verify(sign(claims({ sub: 'x'.repeat(129) })))).toBeNull();
  });

  it('refuses anything that is not a three-segment RS256 token naming a key', async () => {
    const subject = verifier();
    for (const bad of [
      '',
      'x'.repeat(8193),
      'one.two',
      'one.two.three.four',
      sign(claims(), { alg: 'none', kid: KID }),
      sign(claims(), { alg: 'HS256', kid: KID }),
      sign(claims(), { alg: 'RS256' }),
      sign(claims(), { alg: 'RS256', kid: '' }),
      'not base64!.also not!.nope!',
    ]) {
      expect(await subject.verify(bad)).toBeNull();
    }
    // A payload that is not a JSON object, under a real signature.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID })).toString('base64url');
    const payload = Buffer.from('[]').toString('base64url');
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(PRIVATE_PEM)
      .toString('base64url');
    expect(await subject.verify(`${header}.${payload}.${signature}`)).toBeNull();
  });

  it('refuses when the key set cannot be fetched, is empty, or is not usable', async () => {
    expect(await verifier(keyServer({}, { status: 500 })).verify(sign(claims()))).toBeNull();
    expect(await verifier(keyServer({})).verify(sign(claims()))).toBeNull();
    expect(await verifier(keyServer([])).verify(sign(claims()))).toBeNull();

    const throwing = {
      calls: 0,
      fetchImplementation: (async () => {
        throw new Error('getaddrinfo ENOTFOUND keys.internal.example');
      }) as unknown as typeof fetch,
    };
    // The thrown message named a host. The verifier answers null and carries none
    // of it.
    expect(await verifier(throwing).verify(sign(claims()))).toBeNull();
  });

  it('caches the key set rather than fetching it per sign-in', async () => {
    const server = keyServer();
    const subject = verifier(server);

    await subject.verify(sign(claims()));
    await subject.verify(sign(claims()));
    await subject.verify(sign(claims()));

    expect(server.calls).toBe(1);
  });

  it('refetches once for an unknown key identifier, and not once per request', async () => {
    // An unknown `kid` is the normal shape of a key rotation, so it is worth one
    // refetch — but it must not let a caller drive a fetch per request.
    const server = keyServer();
    const subject = verifier(server);
    await subject.verify(sign(claims()));
    expect(server.calls).toBe(1);

    await subject.verify(sign(claims(), { alg: 'RS256', kid: 'rotated' }));
    await subject.verify(sign(claims(), { alg: 'RS256', kid: 'rotated' }));

    expect(server.calls).toBeLessThanOrEqual(3);
  });

  it('serves a key set whose response carried no cache directive', async () => {
    const server = keyServer({ [KID]: PUBLIC_PEM }, { cacheControl: '' });
    expect(await verifier(server).verify(sign(claims()))).not.toBeNull();
  });

  it('drops a malformed entry rather than failing the whole set', async () => {
    const server = keyServer({ broken: 42, [KID]: PUBLIC_PEM });
    expect(await verifier(server).verify(sign(claims()))).not.toBeNull();
  });
});
