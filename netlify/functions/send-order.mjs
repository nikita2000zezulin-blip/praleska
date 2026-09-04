// Принимает заявку с формы и пересылает её в Telegram.
// Токен бота и chat_id читаются из переменных окружения Netlify —
// они никогда не попадают в код, который отдаётся браузеру.

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// Максимальный размер тела запроса — заявка не может быть больше пары килобайт.
const MAX_BODY = 8 * 1024;

/* ---------- Ограничение частоты запросов ----------
   Счётчики живут в памяти инстанса функции. Между «холодными» запусками
   они обнуляются, поэтому это не абсолютная защита, а заслон от простого
   флуда: одиночный скрипт, долбящий эндпоинт, упрётся в лимит.
   Если понадобится жёсткая гарантия — нужен внешний счётчик (Netlify Blobs)
   или капча перед отправкой. */
const WINDOW_MS = 15 * 60 * 1000;
// 5, а не 3: у мобильных операторов десятки абонентов сидят за одним IP,
// и слишком строгий лимит отсёк бы живого клиента.
const PER_IP_LIMIT = 5;
const GLOBAL_LIMIT = 30;

const hits = new Map(); // ip -> number[] (метки времени)
let globalHits = [];

const fresh = (list, now) => list.filter((t) => now - t < WINDOW_MS);

function rateLimited(ip) {
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

/* ---------- Проверка источника запроса ----------
   Заявку принимаем только со своего же сайта. Заголовок можно подделать
   вручную, но это отсекает и чужие сайты, и автоматические сканеры. */
function allowedOrigins() {
  const list = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL];
  return new Set(list.filter(Boolean).map((u) => u.replace(/\/$/, '')));
}

function sameSite(request) {
  const allowed = allowedOrigins();
  if (!allowed.size) return true; // локальная разработка: переменных Netlify нет

  const origin = request.headers.get('origin');
  if (origin) return allowed.has(origin.replace(/\/$/, ''));

  // Некоторые расширения вырезают Origin — тогда смотрим на Referer.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

/* ---------- Проверка полей ---------- */
const isText = (v) => typeof v === 'string';
const trimmed = (v) => (isText(v) ? v.trim() : '');
// Цифры, пробелы, скобки, плюс и дефис — всё, что бывает в телефоне.
const PHONE_RE = /^[\d\s()+-]{7,20}$/;

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: 'POST' },
    });
  }

  if (!sameSite(request)) {
    return reply(403, { error: 'Forbidden' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return reply(500, { error: 'Server is not configured' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return reply(413, { error: 'Payload too large' });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'Invalid JSON' });
  }
  if (!data || typeof data !== 'object') {
    return reply(400, { error: 'Invalid JSON' });
  }

  const { name, phone, occasion, comment, company, consentData, consentTransfer } = data;

  // Honeypot: заявку отправил бот — тихо принимаем, но никуда не шлём.
  if (company) {
    return reply(200, { ok: true });
  }

  const cleanName = trimmed(name);
  const cleanPhone = trimmed(phone);

  if (cleanName.length < 2 || cleanName.length > 80) {
    return reply(400, { error: 'Name and phone are required' });
  }
  if (!PHONE_RE.test(cleanPhone)) {
    return reply(400, { error: 'Name and phone are required' });
  }
  if (!consentData || !consentTransfer) {
    return reply(400, { error: 'Consent is required' });
  }

  // Лимит проверяем только после того, как заявка признана осмысленной,
  // иначе мусорными запросами можно было бы «сжечь» лимит живого человека.
  const ip = request.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { ...JSON_HEADERS, 'Retry-After': String(WINDOW_MS / 1000) },
    });
  }

  // parse_mode не задан — Telegram покажет текст как есть, разметка не сработает.
  // Управляющие символы вырезаем, чтобы заявку нельзя было замаскировать.
  const clean = (s, max = 500) =>
    String(s)
      .slice(0, max)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/[<>&]/g, '');

  const text = `🌸 Новая заявка с сайта «Пралеска»\n\n` +
    `Имя: ${clean(cleanName, 80)}\n` +
    `Телефон: ${clean(cleanPhone, 20)}\n` +
    `Повод: ${clean(occasion || '—', 100)}\n` +
    `Комментарий: ${clean(comment || '—')}\n\n` +
    `Согласие на обработку ПД: получено\n` +
    `Согласие на трансграничную передачу: получено\n` +
    `Время: ${new Date().toISOString()}`;

  let tgRes;
  try {
    tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // Наружу не отдаём подробности — в логах Netlify они всё равно есть.
    console.error('Telegram fetch threw:', err && err.message);
    return reply(502, { error: 'Telegram send failed' });
  }

  if (!tgRes.ok) {
    const body = await tgRes.text().catch(() => '');
    console.error('Telegram API error:', tgRes.status, body);
    return reply(502, { error: 'Telegram send failed' });
  }

  // Заявка уже доставлена в Telegram — это критичный путь, он не должен зависеть
  // от Supabase. Лог заявок пишем best-effort и не роняем ответ клиенту при сбое.
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
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

  return reply(200, { ok: true });
};

export const config = { path: '/api/send-order' };
