import {
  withNativeFederation,
  shareAll,
  mappingsFromWorkspace,
  NG_SKIP_LIST,
} from '@angular-architects/native-federation/config';

// Тот же конфиг, что у каркаса (спека 014, 4.5; журнал T-1). `@swag/*` — только через sharedMappings.
const skipList = [
  ...NG_SKIP_LIST,
  'rxjs/ajax',
  'rxjs/fetch',
  'rxjs/testing',
  'rxjs/webSocket',
  /^@angular\/(build|cli|compiler-cli)(\/|$)/,
  /^@angular\/cdk\/schematics(\/|$)/,
  /^@swag\//,
];

export default withNativeFederation({
  name: 'supervisor',
  exposes: { './routes': './src/app/app.routes.ts' },
  shared: shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' }, { skipList }),
  sharedMappings: mappingsFromWorkspace({ singleton: true, strictVersion: true })
    .filter(['@swag/ui-angular', '@swag/ui-core', '@swag/contracts'])
    .get(),
  features: { ignoreUnusedDeps: false },
});
