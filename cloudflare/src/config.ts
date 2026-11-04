import { parseConfig } from '../../src/config-values.ts';
import type { Config, ConfigEnvironment } from '../../src/config-values.ts';
import persona from '../../personas/fourth-mirror.md';

export interface Env extends Record<string, unknown> {
  BOT: DurableObjectNamespace;
  ADMIN_TOKEN: string;
}

export function workerConfig(env: Env): Config {
  const values = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) as ConfigEnvironment;
  if (typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.trim().length < 32) {
    throw new Error('ADMIN_TOKEN must contain at least 32 characters.');
  }
  if (values.AI_PERSONA_FILE?.trim()) throw new Error('Workers bundles personas/fourth-mirror.md; use AI_SYSTEM_PROMPT for an override.');
  const config = parseConfig(values, () => values.AI_SYSTEM_PROMPT?.trim() || persona.trim());
  for (const endpoint of [config.ai?.baseUrl, config.web?.baseUrl]) {
    if (endpoint && new URL(endpoint).protocol !== 'https:') throw new Error('Workers provider endpoints must use HTTPS.');
  }
  return config;
}
