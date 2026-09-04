// Самопроверка разбора Firebase ID-токена: подписываем токен собственным ключом,
// подсовываем свой JWKS вместо гугловского и убеждаемся, что валидный токен
// проходит, а любой подделанный — нет.
// Запуск:  npx deno@2 test supabase/functions/_shared/verify-firebase-token.test.ts
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { verifyFirebaseToken } from './verify-firebase-token.ts';

const PROJECT_ID = 'praleska-3ca3f';
const KID = 'test-key';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

const keys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);

// Модуль ходит за ключами Google — отдаём ему свой набор.
globalThis.fetch = () =>
  Promise.resolve(new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256' }] })));

async function makeToken(payload: Record<string, unknown>, kid = KID) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', kid }));
  const body = b64urlText(JSON.stringify({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: 'uid-1',
    iat: now - 10,
    exp: now + 3600,
    ...payload,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  ));
  return `${head}.${body}.${b64url(sig)}`;
}

Deno.test('валидный токен принимается', async () => {
  const payload = await verifyFirebaseToken(await makeToken({}));
  assertEquals(payload.sub, 'uid-1');
});

Deno.test('подделанная подпись отвергается', async () => {
  const [h, b] = (await makeToken({})).split('.');
  const other = await makeToken({ sub: 'uid-2' });
  await assertRejects(() => verifyFirebaseToken(`${h}.${b}.${other.split('.')[2]}`));
});

Deno.test('чужой проект в aud отвергается', async () => {
  await assertRejects(async () => verifyFirebaseToken(await makeToken({ aud: 'someone-else' })));
});

Deno.test('чужой issuer отвергается', async () => {
  await assertRejects(async () => verifyFirebaseToken(await makeToken({ iss: 'https://evil.example' })));
});

Deno.test('просроченный токен отвергается', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  await assertRejects(async () => verifyFirebaseToken(await makeToken({ exp: past })));
});

Deno.test('alg: none отвергается', async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'none', kid: KID }));
  const body = b64urlText(JSON.stringify({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: 'uid-1',
    iat: now - 10,
    exp: now + 3600,
  }));
  await assertRejects(() => verifyFirebaseToken(`${head}.${body}.`));
});

Deno.test('неизвестный kid отвергается', async () => {
  await assertRejects(async () => verifyFirebaseToken(await makeToken({}, 'no-such-key')));
});
