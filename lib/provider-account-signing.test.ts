import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createHmac, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { cryptoComParameterString, cryptoComSignature } from './cryptocom-api';
import { robinhoodPrivateKey, robinhoodSignature, robinhoodSigningMessage } from './robinhood-api';

/**
 * Signing is the part that cannot be checked by reading a response: a wrong signature returns a generic
 * rejection, not a hint. These cases pin the exact byte layout each venue documents, so a future edit
 * that reorders or reformats anything fails here rather than against a live account.
 */
describe('Crypto.com request signing', () => {
  it('sorts parameters and concatenates key with value, since order is part of the signature', () => {
    expect(cryptoComParameterString({ b: 2, a: 1, c: 'x' })).toBe('a1b2cx');
    expect(cryptoComParameterString({})).toBe('');
  });

  it('emits the bare key for null and undefined rather than the string "null"', () => {
    expect(cryptoComParameterString({ a: null, b: undefined, c: 1 })).toBe('abc1');
  });

  it('serializes nested values as JSON so an object cannot become [object Object]', () => {
    expect(cryptoComParameterString({ list: [1, 2] })).toBe('list[1,2]');
    expect(cryptoComParameterString({ o: { k: 'v' } })).toBe('o{"k":"v"}');
  });

  it('signs method, id, key, params, and nonce in that documented order', () => {
    const signature = cryptoComSignature({
      method: 'private/user-balance', id: 11, apiKey: 'KEY', apiSecret: 'SECRET', nonce: 1_700_000_000_000,
      params: { b: 2, a: 1 },
    });
    const expected = createHmac('sha256', 'SECRET')
      .update('private/user-balance11KEYa1b21700000000000').digest('hex');
    expect(signature).toBe(expected);
  });

  it('changes signature when any component changes, so replay of a stale nonce cannot pass', () => {
    const base = { method: 'private/user-balance', id: 1, apiKey: 'K', apiSecret: 'S', nonce: 1 };
    const original = cryptoComSignature(base);
    expect(cryptoComSignature({ ...base, nonce: 2 })).not.toBe(original);
    expect(cryptoComSignature({ ...base, id: 2 })).not.toBe(original);
    expect(cryptoComSignature({ ...base, params: { a: 1 } })).not.toBe(original);
  });
});

describe('Robinhood request signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // Robinhood's generator emits a raw 32-byte seed in base64; recover that from a PKCS#8 DER export.
  const seedBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16, 48).toString('base64');

  it('builds the message as apiKey + timestamp + path + method + body', () => {
    expect(robinhoodSigningMessage({
      apiKey: 'rh-key', timestamp: 1_700_000_000, path: '/api/v1/crypto/trading/accounts/', method: 'GET',
    })).toBe('rh-key1700000000/api/v1/crypto/trading/accounts/GET');
  });

  it('includes a request body in the signed message when one is sent', () => {
    expect(robinhoodSigningMessage({
      apiKey: 'k', timestamp: 1, path: '/p', method: 'POST', body: '{"a":1}',
    })).toBe('k1/pPOST{"a":1}');
  });

  it('accepts a raw 32-byte seed and produces a signature the public key verifies', () => {
    const timestamp = 1_700_000_000;
    const path = '/api/v1/crypto/trading/holdings/';
    const signature = robinhoodSignature({ apiKey: 'rh-key', privateKeyBase64: seedBase64, timestamp, path, method: 'GET' });
    const message = Buffer.from(robinhoodSigningMessage({ apiKey: 'rh-key', timestamp, path, method: 'GET' }), 'utf8');
    expect(cryptoVerify(null, message, publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });

  it('tolerates a 64-byte seed+public export by using the leading seed', () => {
    const long = Buffer.concat([Buffer.from(seedBase64, 'base64'), Buffer.alloc(32, 7)]).toString('base64');
    expect(() => robinhoodPrivateKey(long)).not.toThrow();
    expect(robinhoodSignature({ apiKey: 'k', privateKeyBase64: long, timestamp: 1, path: '/p', method: 'GET' }))
      .toBe(robinhoodSignature({ apiKey: 'k', privateKeyBase64: seedBase64, timestamp: 1, path: '/p', method: 'GET' }));
  });

  it('rejects a key too short to be Ed25519 instead of signing with padded garbage', () => {
    expect(() => robinhoodPrivateKey(Buffer.alloc(16).toString('base64'))).toThrow(/32-byte/);
  });

  it('signs a different message for a different timestamp, so a captured header cannot be reused', () => {
    const base = { apiKey: 'k', privateKeyBase64: seedBase64, path: '/p', method: 'GET' };
    expect(robinhoodSignature({ ...base, timestamp: 1 })).not.toBe(robinhoodSignature({ ...base, timestamp: 2 }));
  });
});

describe('unconfigured providers fail closed', () => {
  it('reports a missing-credential account without attempting a request', async () => {
    for (const key of ['CRYPTOCOM_API_KEY', 'CRYPTOCOM_API_SECRET', 'ROBINHOOD_API_KEY', 'ROBINHOOD_PRIVATE_KEY']) {
      delete process.env[key];
    }
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const [{ getCryptoComAccount }, { getRobinhoodAccount }] = await Promise.all([
      import('./cryptocom-api'), import('./robinhood-api'),
    ]);
    for (const account of [await getCryptoComAccount(), await getRobinhoodAccount()]) {
      expect(account.configured).toBe(false);
      expect(account.connected).toBe(false);
      expect(account.tradeAuthenticated).toBe(false);
      expect(account.error).toMatch(/Set [A-Z_]+ and [A-Z_]+/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
