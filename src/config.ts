export interface AiConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly maxOutputTokens: number;
  readonly tokenLimitParam: 'max_completion_tokens' | 'max_tokens';
  readonly historyFile: string;
}

export interface Config {
  readonly token: string;
  readonly applicationId: string;
  readonly guildId: string;
  readonly ai: AiConfig | null;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const token = env.DISCORD_TOKEN?.trim() ?? '';
  const applicationId = env.DISCORD_APPLICATION_ID?.trim() ?? '';
  const guildId = env.DISCORD_GUILD_ID?.trim() ?? '';
  const ai = readAiConfig(env, problems);

  if (!token) problems.push('DISCORD_TOKEN is required.');

  for (const [name, value] of [
    ['DISCORD_APPLICATION_ID', applicationId],
    ['DISCORD_GUILD_ID', guildId],
  ]) {
    if (!value || !/^[1-9]\d{16,19}$/.test(value)) {
      problems.push(`${name} must be a Discord ID (17–20 digits).`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.join('\n')}\nCopy .env.example to .env and fill in the values.`);
  }

  return { token, applicationId, guildId, ai };
}

function readAiConfig(env: NodeJS.ProcessEnv, problems: string[]): AiConfig | null {
  const apiKey = env.AI_API_KEY?.trim() ?? '';
  // Keep the basic bot usable before an AI provider is configured.
  if (!apiKey) return null;

  const model = env.AI_MODEL?.trim() ?? '';
  const baseUrl = env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const tokenLimitParam = env.AI_TOKEN_LIMIT_PARAM?.trim() || 'max_completion_tokens';
  const outputTokens = env.AI_MAX_OUTPUT_TOKENS?.trim() || '2048';
  const maxOutputTokens = Number(outputTokens);

  if (!model) problems.push('AI_MODEL is required when AI_API_KEY is set.');

  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid provider URL');
    }
  } catch {
    problems.push('AI_BASE_URL must be an HTTP(S) API base URL without credentials, query parameters, or a fragment.');
  }

  if (!/^\d+$/.test(outputTokens) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192) {
    problems.push('AI_MAX_OUTPUT_TOKENS must be a whole number from 1 to 8192.');
  }
  if (tokenLimitParam !== 'max_completion_tokens' && tokenLimitParam !== 'max_tokens') {
    problems.push('AI_TOKEN_LIMIT_PARAM must be max_completion_tokens or max_tokens.');
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    systemPrompt: env.AI_SYSTEM_PROMPT?.trim() || 'You are fourth-mirror, a helpful conversational assistant in Discord. Be clear, friendly, and concise. You can discuss text but cannot browse the web, read attachments, run code, or perform actions. Do not claim to have done those things.',
    maxOutputTokens,
    tokenLimitParam: tokenLimitParam === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens',
    historyFile: env.AI_HISTORY_FILE?.trim() || 'data/chats.json',
  };
}
