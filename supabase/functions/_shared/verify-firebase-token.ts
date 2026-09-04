// Проверяет Firebase ID-токен без Firebase Admin SDK и без сервисного аккаунта:
// подпись сверяется с публичными ключами Google (JWKS), которые кэшируются на час.
// В отличие от версии для Netlify здесь WebCrypto вместо node:crypto — тот же
// алгоритм, но код переносится на любой рантайм без изменений.

const PROJECT_ID = 'praleska-3ca3f';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CACHE_MS = 60 * 60 * 1000;

let cachedKeys: any[] | null = null;
let cachedAt = 0;

async function getJwks(): Promise<any[]> {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < CACHE_MS) return cachedKeys;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('JWKS fetch failed');
  const { keys } = await res.json();
  cachedKeys = keys;
  cachedAt = now;
  return keys;
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Возвращает payload токена (uid, email, ...) или бросает исключение, если токен недействителен. */
export async function verifyFirebaseToken(idToken: string): Promise<any> {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64urlDecode(headerB64)));
  const payload = JSON.parse(dec.decode(b64urlDecode(payloadB64)));

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

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(sigB64), signedData);
  if (!ok) throw new Error('Bad signature');

  return payload;
}
