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
const crypto = require('crypto');

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
  // AI — фича за аккаунтом: без входа не расходуем токены
  if (!getUser(req)) return send(res, 401, 'application/json', JSON.stringify({ error: 'auth' }));
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

// ═══════════ Аккаунты: пользователи, сессии, magic-link ═══════════
// Вход без паролей: email → письмо со ссылкой (Resend) → подписанная cookie-сессия.
// Env: RESEND_API_KEY (отправка писем), RESEND_FROM (адрес отправителя, по умолчанию
//      onboarding@resend.dev — до верификации домена в Resend письма идут только владельцу аккаунта!),
//      SESSION_SECRET (не обязателен — сгенерится и сохранится в data/session.key),
//      AUTH_DEV=1 (только локально: вместо письма вернуть ссылку в ответе).
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'data', 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; } catch {}
let usersDirty = false;
function saveUsers() { usersDirty = true; }
setInterval(() => {
  if (!usersDirty) return;
  usersDirty = false;
  try { fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true }); fs.writeFileSync(USERS_FILE, JSON.stringify(users)); }
  catch (e) { console.error('users write failed:', e.message); }
}, 5000).unref();

const SECRET_FILE = path.join(__dirname, 'data', 'session.key');
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  try { SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    try { fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true }); fs.writeFileSync(SECRET_FILE, SESSION_SECRET); } catch {}
  }
}
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url').toString();
function signPayload(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); }
function makeToken(purpose, email, ttlMs) {
  const payload = purpose + '|' + email + '|' + (Date.now() + ttlMs);
  return b64u(payload) + '.' + signPayload(payload);
}
function checkToken(tok, purpose) {
  try {
    const [p, sig] = String(tok).split('.');
    const payload = unb64u(p);
    if (!crypto.timingSafeEqual(Buffer.from(signPayload(payload)), Buffer.from(sig))) return null;
    const [pur, email, exp] = payload.split('|');
    if (pur !== purpose || Date.now() > +exp) return null;
    return email;
  } catch { return null; }
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function getUser(req) {
  const email = checkToken(getCookie(req, 'plg_sess'), 'sess');
  return email && users[email] ? { email, u: users[email] } : null;
}
function setSession(req, res, email) {
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'plg_sess=' + makeToken('sess', email, 30 * 86400e3) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 30 * 86400 + secure);
}
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host;
}
const authHits = new Map();
const pwHits = new Map();
function overLimit(map, ip, max) {
  const now = Date.now();
  const hits = (map.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= max) return true;
  hits.push(now); map.set(ip, hits);
  return false;
}
// пароли: scrypt с солью, сравнение за постоянное время
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored || '').split('$');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// одноразовые коды входа (жизнь 10 минут, 5 попыток)
const loginCodes = new Map(); // email → {code, exp, tries}
// отправка письма через Resend (fire-and-forget использовать с .catch)
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY не задан');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.RESEND_FROM || 'Peleng <onboarding@resend.dev>', to: [to], subject, html }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d && (d.message || d.error)) || 'не удалось отправить письмо');
  return d;
}
function handleAuthRequest(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (authHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 8) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — попробуй через час' }));
  hits.push(now); authHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'некорректный email' }));
    const ref = String(body.ref || '').slice(0, 60).trim();
    if (!users[email]) users[email] = { plan: 'free', createdAt: new Date().toISOString(), searches: 0, contacts: 0 };
    // партнёрская метка: first-touch, но доприсваиваем и старым аккаунтам без метки
    if (ref && !users[email].ref) users[email].ref = ref;
    saveUsers();
    const link = baseUrl(req) + '/auth?token=' + encodeURIComponent(makeToken('login', email, 20 * 60e3));
    const code = String(crypto.randomInt(100000, 1000000));
    loginCodes.set(email, { code, exp: Date.now() + 10 * 60e3, tries: 0 });
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      if (process.env.AUTH_DEV === '1') return send(res, 200, 'application/json', JSON.stringify({ ok: true, link, code }));
      return send(res, 501, 'application/json', JSON.stringify({ error: 'Отправка писем не настроена (RESEND_API_KEY)' }));
    }
    try {
      await sendEmail(email, code + ' — код для входа в Peleng',
        '<div style="font-family:monospace;background:#12100A;color:#EDE6D4;padding:32px;border-radius:12px">' +
        '<div style="color:#F2A93B;font-size:18px;font-weight:bold;margin-bottom:14px">PELENG</div>' +
        '<p>Код для входа (действует 10 минут):</p>' +
        '<div style="font-size:34px;font-weight:bold;letter-spacing:8px;color:#FFC96B;margin:10px 0 18px">' + code + '</div>' +
        '<p style="color:#9A9077;font-size:12px">Введи его на странице входа — на любом устройстве.</p>' +
        '<p>Или открой ссылку на этом устройстве:</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#F2A93B;color:#1A1508;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Войти в Peleng</a></p>' +
        '<p style="color:#9A9077;font-size:12px">Если ты не запрашивал вход — просто игнорируй это письмо.</p></div>');
      send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    } catch (e) {
      send(res, 502, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}
// вход по коду из письма — работает с любого устройства
function handleAuthCode(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(pwHits, ip, 20)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком много попыток — подожди час' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    const code = String(body.code || '').trim();
    const entry = loginCodes.get(email);
    if (!entry || Date.now() > entry.exp) return send(res, 400, 'application/json', JSON.stringify({ error: 'код устарел — запроси новый' }));
    if (++entry.tries > 5) { loginCodes.delete(email); return send(res, 400, 'application/json', JSON.stringify({ error: 'слишком много попыток — запроси новый код' })); }
    if (code !== entry.code) return send(res, 400, 'application/json', JSON.stringify({ error: 'неверный код' }));
    loginCodes.delete(email);
    users[email] = users[email] || { plan: 'free', createdAt: new Date().toISOString(), searches: 0, contacts: 0 };
    users[email].lastLoginAt = new Date().toISOString(); saveUsers();
    setSession(req, res, email);
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}
// вход по паролю (если задан в кабинете)
function handleAuthPassword(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(pwHits, ip, 20)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком много попыток — подожди час' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    const pw = String(body.password || '');
    if (!users[email] || !users[email].pw || !checkPw(pw, users[email].pw))
      return send(res, 401, 'application/json', JSON.stringify({ error: 'неверная почта или пароль' }));
    users[email].lastLoginAt = new Date().toISOString(); saveUsers();
    setSession(req, res, email);
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}
// задать/сменить пароль (нужна активная сессия)
function handleSetPassword(req, res) {
  const sess = getUser(req);
  if (!sess) return send(res, 401, 'application/json', JSON.stringify({ error: 'auth' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const pw = String(body.password || '');
    if (pw.length < 8 || pw.length > 200)
      return send(res, 400, 'application/json', JSON.stringify({ error: 'пароль — минимум 8 символов' }));
    sess.u.pw = hashPw(pw); saveUsers();
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}
function handleAuthGo(req, res) {
  const url = new URL(req.url, 'http://x');
  const email = checkToken(url.searchParams.get('token') || '', 'login');
  if (!email) return send(res, 400, 'text/html; charset=utf-8',
    '<!doctype html><meta charset="utf-8"><body style="background:#12100A;color:#EDE6D4;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh">' +
    '<div style="text-align:center"><div style="color:#E0472F;font-size:18px;margin-bottom:10px">Ссылка устарела или неверна</div>' +
    '<a href="/cabinet" style="color:#F2A93B">Запросить новую →</a></div>');
  users[email] = users[email] || { plan: 'free', createdAt: new Date().toISOString(), searches: 0, contacts: 0 };
  users[email].lastLoginAt = new Date().toISOString(); saveUsers();
  setSession(req, res, email);
  res.writeHead(302, { location: '/cabinet' }); res.end();
}
function handleMe(req, res) {
  const s = getUser(req);
  if (!s) return send(res, 401, 'application/json', JSON.stringify({ error: 'auth' }));
  const plan = planOf(s.u);
  const daysLeft = (plan === 'pro' && s.u.proUntil)
    ? Math.max(0, Math.ceil((new Date(s.u.proUntil) - Date.now()) / 86400e3)) : null;
  send(res, 200, 'application/json', JSON.stringify({ email: s.email, plan,
    searches: s.u.searches || 0, contacts: s.u.contacts || 0, createdAt: s.u.createdAt, hasPw: !!s.u.pw,
    proUntil: (plan === 'pro' && s.u.proUntil) || null, daysLeft }));
}
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', 'plg_sess=; Path=/; HttpOnly; Max-Age=0');
  send(res, 200, 'application/json', JSON.stringify({ ok: true }));
}
// ── срок подписки Pro ──
function proDays(tariff) { return tariff === 'quarter' ? 90 : 30; }
// продление: если Pro ещё активен — дни добавляются к текущему концу, иначе от сегодня
function grantPro(u, days) {
  const now = new Date();
  const base = (u.plan === 'pro' && u.proUntil && new Date(u.proUntil) > now) ? new Date(u.proUntil) : now;
  u.plan = 'pro';
  u.proUntil = new Date(base.getTime() + days * 86400e3).toISOString();
}
// эффективный план: ленивый даунгрейд по истечении срока (без proUntil — бессрочный)
function planOf(u) {
  if (u.plan === 'pro' && u.proUntil && new Date(u.proUntil) < new Date()) {
    u.plan = 'free'; delete u.proUntil; saveUsers();
  }
  return u.plan || 'free';
}

// ручная выдача Pro (пароль — тот же STATS_TOKEN)
function handleAdminPlan(req, res) {
  const token = process.env.STATS_TOKEN;
  const url = new URL(req.url, 'http://x');
  if (!token || (url.searchParams.get('token') || '') !== token)
    return send(res, 401, 'application/json', JSON.stringify({ error: 'неверный пароль' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const email = String(body.email || '').trim().toLowerCase();
    const plan = body.plan === 'pro' ? 'pro' : 'free';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'некорректный email' }));
    // аккаунта может ещё не быть (выдача Pro по заявке) — создаём заранее, план подхватится при первом входе
    if (!users[email]) users[email] = { plan: 'free', createdAt: new Date().toISOString(), searches: 0, contacts: 0 };
    const wasPro = planOf(users[email]) === 'pro';
    const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));
    if (plan === 'pro') grantPro(users[email], days);
    else { users[email].plan = 'free'; delete users[email].proUntil; }
    saveUsers();
    // автоуведомление при включении Pro (не при снятии; при продлении — тоже молча)
    if (plan === 'pro' && !wasPro) {
      const cab = baseUrl(req) + '/cabinet';
      sendEmail(email, 'Peleng Pro включён',
        '<div style="font-family:monospace;background:#12100A;color:#EDE6D4;padding:32px;border-radius:12px">' +
        '<div style="color:#F2A93B;font-size:18px;font-weight:bold;margin-bottom:14px">PELENG</div>' +
        '<p>Тебе включён <b style="color:#FFC96B">Pro-доступ</b> на ' + days + ' дн. — автопроверка выдачи, раскрытие контактов и AI-инструменты.</p>' +
        '<p><a href="' + cab + '" style="display:inline-block;background:#F2A93B;color:#1A1508;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Войти в кабинет</a></p>' +
        '<p style="color:#9A9077;font-size:12px">Вход без пароля: введи эту почту на странице кабинета — придёт ссылка.</p></div>'
      ).then(() => console.log('pro email sent:', email))
       .catch(e => console.error('pro email failed:', email, e.message));
    }
    send(res, 200, 'application/json', JSON.stringify({ ok: true, email, plan, proUntil: users[email].proUntil || null, mail: plan === 'pro' && !wasPro ? 'queued' : 'no' }));
  });
}

