/**
 * Peleng AI relay — Cloudflare Worker.
 *
 * Зачем: сервер Peleng на Beget (RU IP) OpenRouter блокирует («Access denied by security policy»).
 * Этот воркер крутится на IP Cloudflare (не RU), держит ключ OpenRouter в секретах и проксирует запрос.
 * Поток: браузер → /api/ai (Peleng, Beget) → этот воркер (Cloudflare) → OpenRouter.
 *
 * Приём: POST JSON { system, user, model } → ответ { text } | { error }.
 *
 * ── Деплой (вариант через дашборд, без установки инструментов) ──
 * 1. dash.cloudflare.com → Workers & Pages → Create → Create Worker → назови peleng-ai → Deploy.
 * 2. Edit code → вставь весь этот файл → Deploy.
 * 3. Settings → Variables and Secrets → добавь секреты:
 *      OPENROUTER_API_KEY = новый ключ с openrouter.ai (старый скомпрометирован — не используй)
 *      RELAY_SECRET       = придумай длинную случайную строку (та же пойдёт в Coolify)
 * 4. Скопируй адрес воркера (вида https://peleng-ai.<твой-сабдомен>.workers.dev).
 * 5. В Coolify (приложение Peleng) → Environment Variables:
 *      AI_RELAY_URL = адрес воркера из п.4
 *      RELAY_SECRET = та же строка, что в п.3
 *    → Redeploy.
 *
 * ── Деплой через wrangler (если ставил npm) ──
 *   npx wrangler deploy relay-worker.js --name peleng-ai
 *   npx wrangler secret put OPENROUTER_API_KEY
 *   npx wrangler secret put RELAY_SECRET
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }
    // защита от чужого использования (если задан секрет)
    if (env.RELAY_SECRET && request.headers.get('x-relay-auth') !== env.RELAY_SECRET) {
      return json({ error: 'forbidden' }, 403);
    }
    if (!env.OPENROUTER_API_KEY) {
      return json({ error: 'OPENROUTER_API_KEY не задан в секретах воркера' }, 500);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const system = String(body.system || '');
    const user = String(body.user || '');
    const model = String(body.model || 'openai/gpt-4o-mini');
    if (!user) return json({ error: 'нет поля user' }, 400);

    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
          'X-Title': 'Peleng',
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      const d = await r.json();
      if (!r.ok) return json({ error: (d.error && (d.error.message || d.error)) || 'upstream error' }, 502);
      const text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
      return json({ text });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
