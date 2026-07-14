// Пеленг (ex-X-Raya) self-hosted сервер (без зависимостей, Node 18+).
// Отдаёт index.html и держит POST /api/ai как прокси к OpenRouter (ключ — из env).
// Запуск: node server.js   (PORT по умолчанию 3000)
//
// Переменные окружения:
//   OPENROUTER_API_KEY — обязательно (ключ sk-or-... ; задаётся в Coolify, НЕ в коде)
//   AI_MODEL           — необязательно (по умолчанию openai/gpt-4o-mini)
//   LEADS_FILE         — куда писать email-заявки (по умолчанию ./data/leads.jsonl;
//                        в Coolify смонтируй volume на эту папку, иначе файл сотрётся при редеплое)
//   TG_BOT_TOKEN, TG_CHAT_ID — необязательно: уведомление в Telegram о каждой заявке
//   GOOGLE_CSE_KEY, GOOGLE_CSE_CX — необязательно: проверка размера выдачи через Google Custom Search
//                        (programmablesearchengine.google.com → поисковик «весь интернет» → cx;
//                         ключ — в Google Cloud Console, Custom Search API; 100 запросов/день бесплатно)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT  = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}

function handleAI(req, res) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return send(res, 500, 'application/json', JSON.stringify({ error: 'OPENROUTER_API_KEY не задан на сервере' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const system = body.system || '', user = body.user || '';
    if (!user) return send(res, 400, 'application/json', JSON.stringify({ error: 'нет поля user' }));
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + key,
          'X-Title': 'Peleng',
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      const d = await r.json();
      if (!r.ok) return send(res, 502, 'application/json', JSON.stringify({ error: (d.error && (d.error.message || d.error)) || 'upstream error' }));
      const text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
      send(res, 200, 'application/json', JSON.stringify({ text }));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

// ── сбор email-заявок (ранний доступ к Pro) ──
const LEADS_FILE = process.env.LEADS_FILE || path.join(__dirname, 'data', 'leads.jsonl');
const seenLeads = new Set();
try {
  fs.readFileSync(LEADS_FILE, 'utf8').split('\n').forEach(l => {
    try { const e = JSON.parse(l).email; if (e) seenLeads.add(e); } catch {}
  });
} catch {}
const leadHits = new Map(); // ip → [timestamps], простейший rate limit

function handleLead(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (leadHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 10) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто, попробуй позже' }));
  hits.push(now); leadHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'некорректный email' }));
    if (!seenLeads.has(email)) {
      seenLeads.add(email);
      const rec = JSON.stringify({ email, at: new Date().toISOString(), ref: String(body.ref || '').slice(0, 60) });
      try {
        fs.mkdirSync(path.dirname(LEADS_FILE), { recursive: true });
        fs.appendFileSync(LEADS_FILE, rec + '\n');
      } catch (e) { console.error('lead write failed:', e.message); }
      const tk = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
      if (tk && chat) {
        fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: '🎯 Peleng: новая заявка на Pro\n' + email }),
        }).catch(() => {});
      }
      console.log('lead:', email);
    }
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}

// ── проверка ника: существует ли профиль на площадках ──
// kind 'status': 200 → найден, 404 → нет; kind 'string': 200 и есть маркер → найден.
// Площадки за Cloudflare (LeetCode, Kaggle, Behance…) не проверяем — фронт покажет «вручную».
const NICK_SITES = [
  { id: 'github',   u: n => 'https://github.com/' + n },
  { id: 'gitlab',   u: n => 'https://gitlab.com/' + n },
  { id: 'habr',     u: n => 'https://habr.com/ru/users/' + n + '/' },
  { id: 'dribbble', u: n => 'https://dribbble.com/' + n },
  { id: 'vk',       u: n => 'https://vk.com/' + n },
  { id: 'telegram', u: n => 'https://t.me/' + n, kind: 'string', str: 'tgme_page_title' },
];
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const nickHits = new Map();
const nickCache = new Map(); // nick → {at, data}

