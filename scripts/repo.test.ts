import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { readCatalog } from '../apps/llm-gateway/src/catalog.ts';

const root = new URL('..', import.meta.url);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

const profiles = ['test', 'dev', 'prod'];
const profileFile = (profile: string, name: string) =>
  fileURLToPath(new URL(`infra/llm/${profile}/${name}`, root));
const catalogIds = (profile: string) =>
  readCatalog(profileFile(profile, 'models.json')).models.map((model) => model.id);

interface LiteLlmConfig {
  model_list: { model_name: string; litellm_params: { api_key?: unknown } }[];
  general_settings?: { master_key?: unknown };
}
const liteLlmText = (profile: string) => readFileSync(profileFile(profile, 'litellm.yaml'), 'utf8');
const liteLlmConfig = (profile: string) => parse(liteLlmText(profile)) as LiteLlmConfig;

interface ComposeService {
  ports?: string[];
  networks?: string[];
  env_file?: string | string[];
}
type ComposeServiceName =
  'api' | 'orchestrator' | 'ui' | 'agent' | 'litellm' | 'llm-fake' | 'llm-gateway';
interface ComposeFile {
  services: Record<ComposeServiceName, ComposeService>;
}

describe('политики репозитория', () => {
  it('AC-000-9: у каждого package.json private: true и лицензия SEE LICENSE IN LICENSE', () => {
    const files = git('ls-files', '--cached', '--others', '--exclude-standard', '**package.json');
    expect(files).toContain('package.json');
    expect(files).toContain('apps/api/package.json');
    for (const file of files) {
      const pkg = JSON.parse(readFileSync(new URL(file, root), 'utf8')) as Record<string, unknown>;
      expect({ file, private: pkg.private, license: pkg.license }).toEqual({
        file,
        private: true,
        license: 'SEE LICENSE IN LICENSE',
      });
    }
  });

  it('AC-000-10: .env в .gitignore и не отслеживается git', () => {
    const ignored = readFileSync(new URL('.gitignore', root), 'utf8').split('\n');
    expect(ignored).toContain('.env');
    expect(git('ls-files', '--', '.env')).toEqual([]);
    expect(git('check-ignore', '.env')).toEqual(['.env']);
  });

  it('AC-002-8: каталоги infra/llm/*/models.json проходят ту же проверку ModelCatalog, что при старте', () => {
    for (const profile of profiles) {
      expect(() => readCatalog(profileFile(profile, 'models.json')), profile).not.toThrow();
    }
  });

  it('AC-002-19: наборы id models.json трёх профилей равны', () => {
    const [first, ...rest] = profiles.map((profile) => [...catalogIds(profile)].sort());
    for (const ids of rest) expect(ids).toEqual(first);
  });

  it('AC-002-19: каждый id каталога есть как model_name в litellm.yaml своего профиля', () => {
    for (const profile of profiles) {
      const names = liteLlmConfig(profile).model_list.map((entry) => entry.model_name);
      expect(names, profile).toEqual(expect.arrayContaining(catalogIds(profile)));
    }
  });

  it('AC-002-19: api_key и master_key в litellm.yaml — только ссылки os.environ/…', () => {
    for (const profile of profiles) {
      const config = liteLlmConfig(profile);
      const refs = [
        ...config.model_list.map((entry) => entry.litellm_params.api_key),
        config.general_settings?.master_key,
      ];
      const literals = refs.filter(
        (ref) => typeof ref !== 'string' || !ref.startsWith('os.environ/'),
      );
      expect(literals, profile).toEqual([]);
    }
  });

  it('REQ-002-5: litellm и llm-fake не публикуют порты и не входят в сеть default; llm-gateway публикует только на 127.0.0.1', () => {
    const services = (parse(readFileSync(new URL('compose.yaml', root), 'utf8')) as ComposeFile)
      .services;
    expect(services.litellm.ports, 'litellm').toBeUndefined();
    expect(services.litellm.networks, 'litellm').toEqual(['llm']);
    expect(services['llm-fake'].ports, 'llm-fake').toBeUndefined();
    expect(services['llm-fake'].networks, 'llm-fake').toEqual(['llm']);
    expect(services['llm-gateway'].networks, 'llm-gateway').toEqual(['default', 'llm']);
    for (const port of services['llm-gateway'].ports ?? []) {
      expect(port, 'llm-gateway').toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('REQ-002-5: .env.llm с ключами провайдеров только у litellm и llm-gateway', () => {
    const services = (parse(readFileSync(new URL('compose.yaml', root), 'utf8')) as ComposeFile)
      .services;
    const withKeys = Object.entries(services)
      .filter(([, service]) => [service.env_file ?? []].flat().includes('.env.llm'))
      .map(([name]) => name)
      .sort();
    expect(withKeys).toEqual(['litellm', 'llm-gateway']);
  });

  it('AC-002-19: database_url в litellm.yaml нет', () => {
    for (const profile of profiles) {
      expect(liteLlmText(profile), profile).not.toContain('database_url');
    }
  });
});
