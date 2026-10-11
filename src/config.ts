import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.mailly.site';

export interface Config {
  apiKey?: string;
  baseUrl?: string;
}

export function configDir() {
  return join(homedir(), '.mailly');
}

export function configPath() {
  return join(configDir(), 'config.json');
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Failed to read config file (${configPath()}): ${err.message}`);
    }
  }
  return {};
}

export async function writeConfig(config: Config): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}

export async function clearConfig(): Promise<boolean> {
  try {
    await fs.unlink(configPath());
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string;
  source: 'flag' | 'env' | 'config';
}

export async function resolveAuth(opts: {
  apiKey?: string;
  baseUrl?: string;
  required?: boolean;
}): Promise<ResolvedAuth> {
  const config = await readConfig();
  const baseUrl =
    opts.baseUrl ||
    process.env.MAILLY_BASE_URL ||
    config.baseUrl ||
    DEFAULT_BASE_URL;

  let apiKey: string | undefined;
  let source: ResolvedAuth['source'] = 'config';

  if (opts.apiKey) {
    apiKey = opts.apiKey;
    source = 'flag';
  } else if (process.env.MAILLY_API_KEY) {
    apiKey = process.env.MAILLY_API_KEY;
    source = 'env';
  } else if (config.apiKey) {
    apiKey = config.apiKey;
    source = 'config';
  }

  if (!apiKey && opts.required !== false) {
    throw new Error(
      'No API key found. Run `mailly login` (or `mailly login <api-key>`), set the MAILLY_API_KEY environment variable, or pass --api-key <key>.'
    );
  }

  return { apiKey: apiKey ?? '', baseUrl, source };
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '…' + key.slice(-4);
}
