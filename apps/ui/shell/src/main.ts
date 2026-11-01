import { initFederation } from '@angular-architects/native-federation';

// Спека 014, 4.4: без remote — ни одного запроса к remoteEntry.json на старте.
// Загрузка приложения идёт после initFederation: общие модули уже в import map.
initFederation({})
  .catch((error: unknown) => console.error(error))
  .then(() => import('./bootstrap.ts'))
  .catch((error: unknown) => console.error(error));
