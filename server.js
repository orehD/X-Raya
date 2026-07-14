// Пеленг (ex-X-Raya) self-hosted сервер (без зависимостей, Node 18+).
// Отдаёт index.html и держит POST /api/ai как прокси к OpenRouter (ключ — из env).
// Запуск: node server.js   (PORT по умолчанию 3000)
//
// Переменные окружения:
//   OPENROUTER_API_KEY — ключ sk-or-... для прямого вызова OpenRouter (если IP сервера не заблокирован)
//   AI_RELAY_URL       — URL Cloudflare Worker-relay (обходит блокировку IP; см. relay-worker.js).
//                        Если задан — используется вместо прямого вызова, ключ OpenRouter живёт в воркере.
//   RELAY_SECRET       — необязательно: общий секрет, чтобы воркером не пользовались чужие (тот же и в воркере)
//   AI_MODEL           — необязательно (по умолчанию openai/gpt-4o-mini)
//   LEADS_FILE         — куда писать email-заявки (по умолчанию ./data/leads.jsonl;
//                        в Coolify смонтируй volume на эту папку, иначе файл сотрётся при редеплое)
//   TG_BOT_TOKEN, TG_CHAT_ID — необязательно: уведомление в Telegram о каждой заявке
//   STATS_TOKEN        — необязательно: пароль к странице статистики /stats (заявки по партнёрам)
//   SIGNALHIRE_KEY     — необязательно: ключ SignalHire Person API (пробив контактов по LinkedIn/email/телефону);
//                        SIGNALHIRE_API — принимается как синоним
//   SERPER_KEY         — необязательно: проверка размера выдачи через Serper.dev (проще всего;
//                        serper.dev → Sign up → API key; 2500 бесплатных проверок). Приоритетнее CSE.
//   GOOGLE_CSE_KEY, GOOGLE_CSE_CX — необязательно, альтернатива Serper: Google Custom Search
//                        (programmablesearchengine.google.com → поисковик «весь интернет» → cx;
//                         ключ — в Google Cloud Console, Custom Search API; 100 запросов/день бесплатно)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT  = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';

function send(res, code, type, body) {
  const h = { 'content-type': type };
  // HTML не кэшируем: после Redeploy пользователи сразу получают свежую версию без Cmd+Shift+R
  if (type.startsWith('text/html')) h['cache-control'] = 'no-cache';
  res.writeHead(code, h);
  res.end(body);
}

