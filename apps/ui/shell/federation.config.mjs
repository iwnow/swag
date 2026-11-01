import {
  withNativeFederation,
  shareAll,
  mappingsFromWorkspace,
  NG_SKIP_LIST,
} from '@angular-architects/native-federation/config';

// Workspace-пакеты @swag/* попадают в общие зависимости только через sharedMappings
// (сборка с компилятором Angular); из npm-обхода shareAll они исключены.
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
  name: 'shell',

  shared: shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' }, { skipList }),

  sharedMappings: mappingsFromWorkspace({ singleton: true, strictVersion: true })
    .filter(['@swag/ui-angular', '@swag/ui-core', '@swag/contracts'])
    .get(),

  features: { ignoreUnusedDeps: false },
});
