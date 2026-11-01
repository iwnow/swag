// Спека 014, 4.4: манифест remote того же origin. Сеть или HTTP-ошибка — исключение; разбор делает вызывающий.
export async function readFederationManifest(): Promise<unknown> {
  const response = await fetch('/federation.manifest.json');
  if (!response.ok) throw new Error(`manifest_http_${response.status}`);
  return response.json();
}
