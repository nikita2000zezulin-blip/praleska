// Отдаёт историю заявок из Supabase для admin.html.
// Доступ только с валидным Firebase ID-токеном того же проекта — токен передаётся
// в заголовке Authorization и проверяется без похода во внешний Firebase Admin SDK.
import { verifyFirebaseToken } from './_lib/verify-firebase-token.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export default async (request) => {
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: 'GET, DELETE' },
    });
  }

  const authHeader = request.headers.get('authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) return reply(401, { error: 'Unauthorized' });

  try {
    await verifyFirebaseToken(idToken);
  } catch {
    return reply(401, { error: 'Unauthorized' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return reply(500, { error: 'Server is not configured' });

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) return reply(400, { error: 'Invalid id' });

    let delRes;
    try {
      delRes = await fetch(`${url}/rest/v1/orders?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return reply(502, { error: 'Supabase request failed' });
    }

    if (!delRes.ok) return reply(502, { error: 'Supabase request failed' });
    return reply(200, { ok: true });
  }

  let res;
  try {
    res = await fetch(`${url}/rest/v1/orders?select=*&order=created_at.desc&limit=200`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return reply(502, { error: 'Supabase request failed' });
  }

  if (!res.ok) return reply(502, { error: 'Supabase request failed' });

  const orders = await res.json();
  return reply(200, { orders });
};

export const config = { path: '/api/orders' };
