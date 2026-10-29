import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.ts';

const validEnv = {
  DISCORD_TOKEN: 'test-token-never-used-for-network-requests',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_GUILD_ID: '987654321098765432',
};

test('reads and trims configuration from the supplied environment', () => {
  assert.deepEqual(readConfig({
    DISCORD_TOKEN: ` ${validEnv.DISCORD_TOKEN} `,
    DISCORD_APPLICATION_ID: ` ${validEnv.DISCORD_APPLICATION_ID} `,
    DISCORD_GUILD_ID: ` ${validEnv.DISCORD_GUILD_ID} `,
  }), {
    token: validEnv.DISCORD_TOKEN,
    applicationId: validEnv.DISCORD_APPLICATION_ID,
    guildId: validEnv.DISCORD_GUILD_ID,
    ai: null,
  });
});

test('reports all missing configuration in a single error', () => {
  assert.throws(() => readConfig({}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /DISCORD_TOKEN/);
    assert.match(error.message, /DISCORD_APPLICATION_ID/);
    assert.match(error.message, /DISCORD_GUILD_ID/);
    assert.match(error.message, /\.env\.example/);
    return true;
  });
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
