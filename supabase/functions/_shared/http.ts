// Общие мелочи для обеих функций: CORS и JSON-ответы.
// На GitHub Pages сайт и API живут на разных доменах, поэтому CORS обязателен.

const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** Origin запроса, если он есть в белом списке. */
export function allowedOrigin(request: Request): string | null {
  const origin = (request.headers.get('origin') || '').replace(/\/$/, '');
  return origin && ALLOWED.includes(origin) ? origin : null;
}

export function corsHeaders(request: Request, methods: string): HeadersInit {
  const origin = allowedOrigin(request);
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': `${methods}, OPTIONS`,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(request: Request, methods: string, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, methods),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function preflight(request: Request, methods: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, methods) });
}