function handleAI(req, res) {
  let relay = (process.env.AI_RELAY_URL || '').trim(); // Cloudflare Worker (обходит блок IP сервера)
  if (relay && !/^https?:\/\//i.test(relay)) relay = 'https://' + relay;
  const key = process.env.OPENROUTER_API_KEY;
  if (!relay && !key) return send(res, 500, 'application/json', JSON.stringify({ error: 'OPENROUTER_API_KEY или AI_RELAY_URL не задан на сервере' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const system = body.system || '', user = body.user || '';
    if (!user) return send(res, 400, 'application/json', JSON.stringify({ error: 'нет поля user' }));
    try {
      // Вариант 1: через relay-воркер (ключ живёт в секретах Cloudflare, не на Beget)
      if (relay) {
        const r = await fetch(relay, {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' },
            process.env.RELAY_SECRET ? { 'x-relay-auth': process.env.RELAY_SECRET } : {}),
          body: JSON.stringify({ system, user, model: MODEL }),
        });
        const d = await r.json();
        if (!r.ok) return send(res, 502, 'application/json', JSON.stringify({ error: (d && (d.error || d.message)) || 'relay error' }));
        return send(res, 200, 'application/json', JSON.stringify({ text: d.text || '' }));
      }
      // Вариант 2: напрямую в OpenRouter (работает, если IP сервера не заблокирован)
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

// ── статистика по заявкам (заявки по партнёрам /?ref=) ──
function handleStats(req, res) {
  const token = process.env.STATS_TOKEN;
  if (!token) return send(res, 501, 'application/json', JSON.stringify({ error: 'STATS_TOKEN не задан на сервере' }));
  const url = new URL(req.url, 'http://x');
  const given = req.headers['x-stats-token'] || url.searchParams.get('token') || '';
  if (given !== token) return send(res, 401, 'application/json', JSON.stringify({ error: 'неверный пароль' }));

  let rows = [];
  try {
    rows = fs.readFileSync(LEADS_FILE, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}
  const byRef = {};
  for (const r of rows) {
    const k = (r.ref && String(r.ref).trim()) || '(прямые)';
    byRef[k] = (byRef[k] || 0) + 1;
  }
  const partners = Object.entries(byRef).map(([ref, count]) => ({ ref, count })).sort((a, b) => b.count - a.count);
  const recent = rows.slice(-100).reverse();
  send(res, 200, 'application/json', JSON.stringify({ total: rows.length, partners, recent }));
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

// ── проверка размера выдачи (Serper.dev приоритетно, иначе Google CSE) ──
const countCache = new Map(); // qhash → {at, found, approx}
const countHits = new Map();

// Serper.dev: отдаёт список органики. approx=true → found это число результатов на первой
// странице (10 = «есть много», меньше = реальное малое число, 0 = пусто).
async function countViaSerper(q, key) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST', signal: ctl.signal,
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q, num: 10, gl: 'ru', hl: 'ru' }),
    });
    const d = await r.json();
    if (!r.ok) { const e = new Error((d && (d.message || d.error)) || 'serper error'); e.code = r.status; throw e; }
    const found = Array.isArray(d.organic) ? d.organic.length : 0;
    return { found, approx: true };
  } finally { clearTimeout(tm); }
}

// Google CSE: даёт оценку общего числа результатов (approx=false → показываем ~N).
async function countViaCSE(q, key, cx) {
  const u = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(key) +
    '&cx=' + encodeURIComponent(cx) + '&num=1&fields=searchInformation(totalResults)&q=' + encodeURIComponent(q);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    const d = await r.json();
    if (!r.ok) { const e = new Error((d.error && d.error.message) || 'cse error'); e.code = /quota|limit/i.test(e.message) ? 429 : 502; throw e; }
    const found = parseInt((d.searchInformation && d.searchInformation.totalResults) || '0', 10) || 0;
    return { found, approx: false };
  } finally { clearTimeout(tm); }
}

function handleCount(req, res) {
  const serper = process.env.SERPER_KEY;
  const cseKey = process.env.GOOGLE_CSE_KEY, cseCx = process.env.GOOGLE_CSE_CX;
  if (!serper && !(cseKey && cseCx)) return send(res, 501, 'application/json', JSON.stringify({ error: 'not_configured' }));
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
      return send(res, 200, 'application/json', JSON.stringify({ found: cached.found, approx: cached.approx, cached: true }));
    try {
      const out = serper ? await countViaSerper(q, serper) : await countViaCSE(q, cseKey, cseCx);
      countCache.set(ck, { at: now, found: out.found, approx: out.approx });
      if (countCache.size > 3000) countCache.delete(countCache.keys().next().value);
      send(res, 200, 'application/json', JSON.stringify(out));
    } catch (e) {
      send(res, e.code || 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }));
    }
  });
}

// ── пробив контактов через SignalHire Person API (sync, withoutWaterfall) ──
// Идентификатор: LinkedIn URL / email / телефон. 1 успешный мэтч = 1 кредит SignalHire.
const SH_URL = process.env.SH_API_URL || 'https://www.signalhire.com/api/v1/candidate/search';
const shCache = new Map(); // item(lower) → {at, data} — повторный лукап не жжёт кредит
const shHits = new Map();

