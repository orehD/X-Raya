// Пеленг (ex-X-Raya) self-hosted сервер (без зависимостей, Node 18+).
// Отдаёт index.html и держит POST /api/ai как прокси к OpenRouter (ключ — из env).
// Запуск: node server.js   (PORT по умолчанию 3000)
//
// Переменные окружения:
//   OPENROUTER_API_KEY — обязательно (ключ sk-or-... ; задаётся в Coolify, НЕ в коде)
//   AI_MODEL           — необязательно (по умолчанию openai/gpt-4o-mini)

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

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ai') return handleAI(req, res);
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
