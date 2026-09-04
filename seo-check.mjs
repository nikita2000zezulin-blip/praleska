// Проверка SEO-разметки: страница отдаёт валидный JSON-LD и полный набор мета.
import { chromium } from 'file:///C:/Users/USER1/.bun/install/cache/playwright-core/1.62.1@@@1/index.mjs';
import assert from 'node:assert';

const b = await chromium.launch({ channel: 'msedge' });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8899/', { waitUntil: 'domcontentloaded' });

await p.waitForFunction(() => document.querySelectorAll('script[type="application/ld+json"]').length >= 2);
const ld = await p.$$eval('script[type="application/ld+json"]', ns => ns.map(n => JSON.parse(n.textContent)));
const shop = ld.find(x => x['@type'] === 'FloristShop');
const list = ld.find(x => x['@type'] === 'ItemList');
assert(shop && shop.priceRange && shop.hasOfferCatalog.itemListElement.length === 6, 'FloristShop неполный');
assert(list && list.itemListElement.length > 30, 'ItemList не собрался: ' + (list?.itemListElement.length));
assert(list.itemListElement.every(i => i.item.name && i.item.offers.price > 0), 'товар без имени или цены');

const meta = await p.$$eval('meta[property], meta[name], link[rel=canonical]',
  ns => Object.fromEntries(ns.map(n => [n.getAttribute('property') || n.getAttribute('rel') || n.name, n.content || n.href])));
for (const k of ['description', 'robots', 'og:title', 'og:description', 'og:url', 'og:image', 'og:site_name', 'twitter:card', 'canonical'])
  assert(meta[k], 'нет ' + k);

const og = await p.request.get(meta['og:image'].replace('https://praleskaby.github.io', 'http://127.0.0.1:8899'));
assert(og.ok(), 'og:image недоступна');

// Метрика не должна грузиться до согласия
const banner = p.locator('#cookieBanner');
await banner.waitFor({ state: 'visible' });
assert(!(await p.evaluate(() => 'ym' in window)), 'Метрика загрузилась до согласия');
await p.click('#cookieDenyBtn');
assert(await p.evaluate(() => localStorage.getItem('praleska_consent')) === 'necessary', 'отказ не сохранён');

// Заявка уходит вместе с меткой источника.
// Нужна чистая вкладка: метку источника запоминает sessionStorage, и она
// осталась бы от предыдущего захода без utm — как и задумано в самом сайте.
const p2 = await (await b.newContext()).newPage();
await p2.goto('http://127.0.0.1:8899/?utm_source=test_ads&utm_campaign=mogilev', { waitUntil: 'domcontentloaded' });
let body = null;
await p2.route('**/functions/v1/send-order', (route) => {
  body = JSON.parse(route.request().postData());
  route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
await p2.fill('#name', 'Тест');
await p2.fill('#phone', '+375291234567');
await p2.check('#consentData');
await p2.check('#consentTransfer');
await p2.click('#submitBtn');
await p2.waitForFunction(() => document.getElementById('formStatus').classList.contains('ok'));
assert(body?.source === 'test_ads / mogilev', 'метка источника не дошла: ' + body?.source);

// Все фото каталога — webp, кроме обложки для мессенджеров
const jpgs = await p2.$$eval('img', ns => ns.map(n => n.getAttribute('src')).filter(s => s && s.endsWith('.jpg')));
assert(jpgs.length === 0, 'остались jpg: ' + jpgs);
assert(await p2.locator('a[href^="viber://"]').count() >= 2, 'нет кнопок Viber');

console.log('OK: товаров', list.itemListElement.length,
  '| источник заявки:', body.source,
  '| Viber-кнопок:', await p2.locator('a[href^="viber://"]').count());
await b.close();