// ── сбор email-заявок (историческое: форма раннего доступа убрана, endpoint оставлен) ──
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

// ── обратная связь: форма «написать в поддержку» → файл + TG ──
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.join(__dirname, 'data', 'feedback.jsonl');
const fbHits = new Map();
function handleFeedback(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(fbHits, ip, 10)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — попробуй позже' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const text = String(body.text || '').trim().slice(0, 2000);
    if (text.length < 5) return send(res, 400, 'application/json', JSON.stringify({ error: 'напиши хотя бы пару слов' }));
    const sess = getUser(req);
    const email = (sess && sess.email) || String(body.email || '').trim().toLowerCase().slice(0, 120);
    const rec = JSON.stringify({ text, email, at: new Date().toISOString() });
    try {
      fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
      fs.appendFileSync(FEEDBACK_FILE, rec + '\n');
    } catch (e) { console.error('feedback write failed:', e.message); }
    const tk = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (tk && chat) {
      fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat,
          text: '💬 Peleng: обратная связь\n' + (email ? 'от: ' + email + '\n' : '') + '\n' + text }),
      }).catch(() => {});
    }
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}

// ── анонимный счётчик поисков по дням (без текста запросов) ──
const HITS_FILE = process.env.HITS_FILE || path.join(__dirname, 'data', 'hits.json');
let dailyHits = {};
try { dailyHits = JSON.parse(fs.readFileSync(HITS_FILE, 'utf8')) || {}; } catch {}
let hitsDirty = false;
function flushHits() {
  if (!hitsDirty) return;
  hitsDirty = false;
  try { fs.mkdirSync(path.dirname(HITS_FILE), { recursive: true }); fs.writeFileSync(HITS_FILE, JSON.stringify(dailyHits)); }
  catch (e) { console.error('hits write failed:', e.message); }
}
setInterval(flushHits, 30000).unref && setInterval(flushHits, 30000).unref();
function handleHit(req, res) {
  // дата по МСК (UTC+3), без внешних данных
  const d = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  dailyHits[d] = (dailyHits[d] || 0) + 1;
  hitsDirty = true;
  const s = getUser(req);
  if (s) { s.u.searches = (s.u.searches || 0) + 1; saveUsers(); }
  res.writeHead(204); res.end();
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
  // воронка по партнёрам: заявки → аккаунты → заявки на оплату
  const refKey = v => (v && String(v).trim()) || '(прямые)';
  const funnel = {}; // ref → {leads, users, pays}
  const row = k => (funnel[k] = funnel[k] || { leads: 0, users: 0, pays: 0 });
  for (const r of rows) row(refKey(r.ref)).leads++;
  for (const u of Object.values(users)) row(refKey(u.ref)).users++;
  let payRows = [];
  try {
    payRows = fs.readFileSync(PAY_FILE, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}
  const paidEmails = new Set();
  for (const p of payRows) {
    if (paidEmails.has(p.email)) continue; // один человек — один шаг воронки
    paidEmails.add(p.email);
    row(refKey(users[p.email] && users[p.email].ref)).pays++;
  }
  const partners = Object.entries(funnel)
    .map(([ref, f]) => ({ ref, count: f.leads, users: f.users, pays: f.pays }))
    .sort((a, b) => (b.count + b.users) - (a.count + a.users));
  const recent = rows.slice(-100).reverse();
  // поиски за последние 14 дней
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() + 3 * 3600e3 - i * 86400e3).toISOString().slice(0, 10);
    days.push({ date: d, count: dailyHits[d] || 0 });
  }
  const searchesTotal = Object.values(dailyHits).reduce((a, b) => a + b, 0);
  const userList = Object.entries(users)
    .map(([email, u]) => ({ email, plan: planOf(u), proUntil: u.proUntil || null, searches: u.searches || 0, contacts: u.contacts || 0, createdAt: u.createdAt || '', ref: u.ref || '' }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 200);
  send(res, 200, 'application/json', JSON.stringify({ total: rows.length, partners, recent, days, searchesTotal, users: userList }));
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
  // пробив — фича за аккаунтом: жжёт кредиты SignalHire
  const sess = getUser(req);
  if (!sess) return send(res, 401, 'application/json', JSON.stringify({ error: 'auth' }));
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
      sess.u.contacts = (sess.u.contacts || 0) + 1; saveUsers();
      send(res, 200, 'application/json', JSON.stringify(data));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

// ── промокоды: env PROMOS="КОД:50,КОД2:80,КОД3:100" (скидка в %; 100 — активирует Pro сразу) ──
function promoDiscount(code) {
  if (!code) return 0;
  const map = {};
  String(process.env.PROMOS || '').split(',').forEach(p => {
    const [c, d] = p.split(':');
    if (c && d) map[c.trim().toUpperCase()] = Math.min(100, Math.max(0, parseInt(d, 10) || 0));
  });
  return map[String(code).trim().toUpperCase()] || 0;
}
function handlePromo(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const d = promoDiscount(body.code);
    if (!d) return send(res, 404, 'application/json', JSON.stringify({ error: 'неверный промокод' }));
    send(res, 200, 'application/json', JSON.stringify({ discount: d }));
  });
}

