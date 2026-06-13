// Серверless-прокси для X-Raya AI (Vercel). Хранит ключ на сервере (env), фронт зовёт без ключа.
// Эндпоинт: /api/ai. Переменные окружения:
//   OPENROUTER_API_KEY — обязательно (ключ sk-or-... ; задаётся в настройках Vercel, НЕ в коде)
//   AI_MODEL — необязательно (по умолчанию openai/gpt-4o-mini)
//   ALLOW_ORIGIN — необязательно (CORS, по умолчанию '*')

export default async function handler(req, res) {
  const origin = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENROUTER_API_KEY не задан на сервере' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const system = (body && body.system) || '';
  const user = (body && body.user) || '';
  if (!user) { res.status(400).json({ error: 'нет поля user' }); return; }

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + key,
        'X-Title': 'X-Raya',
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'openai/gpt-4o-mini',
        temperature: 0.4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const d = await r.json();
    if (!r.ok) { res.status(502).json({ error: (d.error && (d.error.message || d.error)) || 'upstream error' }); return; }
    const text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
