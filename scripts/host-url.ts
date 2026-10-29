/** Адрес из сети compose → адрес на хосте: имя сервиса заменяется на 127.0.0.1, порт тот же. */
export function onHost(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  return parsed.toString();
}
