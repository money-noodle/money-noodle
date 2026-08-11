import { constants, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signKalshiRequest } from './kalshi-signing';

describe('Kalshi request signing', () => {
  it('signs timestamp + method + queryless API path with RSA-PSS SHA-256', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const timestamp = '1786200000000';
    const signature = signKalshiRequest(timestamp, 'get', '/trade-api/v2/portfolio/orders?limit=10', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const valid = verify('sha256', Buffer.from(`${timestamp}GET/trade-api/v2/portfolio/orders`), {
      key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }, Buffer.from(signature, 'base64'));
    expect(valid).toBe(true);
  });
});