// ── заявка на оплату Pro (платёжка не подключена — пишем интент и шлём в TG) ──
const PAY_FILE = process.env.PAY_FILE || path.join(__dirname, 'data', 'pay.jsonl');
function handleProIntent(req, res) {
  const sess = getUser(req);
  if (!sess) return send(res, 401, 'application/json', JSON.stringify({ error: 'auth' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const tariff = String(body.tariff || 'month').slice(0, 20);
    const bref = String(body.ref || '').slice(0, 60).trim();
    if (bref && !sess.u.ref) { sess.u.ref = bref; saveUsers(); } // метка могла прийти позже регистрации
    const promo = String(body.promo || '').trim().toUpperCase().slice(0, 30);
    const discount = promoDiscount(promo);
    const activated = discount === 100;
    if (activated) { grantPro(sess.u, proDays(tariff)); saveUsers(); }
    const rec = JSON.stringify({ email: sess.email, tariff, ref: sess.u.ref || '',
      promo: discount ? promo : '', discount, activated, at: new Date().toISOString() });
    try {
      fs.mkdirSync(path.dirname(PAY_FILE), { recursive: true });
      fs.appendFileSync(PAY_FILE, rec + '\n');
    } catch (e) { console.error('pay intent write failed:', e.message); }
    const tk = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (tk && chat) {
      const text = activated
        ? '🎁 Peleng: Pro активирован по промокоду ' + promo + '\n' + sess.email + (sess.u.ref ? '\nпартнёр: ' + sess.u.ref : '')
        : '💳 Peleng: хочет оплатить Pro\n' + sess.email + '\nтариф: ' + tariff +
          (discount ? '\nпромокод: ' + promo + ' (−' + discount + '%)' : '') +
          (sess.u.ref ? '\nпартнёр: ' + sess.u.ref : '') + '\n→ выдай Pro в /stats';
      fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text }),
      }).catch(() => {});
    }
    if (activated) {
      const cab = baseUrl(req) + '/cabinet';
      sendEmail(sess.email, 'Peleng Pro включён',
        '<div style="font-family:monospace;background:#12100A;color:#EDE6D4;padding:32px;border-radius:12px">' +
        '<div style="color:#F2A93B;font-size:18px;font-weight:bold;margin-bottom:14px">PELENG</div>' +
        '<p>Промокод сработал — тебе включён <b style="color:#FFC96B">Pro</b> на ' + proDays(tariff) + ' дн.: автопроверка выдачи, раскрытие контактов и AI-инструменты.</p>' +
        '<p><a href="' + cab + '" style="display:inline-block;background:#F2A93B;color:#1A1508;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Открыть кабинет</a></p></div>'
      ).catch(e => console.error('promo email failed:', e.message));
    }
    console.log('pro intent:', sess.email, tariff, promo || '-', discount);
    send(res, 200, 'application/json', JSON.stringify({ ok: true, activated, discount }));
  });
}

