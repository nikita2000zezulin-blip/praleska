// Отдаёт историю заявок из Supabase для admin.html и умеет удалять запись.
// Доступ только с валидным Firebase ID-токеном того же проекта — токен передаётся
// в заголовке Authorization и проверяется без похода во внешний Firebase Admin SDK.
import { json, preflight } from '../_shared/http.ts';
import { verifyFirebaseToken } from '../_shared/verify-firebase-token.ts';

const M = 'GET, DELETE';
const reply = (req: Request, status: number, body: unknown) => json(req, M, status, body);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request, M);

  if (request.method !== 'GET' && request.method !== 'DELETE') {
    return reply(request, 405, { error: 'Method not allowed' });
  }

  const authHeader = request.headers.get('authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) return reply(request, 401, { error: 'Unauthorized' });

  try {
    await verifyFirebaseToken(idToken);
  } catch {
    return reply(request, 401, { error: 'Unauthorized' });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return reply(request, 500, { error: 'Server is not configured' });

  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) return reply(request, 400, { error: 'Invalid id' });

    let delRes: Response;
    try {
      delRes = await fetch(`${url}/rest/v1/orders?id=eq.${id}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return reply(request, 502, { error: 'Supabase request failed' });
    }

    if (!delRes.ok) return reply(request, 502, { error: 'Supabase request failed' });
    return reply(request, 200, { ok: true });
  }

  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/orders?select=*&order=created_at.desc&limit=200`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return reply(request, 502, { error: 'Supabase request failed' });
  }

  if (!res.ok) return reply(request, 502, { error: 'Supabase request failed' });

  return reply(request, 200, { orders: await res.json() });
});
