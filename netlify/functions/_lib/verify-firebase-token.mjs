// Проверяет Firebase ID-токен без Firebase Admin SDK и без сервисного аккаунта:
// подпись сверяется с публичными ключами Google (JWKS), которые кэшируются на час.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const PROJECT_ID = 'praleska-3ca3f';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CACHE_MS = 60 * 60 * 1000;

let cachedKeys = null;
let cachedAt = 0;

async function getJwks() {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < CACHE_MS) return cachedKeys;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('JWKS fetch failed');
  const { keys } = await res.json();
  cachedKeys = keys;
  cachedAt = now;
  return keys;
}

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Возвращает payload токена (uid, email, ...) или бросает исключение, если токен недействителен.
export async function verifyFirebaseToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error('Unexpected alg');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('Token expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('Bad iat');
  if (payload.aud !== PROJECT_ID) throw new Error('Bad audience');
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('Bad issuer');
  if (!payload.sub) throw new Error('Missing sub');

  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown key id');

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecode(sigB64);
  if (!cryptoVerify('RSA-SHA256', signedData, publicKey, signature)) {
    throw new Error('Bad signature');
  }

  return payload;
}
