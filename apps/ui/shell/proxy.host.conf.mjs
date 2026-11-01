// Спека 014, 4.9: прокси каркаса при запуске на хосте (`npm run ui:dev`, конфигурация `host` в angular.json).
// Адреса берутся из env на момент импорта; переменная не задана — ошибка с её именем, порт не подставляется молча.
const target = (name) => {
  const port = process.env[name];
  if (!port) throw new Error(`Переменная ${name} не задана: см. .env.example`);
  return `http://127.0.0.1:${port}`;
};

const remotes = ['cabinet', 'admin', 'supervisor'];

export default {
  '/api': {
    target: target('API_PORT'),
    secure: false,
    ws: true,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
  },
  '/auth': {
    target: target('IDENTITY_PORT'),
    secure: false,
    changeOrigin: true,
  },
  '/grafana': {
    target: target('GRAFANA_PORT'),
    secure: false,
    ws: true,
    changeOrigin: true,
  },
  ...Object.fromEntries(
    remotes.map((name) => [
      `/mf/${name}`,
      { target: target(`UI_${name.toUpperCase()}_PORT`), secure: false, changeOrigin: false },
    ]),
  ),
};