const STATS_PAGE = path.join(__dirname, 'stats.html');

const server = http.createServer((req, res) => {
  // переезд: старый домен и www → https://peleng.fun (постоянный редирект)
  const rhost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (rhost === 'x-raya.space' || rhost === 'www.x-raya.space' || rhost === 'www.peleng.fun') {
    res.writeHead(301, { location: 'https://peleng.fun' + req.url });
    return res.end();
  }
  if (req.method === 'POST' && req.url === '/api/ai') return handleAI(req, res);
  if (req.method === 'POST' && req.url === '/api/lead') return handleLead(req, res);
  if (req.method === 'POST' && req.url === '/api/nick') return handleNick(req, res);
  if (req.method === 'POST' && req.url === '/api/count') return handleCount(req, res);
  if (req.method === 'POST' && req.url === '/api/contact') return handleContact(req, res);
  if (req.method === 'POST' && req.url === '/api/hit') return handleHit(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/request') return handleAuthRequest(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/code') return handleAuthCode(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/password') return handleAuthPassword(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/setpw') return handleSetPassword(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/auth') return handleAuthGo(req, res);
  if (req.method === 'GET' && req.url === '/api/me') return handleMe(req, res);
  if (req.method === 'POST' && req.url === '/api/logout') return handleLogout(req, res);
  if (req.method === 'POST' && req.url === '/api/pro/intent') return handleProIntent(req, res);
  if (req.method === 'POST' && req.url === '/api/promo') return handlePromo(req, res);
  if (req.method === 'POST' && req.url === '/api/feedback') return handleFeedback(req, res);
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/admin/plan') return handleAdminPlan(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/help') {
    return fs.readFile(path.join(__dirname, 'help.html'), (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'help.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/cabinet') {
    return fs.readFile(path.join(__dirname, 'cabinet.html'), (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'cabinet.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
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
