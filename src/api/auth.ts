/**
 * Kalshi RSA-PSS Authentication
 *
 * Signs API requests with RSA-PSS SHA256.
 * Message format: timestamp_ms + HTTP_METHOD + path (no query params)
 */

import crypto from 'crypto';

export function formatPrivateKey(key: string): string {
  if (key.includes('-----BEGIN')) return key;

  let clean = key.replace(/^kalshi\s*key:\s*/i, '');
  clean = clean.replace(/\s/g, '');

  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.slice(i, i + 64));
  }

  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`;
}

export function signRequest(
  method: string,
  path: string,
  timestampMs: string,
  privateKey: string
): string {
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;
  const pemKey = formatPrivateKey(privateKey);

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign({
    key: pemKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString('base64');
}

export function getAuthHeaders(
  method: string,
  path: string,
  apiKeyId: string,
  privateKey: string
): Record<string, string> {
  const timestampMs = Date.now().toString();
  const signature = signRequest(method, path, timestampMs, privateKey);

  return {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestampMs,
  };
}
