export interface AiConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly maxOutputTokens: number;
  readonly tokenLimitParam: 'max_completion_tokens' | 'max_tokens';
  readonly historyFile: string;
  readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly loreTools?: boolean;
}

export interface WebConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

export interface Config {
  readonly token: string;
  readonly applicationId: string;
  /** Legacy single-server setting, also used to remove old guild commands. */
  readonly guildId?: string;
  /** null allows every installed server; omitted preserves legacy Config callers. */
  readonly guildIds?: readonly string[] | null;
  readonly ai: AiConfig | null;
  readonly web: WebConfig | null;
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export function parseConfig(env: ConfigEnvironment, loadPrompt: () => string): Config {
  const problems: string[] = [];
  const token = env.DISCORD_TOKEN?.trim() ?? '';
  const applicationId = env.DISCORD_APPLICATION_ID?.trim() ?? '';
  const guildId = env.DISCORD_GUILD_ID?.trim() ?? '';
  const servers = env.DISCORD_GUILD_IDS?.trim();
  const guildIds = servers === '*' ? null : servers
    ? [...new Set(servers.split(',').map(value => value.trim()))]
    : guildId ? [guildId] : null;
  const ai = readAiConfig(env, problems, loadPrompt);
  const web = readWebConfig(env, problems);
  if (web && !ai) problems.push('AI_API_KEY is required when WEB_API_KEY is set.');

  if (!token) problems.push('DISCORD_TOKEN is required.');

  for (const [name, value] of [
    ['DISCORD_APPLICATION_ID', applicationId],
    ...(guildId ? [['DISCORD_GUILD_ID', guildId]] : []),
  ]) {
    if (!value || !/^[1-9]\d{16,19}$/.test(value)) {
      problems.push(`${name} must be a Discord ID (17–20 digits).`);
    }
  }
  if (guildIds?.some(value => !/^[1-9]\d{16,19}$/.test(value))) {
    problems.push('DISCORD_GUILD_IDS must be * or a comma-separated list of Discord server IDs (17–20 digits).');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }

  return { token, applicationId, ...(guildId ? { guildId } : {}), guildIds, ai, web };
}

export function allowsGuild(config: Pick<Config, 'guildId' | 'guildIds'>, guildId: string | null | undefined): guildId is string {
  if (!guildId || !/^[1-9]\d{16,19}$/.test(guildId)) return false;
  const allowed = config.guildIds === undefined ? (config.guildId ? [config.guildId] : null) : config.guildIds;
  return allowed === null || allowed.includes(guildId);
}

function readAiConfig(env: ConfigEnvironment, problems: string[], loadPrompt: () => string): AiConfig | null {
  const apiKey = env.AI_API_KEY?.trim() ?? '';
  // Keep the basic bot usable before an AI provider is configured.
  if (!apiKey) return null;

  const model = env.AI_MODEL?.trim() ?? '';
  const baseUrl = env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const tokenLimitParam = env.AI_TOKEN_LIMIT_PARAM?.trim() || 'max_completion_tokens';
  const outputTokens = env.AI_MAX_OUTPUT_TOKENS?.trim() || '2048';
  const maxOutputTokens = Number(outputTokens);
  const reasoningEffort = env.AI_REASONING_EFFORT?.trim();
  const loreTools = env.AI_LORE_TOOLS?.trim();
  const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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
  const effort = reasoningEfforts.find(value => value === reasoningEffort);
  if (reasoningEffort && !effort) problems.push('AI_REASONING_EFFORT must be none, minimal, low, medium, high, xhigh, or max.');
  if (loreTools && !['true', 'false'].includes(loreTools)) problems.push('AI_LORE_TOOLS must be true or false.');

  let systemPrompt = '';
  try {
    systemPrompt = loadPrompt();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'Could not load the AI persona.');
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    systemPrompt,
    maxOutputTokens,
    tokenLimitParam: tokenLimitParam === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens',
    historyFile: env.AI_HISTORY_FILE?.trim() || 'data/chats.json',
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(loreTools ? { loreTools: loreTools === 'true' } : {}),
  };
}

function readWebConfig(env: ConfigEnvironment, problems: string[]): WebConfig | null {
  const apiKey = env.WEB_API_KEY?.trim() ?? '';
  if (!apiKey) return null;
  const baseUrl = env.WEB_BASE_URL?.trim() || 'https://api.deepseek.com/v1/tools';
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid web service URL');
    }
  } catch {
    problems.push('WEB_BASE_URL must be an HTTP(S) API base URL without credentials, query parameters, or a fragment.');
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, '') };
}
