import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.ts';
import { allowsGuild } from '../src/config-values.ts';

const validEnv = {
  DISCORD_TOKEN: 'test-token-never-used-for-network-requests',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_GUILD_ID: '987654321098765432',
};

test('vision defaults on, can be disabled for text models, and validates its environment setting', () => {
  const env = { ...validEnv, AI_API_KEY: 'test-key', AI_MODEL: 'test-model' };
  assert.equal(readConfig(env).ai?.vision, undefined);
  assert.equal(readConfig({ ...env, AI_VISION_ENABLED: 'true' }).ai?.vision, true);
  assert.equal(readConfig({ ...env, AI_VISION_ENABLED: 'false' }).ai?.vision, false);
  assert.throws(() => readConfig({ ...env, AI_VISION_ENABLED: 'maybe' }), /AI_VISION_ENABLED must be true or false/);
});

test('reads and trims configuration from the supplied environment', () => {
  assert.deepEqual(readConfig({
    DISCORD_TOKEN: ` ${validEnv.DISCORD_TOKEN} `,
    DISCORD_APPLICATION_ID: ` ${validEnv.DISCORD_APPLICATION_ID} `,
    DISCORD_GUILD_ID: ` ${validEnv.DISCORD_GUILD_ID} `,
  }), {
    token: validEnv.DISCORD_TOKEN,
    applicationId: validEnv.DISCORD_APPLICATION_ID,
    guildId: validEnv.DISCORD_GUILD_ID,
    guildIds: [validEnv.DISCORD_GUILD_ID],
    ai: null,
    web: null,
  });
});

test('reports all missing configuration in a single error', () => {
  assert.throws(() => readConfig({}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /DISCORD_TOKEN/);
    assert.match(error.message, /DISCORD_APPLICATION_ID/);
    assert.match(error.message, /\.env\.example/);
    return true;
  });
});

test('allows installed servers by default, preserves legacy restrictions, and supports an explicit server allowlist', () => {
  const other = '223456789012345678';
  const legacy = readConfig(validEnv);
  assert.equal(allowsGuild(legacy, validEnv.DISCORD_GUILD_ID), true);
  assert.equal(allowsGuild(legacy, other), false);
  const all = readConfig({ ...validEnv, DISCORD_GUILD_IDS: '*' });
  assert.equal(allowsGuild(all, other), true);
  assert.equal(allowsGuild(all, null), false);
  assert.equal(allowsGuild(all, 'not-a-server'), false);
  const fresh = readConfig({ DISCORD_TOKEN: validEnv.DISCORD_TOKEN, DISCORD_APPLICATION_ID: validEnv.DISCORD_APPLICATION_ID });
  assert.equal(fresh.guildIds, null);
  assert.equal(allowsGuild(fresh, other), true);
  const restricted = readConfig({ ...validEnv, DISCORD_GUILD_IDS: ` ${other}, ${other}, ${validEnv.DISCORD_GUILD_ID} ` });
  assert.deepEqual(restricted.guildIds, [other, validEnv.DISCORD_GUILD_ID]);
  assert.equal(allowsGuild(restricted, other), true);
  assert.equal(allowsGuild(restricted, '333456789012345678'), false);
  for (const value of ['*,123456789012345678', other + ',', '123', 'nope']) {
    assert.throws(() => readConfig({ ...validEnv, DISCORD_GUILD_IDS: value }), /DISCORD_GUILD_IDS/);
  }
});

test('rejects a blank token', () => {
  assert.throws(() => readConfig({ ...validEnv, DISCORD_TOKEN: '  ' }), /DISCORD_TOKEN/);
});

test('rejects malformed IDs without exposing their values or the token', () => {
  assert.throws(() => readConfig({
    ...validEnv,
    DISCORD_APPLICATION_ID: 'not-an-application-id',
    DISCORD_GUILD_ID: 'not-a-server-id',
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /DISCORD_APPLICATION_ID/);
    assert.match(error.message, /DISCORD_GUILD_ID/);
    assert.ok(!error.message.includes(validEnv.DISCORD_TOKEN));
    assert.ok(!error.message.includes('not-an-application-id'));
    assert.ok(!error.message.includes('not-a-server-id'));
    return true;
  });
});

test('rejects IDs that are truncated, too long, zero, or written in scientific notation', () => {
  for (const value of ['1234567890123456', '123456789012345678901', '000000000000000000', '1.2345678901234567e18']) {
    assert.throws(() => readConfig({ ...validEnv, DISCORD_GUILD_ID: value }), /DISCORD_GUILD_ID/);
  }
});

test('keeps 20-digit IDs as strings so precision is preserved', () => {
  const guildId = '12345678901234567890';
  assert.equal(readConfig({ ...validEnv, DISCORD_GUILD_ID: guildId }).guildId, guildId);
});

test('AI chat stays disabled without a key and requires an explicit model with a key', () => {
  assert.equal(readConfig({ ...validEnv, AI_API_KEY: '  ' }).ai, null);
  assert.throws(() => readConfig({ ...validEnv, AI_API_KEY: 'test-key' }), /AI_MODEL/);
});

