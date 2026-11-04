import { readSystemPrompt } from './chat/persona.ts';
import { parseConfig } from './config-values.ts';
import type { Config } from './config-values.ts';
export type { AiConfig, WebConfig, Config } from './config-values.ts';

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try { return parseConfig(env, () => readSystemPrompt(env)); }
  catch (error) {
    throw new Error(`${error instanceof Error ? error.message : 'Invalid configuration.'}\nCopy .env.example to .env and fill in the values.`);
  }
}