function validContactItem(s) {
  if (/^https?:\/\/([\w-]+\.)?linkedin\.com\/(in|sales)\/\S+$/i.test(s)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return true;
  if (/^\+?[\d\s\-().]{7,20}$/.test(s)) return true;
  return false;
}

function handleContact(req, res) {
  const key = process.env.SIGNALHIRE_KEY || process.env.SIGNALHIRE_API;
  if (!key) return send(res, 501, 'application/json', JSON.stringify({ error: 'not_configured' }));
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (shHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 30) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — лимит 30 пробивов в час' }));
  hits.push(now); shHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const item = String(body.item || '').trim().slice(0, 300);
    if (!validContactItem(item))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'нужна ссылка на LinkedIn-профиль, email или телефон' }));
    const ck = item.toLowerCase();
    const cached = shCache.get(ck);
    if (cached && now - cached.at < 7 * 24 * 3600e3)
      return send(res, 200, 'application/json', JSON.stringify(Object.assign({ cached: true }, cached.data)));
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(SH_URL, {
        method: 'POST', signal: ctl.signal,
        headers: { apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [item], withoutWaterfall: true }),
      });
      clearTimeout(tm);
      const credits = parseInt(r.headers.get('x-credits-left') || '', 10);
      if (r.status === 402) return send(res, 402, 'application/json', JSON.stringify({ error: 'кредиты SignalHire закончились' }));
      if (r.status === 401) return send(res, 502, 'application/json', JSON.stringify({ error: 'SignalHire: неверный ключ' }));
      if (r.status === 429) return send(res, 429, 'application/json', JSON.stringify({ error: 'SignalHire: слишком много запросов, подожди минуту' }));
      const arr = await r.json();
      if (!r.ok || !Array.isArray(arr))
        return send(res, 502, 'application/json', JSON.stringify({ error: (arr && (arr.error || arr.message)) || 'SignalHire error' }));
      const it = arr[0] || {};
      if (it.status !== 'success') {
        const msg = it.status === 'credits_are_over' ? 'кредиты SignalHire закончились'
          : it.status === 'duplicate_query' ? 'повторный запрос — подожди пару минут'
          : 'профиль не найден в базе SignalHire';
        const code = it.status === 'credits_are_over' ? 402 : 200;
        return send(res, code, 'application/json', JSON.stringify({ status: it.status || 'failed', error: msg, credits: isNaN(credits) ? null : credits }));
      }
      const c = it.candidate || {};
      const contacts = (Array.isArray(c.contacts) ? c.contacts : [])
        .filter(x => x && x.value && (x.type === 'email' || x.type === 'phone'))
        .map(x => ({ type: x.type, value: String(x.value), rating: x.rating || null, subType: x.subType || null }));
      const exp0 = Array.isArray(c.experience) && c.experience[0] ? c.experience[0] : null;
      const data = {
        status: 'success',
        fullName: c.fullName || '',
        headline: c.headLine || (exp0 ? [exp0.position, exp0.company].filter(Boolean).join(' · ') : ''),
        location: (Array.isArray(c.locations) && c.locations[0] && c.locations[0].name) || '',
        contacts,
        credits: isNaN(credits) ? null : credits,
      };
      shCache.set(ck, { at: now, data });
      if (shCache.size > 1000) shCache.delete(shCache.keys().next().value);
      send(res, 200, 'application/json', JSON.stringify(data));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

const STATS_PAGE = path.join(__dirname, 'stats.html');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ai') return handleAI(req, res);
  if (req.method === 'POST' && req.url === '/api/lead') return handleLead(req, res);
  if (req.method === 'POST' && req.url === '/api/nick') return handleNick(req, res);
  if (req.method === 'POST' && req.url === '/api/count') return handleCount(req, res);
  if (req.method === 'POST' && req.url === '/api/contact') return handleContact(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/stats') return handleStats(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/stats') {
    return fs.readFile(STATS_PAGE, (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'stats.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/privacy') {
    return fs.readFile(path.join(__dirname, 'privacy.html'), (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'privacy.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  // OG-превью для шаринга в мессенджерах
  if (req.method === 'GET' && req.url.split('?')[0] === '/og.png') {
    return fs.readFile(path.join(__dirname, 'og.png'), (err, data) => {
      if (err) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(data);
    });
  }
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