test('reads a custom provider, model, output limit, and instruction without a fixed model', () => {
  const ai = readConfig({
    ...validEnv,
    AI_API_KEY: ' provider-key ',
    AI_MODEL: ' provider/arbitrary-model ',
    AI_BASE_URL: ' https://provider.example/api/v1/ ',
    AI_TOKEN_LIMIT_PARAM: 'max_tokens',
    AI_MAX_OUTPUT_TOKENS: '512',
    AI_SYSTEM_PROMPT: ' Answer in Indonesian. ',
    AI_HISTORY_FILE: '/tmp/custom-chats.json',
  }).ai;
  assert.deepEqual(ai, {
    apiKey: 'provider-key',
    model: 'provider/arbitrary-model',
    baseUrl: 'https://provider.example/api/v1',
    tokenLimitParam: 'max_tokens',
    maxOutputTokens: 512,
    systemPrompt: 'Answer in Indonesian.',
    historyFile: '/tmp/custom-chats.json',
  });
});

test('validates provider settings without including keys or URL credentials in errors', () => {
  for (const overrides of [
    { AI_BASE_URL: 'ftp://provider.example/v1' },
    { AI_BASE_URL: 'https://user:private-password@provider.example/v1' },
    { AI_BASE_URL: 'https://provider.example/v1?key=private-password' },
    { AI_BASE_URL: 'not a URL' },
    { AI_TOKEN_LIMIT_PARAM: 'unsupported' },
    { AI_MAX_OUTPUT_TOKENS: '0' },
    { AI_MAX_OUTPUT_TOKENS: '8193' },
    { AI_MAX_OUTPUT_TOKENS: 'NaN' },
    { AI_MAX_OUTPUT_TOKENS: '1.5' },
  ]) {
    assert.throws(() => readConfig({ ...validEnv, AI_API_KEY: 'private-key', AI_MODEL: 'test', ...overrides }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('private-key'));
      assert.ok(!error.message.includes('private-password'));
      return true;
    });
  }
});

test('lore tool calling can be disabled independently of automatic context and invalid settings fail clearly', () => {
  const env = { ...validEnv, AI_API_KEY: 'test-key', AI_MODEL: 'arbitrary-model' };
  assert.equal(readConfig({ ...env, AI_LORE_TOOLS: 'false' }).ai?.loreTools, false);
  assert.equal(readConfig({ ...env, AI_LORE_TOOLS: 'true' }).ai?.loreTools, true);
  assert.throws(() => readConfig({ ...env, AI_LORE_TOOLS: 'sometimes' }), /AI_LORE_TOOLS/);
});

test('loads an editable persona file as the provider system instructions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-persona-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'custom.md');
  await writeFile(file, '  A custom character.\n\nAnswer in Indonesian.\n');
  const ai = readConfig({ ...validEnv, AI_API_KEY: 'test-key', AI_MODEL: 'any-model', AI_PERSONA_FILE: file }).ai;
  assert.equal(ai?.systemPrompt, 'A custom character.\n\nAnswer in Indonesian.');
});

test('inline instructions take precedence even when the persona file is missing', () => {
  const ai = readConfig({
    ...validEnv, AI_API_KEY: 'test-key', AI_MODEL: 'any-model',
    AI_PERSONA_FILE: '/nonexistent/fourth-mirror/persona.md', AI_SYSTEM_PROMPT: ' Inline override. ',
  }).ai;
  assert.equal(ai?.systemPrompt, 'Inline override.');
});

test('fails clearly for missing or empty persona files, while disabled AI needs no file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-persona-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'character.md');
  const env = { ...validEnv, AI_API_KEY: 'test-key', AI_MODEL: 'any-model', AI_PERSONA_FILE: file };
  assert.throws(() => readConfig(env), /Could not read AI_PERSONA_FILE/);
  await writeFile(file, ' \n\t');
  assert.throws(() => readConfig(env), /AI_PERSONA_FILE must contain/);
  assert.equal(readConfig({ ...env, AI_API_KEY: '' }).ai, null);
});

test('web credentials are independent of the chat provider and optional reasoning settings are validated', () => {
  const config = readConfig({
    ...validEnv, AI_API_KEY: 'chat-key', AI_MODEL: 'other-provider-model', AI_REASONING_EFFORT: 'none',
    WEB_API_KEY: 'web-key', WEB_BASE_URL: 'https://search.example/tools/',
  });
  assert.equal(config.ai?.apiKey, 'chat-key');
  assert.equal(config.ai?.reasoningEffort, 'none');
  assert.deepEqual(config.web, { apiKey: 'web-key', baseUrl: 'https://search.example/tools' });
  assert.equal(readConfig({ ...validEnv, AI_API_KEY: 'chat-key', AI_MODEL: 'any' }).web, null);
  assert.throws(() => readConfig({ ...validEnv, WEB_API_KEY: 'web-key' }), /AI_API_KEY is required/);
  assert.throws(() => readConfig({ ...validEnv, AI_API_KEY: 'chat-key', AI_MODEL: 'any', AI_REASONING_EFFORT: 'invalid' }), /AI_REASONING_EFFORT/);
  assert.throws(() => readConfig({ ...validEnv, AI_API_KEY: 'chat-key', AI_MODEL: 'any', WEB_API_KEY: 'web-key', WEB_BASE_URL: 'https://user:secret@example.com' }), /WEB_BASE_URL/);
});
