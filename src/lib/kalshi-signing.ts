import { constants, createPrivateKey, sign } from 'node:crypto';

export function signKalshiRequest(timestamp: string, method: string, path: string, privateKeyPem: string): string {
  const pathWithoutQuery = path.split('?')[0];
  return sign('sha256', Buffer.from(`${timestamp}${method.toUpperCase()}${pathWithoutQuery}`), {
    key: createPrivateKey(privateKeyPem),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}