async function checkSite(site, nick) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(site.u(nick), {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA_CHROME, 'accept-language': 'ru,en;q=0.8' },
    });
    if (site.kind === 'string') {
      if (r.status !== 200) return 'unknown';
      const html = await r.text();
      return html.includes(site.str) ? 'found' : 'none';
    }
    if (r.status === 200) return 'found';
    if (r.status === 404) return 'none';
    return 'unknown';
  } catch { return 'unknown'; }
  finally { clearTimeout(tm); }
}

function handleNick(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (nickHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 60) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто' }));
  hits.push(now); nickHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const nick = String(body.nick || '').trim();
    if (!/^[\w.\-]{2,32}$/.test(nick))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'некорректный ник' }));
    const cached = nickCache.get(nick.toLowerCase());
    if (cached && now - cached.at < 3600e3)
      return send(res, 200, 'application/json', JSON.stringify(cached.data));
    const out = {};
    await Promise.all(NICK_SITES.map(async s => { out[s.id] = await checkSite(s, nick); }));
    nickCache.set(nick.toLowerCase(), { at: now, data: out });
    if (nickCache.size > 500) nickCache.delete(nickCache.keys().next().value);
    send(res, 200, 'application/json', JSON.stringify(out));
  });
}

// ── проверка размера выдачи через Google Custom Search API ──
const countCache = new Map(); // qhash → {at, found}
const countHits = new Map();

function handleCount(req, res) {
  const key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return send(res, 501, 'application/json', JSON.stringify({ error: 'not_configured' }));
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (countHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 200) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто' }));
  hits.push(now); countHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const q = String(body.q || '').trim().slice(0, 800);
    if (q.length < 3) return send(res, 400, 'application/json', JSON.stringify({ error: 'пустой запрос' }));
    const ck = q.toLowerCase();
    const cached = countCache.get(ck);
    if (cached && now - cached.at < 24 * 3600e3)
      return send(res, 200, 'application/json', JSON.stringify({ found: cached.found, cached: true }));
    try {
      const u = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(key) +
        '&cx=' + encodeURIComponent(cx) + '&num=1&fields=searchInformation(totalResults)' +
        '&q=' + encodeURIComponent(q);
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 10000);
      const r = await fetch(u, { signal: ctl.signal });
      clearTimeout(tm);
      const d = await r.json();
      if (!r.ok) {
        const msg = (d.error && d.error.message) || 'upstream error';
        // дневная квота CSE исчерпана — фронту отдаём как «не настроено сейчас»
        const code = /quota|limit/i.test(msg) ? 429 : 502;
        return send(res, code, 'application/json', JSON.stringify({ error: msg.slice(0, 200) }));
      }
      const found = parseInt((d.searchInformation && d.searchInformation.totalResults) || '0', 10) || 0;
      countCache.set(ck, { at: now, found });
      if (countCache.size > 3000) countCache.delete(countCache.keys().next().value);
      send(res, 200, 'application/json', JSON.stringify({ found }));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ai') return handleAI(req, res);
  if (req.method === 'POST' && req.url === '/api/lead') return handleLead(req, res);
  if (req.method === 'POST' && req.url === '/api/nick') return handleNick(req, res);
  if (req.method === 'POST' && req.url === '/api/count') return handleCount(req, res);
  // локальные шрифты
  if (req.method === 'GET' && req.url.startsWith('/fonts/') && req.url.indexOf('.woff2') !== -1) {
    const name = path.basename(req.url.split('?')[0]); // защита от path traversal
    return fs.readFile(path.join(__dirname, 'fonts', name), (err, data) => {
      if (err) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
      res.end(data);
    });
  }
  // всё остальное — отдаём одностраничник
  fs.readFile(INDEX, (err, data) => {
    if (err) return send(res, 500, 'text/plain', 'index.html not found');
    send(res, 200, 'text/html; charset=utf-8', data);
  });
});

server.listen(PORT, () => console.log('Peleng запущен на порту ' + PORT));
