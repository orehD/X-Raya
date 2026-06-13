# Self-hosted деплой: Beget VPS + Coolify + свой домен + SSL + авто-деплой

Этот вариант — вместо Vercel. Сайт живёт на твоём сервере, на твоём (под)домене, с
авто-обновлением при `git push`. Ключ Anthropic хранится в Coolify как секрет.

Стек подходит. Единственное отличие от Vercel: вместо serverless-функции используется
маленький Node-сервер `server.js` (уже в проекте) — он отдаёт `index.html` и держит `/api/ai`.

---

## Что нужно заранее
- **Beget VPS** (именно VPS, не «виртуальный хостинг»!) с Ubuntu 22.04+, root-доступ по SSH,
  минимум 2 ГБ RAM (Coolify + Docker). У обычного shared-хостинга Docker нет — не подойдёт.
- **Домен** (на Beget или где угодно), где можешь редактировать DNS.
- Ключ Anthropic `sk-ant-...` (см. Часть 0 в DEPLOY.md).
- Репозиторий с проектом на GitHub (см. Часть 1 в DEPLOY.md) — в нём должны быть
  `index.html`, `server.js`, `package.json`, `Dockerfile`.

---

## Шаг 1. Заказать VPS и получить доступ
1. В панели Beget закажи **VPS** с Ubuntu 22.04/24.04.
2. Получишь **IP-адрес** и пароль (или загрузишь свой SSH-ключ).
3. Проверь вход с Mac (Терминал): `ssh root@IP_АДРЕС` → введи пароль.

## Шаг 2. Направить поддомен на сервер (DNS)
1. У регистратора домена / в DNS Beget добавь запись:
   - Тип **A**, имя `xraya` (получится `xraya.твойдомен.ru`), значение — **IP VPS**, TTL минимальный.
2. Подожди распространения DNS (от пары минут до часа). Проверка: `ping xraya.твойдомен.ru`
   должен отвечать с твоего IP.

## Шаг 3. Установить Coolify на VPS
1. По SSH на сервере выполни (официальный установщик):
   ```bash
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
   ```
2. После установки открой в браузере `http://IP_АДРЕС:8000` → создай админ-аккаунт Coolify.

## Шаг 4. Подключить GitHub (это и даёт авто-деплой вебхуками)
1. В Coolify: **Sources → GitHub → Connect / Create GitHub App** → следуй мастеру,
   установи приложение на свой аккаунт и дай доступ к репозиторию `x-raya`.
   - GitHub App автоматически повесит **webhook** — пуши будут авто-деплоиться.
2. (Альтернатива для приватного репо без App) Coolify покажет **deploy key** (публичный SSH-ключ) →
   добавь его в GitHub: репозиторий → **Settings → Deploy keys → Add deploy key** (read-only),
   а webhook добавь вручную: Coolify даст URL → GitHub **Settings → Webhooks → Add webhook**.

## Шаг 5. Создать приложение
1. Coolify → **Projects → New → Application** → выбери свой GitHub-репозиторий и ветку `main`.
2. **Build Pack:** Coolify увидит `Dockerfile` → выбери его (или Nixpacks — тогда сработает
   `package.json` со `start`). Порт приложения — **3000**.
3. **Environment Variables** → добавь:
   - `OPENROUTER_API_KEY` = `sk-or-...` (твой ключ OpenRouter)
   - (необязательно) `AI_MODEL` = `openai/gpt-4o-mini` (или другая модель OpenRouter,
     например `anthropic/claude-3.5-haiku`, `google/gemini-flash-1.5`)
4. **Domains** → впиши `https://xraya.твойдомен.ru`.
   Coolify сам выпустит **Let's Encrypt SSL** (нужно, чтобы DNS из шага 2 уже указывал на сервер).
5. Нажми **Deploy**.

## Шаг 6. Проверить
- Открой `https://xraya.твойдомен.ru` (с замочком 🔒).
- Запрос → **Найти**, кнопки **шире/уже/по-другому** и галочка **AI-интерпретация** работают
  (это уже идёт через `server.js` → Anthropic с серверным ключом).

## Авто-обновление
После настройки GitHub App любой `git push` (или правка файла на GitHub → Commit) →
Coolify ловит webhook и пересобирает контейнер сам. Можно и вручную: в приложении кнопка **Redeploy**.

---

## Частые проблемы
- **SSL не выпускается** — DNS ещё не указывает на сервер, либо закрыты порты 80/443. Проверь A-запись
  и что в файрволе/Beget открыты 80, 443 (и 8000 для панели).
- **502 / AI не отвечает** — не задан `ANTHROPIC_API_KEY` или пуст баланс Anthropic.
- **«no Dockerfile / build failed»** — убедись, что `Dockerfile`, `server.js`, `package.json`,
  `index.html` залиты в репозиторий в корень.
- Файл `api/ai.js` нужен только для Vercel — на self-host он не используется, можно оставить.
