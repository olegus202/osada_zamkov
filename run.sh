#!/bin/sh
# Осада Замков — запуск сервера (macOS / Linux)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите его с https://nodejs.org и повторите."
  exit 1
fi
echo "Запускаю сервер... Адреса для игроков появятся ниже."
node server.js
