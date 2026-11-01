#!/bin/sh
# `ng serve` в контейнерах UI: до трёх попыток — node изредка падает с SIGSEGV при сборке federation-артефактов (спека 014, журнал).
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 143' TERM INT
for attempt in 1 2 3; do
  npm run start &
  pid=$!
  wait "$pid" && exit 0
  echo "ng serve упал, попытка $attempt из 3" >&2
done
echo 'ng serve не запустился за 3 попытки' >&2
exit 1
