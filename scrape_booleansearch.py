#!/usr/bin/env python3
"""
Полная выгрузка постов Telegram-канала @booleansearch в JSON.

Используется для сбора базы знаний (boolean-строки, X-Ray приёмы, новые площадки),
которой можно обогащать словари и источники сорсинг-агента.

ЧТО НУЖНО:
  1. Аккаунт Telegram (любой) и номер телефона для входа.
  2. api_id и api_hash — получить тут: https://my.telegram.org → API development tools.
  3. pip install telethon

ЗАПУСК:
  export TG_API_ID=12345678
  export TG_API_HASH=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  python3 scrape_booleansearch.py

При первом запуске Telegram пришлёт код подтверждения в приложение — введи его в консоль.
Результат: booleansearch_posts.json (все посты с текстом, датой, ссылками).
"""

import os, json, asyncio
from telethon import TelegramClient

API_ID   = int(os.environ.get("TG_API_ID", "0"))
API_HASH = os.environ.get("TG_API_HASH", "")
CHANNEL  = "booleansearch"          # @booleansearch
OUT      = "booleansearch_posts.json"

async def main():
    if not API_ID or not API_HASH:
        raise SystemExit("Задай TG_API_ID и TG_API_HASH (см. шапку файла).")
    async with TelegramClient("xraya_session", API_ID, API_HASH) as client:
        posts = []
        async for msg in client.iter_messages(CHANNEL):   # весь архив, от новых к старым
            if not msg.message:
                continue
            posts.append({
                "id": msg.id,
                "date": msg.date.isoformat(),
                "text": msg.message,
                "url": f"https://t.me/{CHANNEL}/{msg.id}",
                "views": getattr(msg, "views", None),
            })
        posts.reverse()  # хронологический порядок
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(posts, f, ensure_ascii=False, indent=2)
        print(f"Готово: {len(posts)} постов → {OUT}")

if __name__ == "__main__":
    asyncio.run(main())
