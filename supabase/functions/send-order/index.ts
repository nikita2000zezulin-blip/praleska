// Принимает заявку с формы и пересылает её в Telegram.
// Токен бота и chat_id читаются из секретов Supabase —
// они никогда не попадают в код, который отдаётся браузеру.
import { allowedOrigin, corsHeaders, json, preflight } from '../_shared/http.ts';

const M = 'POST';
const reply = (req: Request, status: number, body: unknown) => json(req, M, status, body);

// Максимальный размер тела запроса — заявка не может быть больше пары килобайт.
const MAX_BODY = 8 * 1024;

/* ---------- Ограничение частоты запросов ----------
   Счётчики живут в памяти инстанса функции. Между «холодными» запусками
   они обнуляются, поэтому это не абсолютная защита, а заслон от простого
   флуда: одиночный скрипт, долбящий эндпоинт, упрётся в лимит. */
const WINDOW_MS = 15 * 60 * 1000;
// 5, а не 3: у мобильных операторов десятки абонентов сидят за одним IP,
// и слишком строгий лимит отсёк бы живого клиента.
const PER_IP_LIMIT = 5;
const GLOBAL_LIMIT = 30;

const hits = new Map<string, number[]>();
let globalHits: number[] = [];

const fresh = (list: number[], now: number) => list.filter((t) => now - t < WINDOW_MS);

function rateLimited(ip: string): boolean {
  const now = Date.now();

  globalHits = fresh(globalHits, now);
  if (globalHits.length >= GLOBAL_LIMIT) return true;

  // Подчищаем протухшие записи, чтобы Map не рос бесконечно.
  for (const [key, list] of hits) {
    const kept = fresh(list, now);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
  }

  const mine = hits.get(ip) || [];
  if (mine.length >= PER_IP_LIMIT) return true;

  hits.set(ip, [...mine, now]);
  globalHits.push(now);
  return false;
}

/* ---------- Проверка полей ---------- */
const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
// Цифры, пробелы, скобки, плюс и дефис — всё, что бывает в телефоне.
const PHONE_RE = /^[\d\s()+-]{7,20}$/;

// Управляющие символы вырезаем, чтобы заявку нельзя было замаскировать.
const clean = (s: unknown, max = 500) =>
  String(s)
    .slice(0, max)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>&]/g, '');

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request, M);

  if (request.method !== 'POST') {
    return reply(request, 405, { error: 'Method not allowed' });
  }

  /* Заявку принимаем только со своего же сайта. Заголовок можно подделать
     вручную, но это отсекает и чужие сайты, и автоматические сканеры. */
  if (!allowedOrigin(request)) {
    return reply(request, 403, { error: 'Forbidden' });
  }

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    return reply(request, 500, { error: 'Server is not configured' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return reply(request, 413, { error: 'Payload too large' });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return reply(request, 400, { error: 'Invalid JSON' });
  }
  if (!data || typeof data !== 'object') {
    return reply(request, 400, { error: 'Invalid JSON' });
  }

  const { name, phone, occasion, comment, company, consentData, consentTransfer } = data;

  // Honeypot: заявку отправил бот — тихо принимаем, но никуда не шлём.
  if (company) return reply(request, 200, { ok: true });

  const cleanName = trimmed(name);
  const cleanPhone = trimmed(phone);

  if (cleanName.length < 2 || cleanName.length > 80) {
    return reply(request, 400, { error: 'Name and phone are required' });
  }
  if (!PHONE_RE.test(cleanPhone)) {
    return reply(request, 400, { error: 'Name and phone are required' });
  }
  if (!consentData || !consentTransfer) {
    return reply(request, 400, { error: 'Consent is required' });
  }

  // Лимит проверяем только после того, как заявка признана осмысленной,
  // иначе мусорными запросами можно было бы «сжечь» лимит живого человека.
  const ip = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: {
        ...corsHeaders(request, M),
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(WINDOW_MS / 1000),
      },
    });
  }

  // parse_mode не задан — Telegram покажет текст как есть, разметка не сработает.
  const text = `🌸 Новая заявка с сайта «Пралеска»\n\n` +
    `Имя: ${clean(cleanName, 80)}\n` +
    `Телефон: ${clean(cleanPhone, 20)}\n` +
    `Повод: ${clean(occasion || '—', 100)}\n` +
    `Комментарий: ${clean(comment || '—')}\n\n` +
    `Согласие на обработку ПД: получено\n` +
    `Согласие на трансграничную передачу: получено\n` +
    `Время: ${new Date().toISOString()}`;

  let tgRes: Response;
  try {
    tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // Наружу не отдаём подробности — в логах Supabase они всё равно есть.
    console.error('Telegram fetch threw:', (err as Error)?.message);
    return reply(request, 502, { error: 'Telegram send failed' });
  }

  if (!tgRes.ok) {
    console.error('Telegram API error:', tgRes.status, await tgRes.text().catch(() => ''));
    return reply(request, 502, { error: 'Telegram send failed' });
  }

  // Заявка уже доставлена в Telegram — это критичный путь, он не должен зависеть
  // от записи в базу. Лог заявок пишем best-effort и не роняем ответ клиенту при сбое.
  const supaUrl = Deno.env.get('SUPABASE_URL');
  const supaKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (supaUrl && supaKey) {
    try {
      await fetch(`${supaUrl}/rest/v1/orders`, {
        method: 'POST',
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          name: clean(cleanName, 80),
          phone: clean(cleanPhone, 20),
          occasion: clean(occasion || '', 100),
          comment: clean(comment || ''),
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Молча игнорируем — заявка у клиента уже считается отправленной.
    }
  }

  return reply(request, 200, { ok: true });
});
