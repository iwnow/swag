// Баннер запуска: версия Node, версия агента и признак готовности процесса.
export function runAgent(version: string, print: (line: string) => void): void {
  print(`node ${process.version}`);
  print(`agent ${version}`);
  print('agent ok');
}
