import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { decryptHistory, encryptHistory } from '../scripts/backup.mjs';
import { isCurrentMain, validateCiDeployment } from '../scripts/ci.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const history = { version: 1, sessions: [{ threadId: '223456789012345678', ownerId: '423456789012345678', updatedAt: 1,
  history: [{ role: 'user', content: 'Synthetic private question.' }, { role: 'assistant', content: 'Synthetic private reply.' }] }] };
const sha = 'a'.repeat(40);

test('CI history backups round-trip without plaintext and reject tampering, wrong keys, and invalid history', () => {
  const first = encryptHistory(history, keys.publicKey), second = encryptHistory(history, keys.publicKey);
  assert.notEqual(first, second);
  assert.ok(!first.includes('Synthetic private question'));
  assert.deepEqual(decryptHistory(first, keys.privateKey), history);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  assert.throws(() => decryptHistory(first, other.privateKey), /Could not decrypt/);
  const changed = JSON.parse(first);
  const bytes = Buffer.from(changed.data, 'base64'); bytes[0] ^= 1; changed.data = bytes.toString('base64');
  assert.throws(() => decryptHistory(JSON.stringify(changed), keys.privateKey), /Could not decrypt/);
  assert.throws(() => encryptHistory({ version: 1, sessions: [{}] }, keys.publicKey), /Invalid chat history/);
});

function settings(overrides = {}) {
  return { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, CI_CHECKED_SHA: sha,
    GITHUB_REPOSITORY: 'owner/repository', GH_TOKEN: 'synthetic-read-token', CLOUDFLARE_API_TOKEN: 'synthetic-deploy-token',
    CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_WORKER_NAME: 'synthetic-bot', CLOUDFLARE_BOT_URL: 'https://synthetic-bot.example.workers.dev',
    ADMIN_TOKEN: 'synthetic-admin-token-not-a-real-secret', HISTORY_BACKUP_PUBLIC_KEY: keys.publicKey, CLOUDFLARE_BACKUP_DIR: '/synthetic/temporary/backups', ...overrides };
}

test('CI deployment requires a checked main commit, complete settings, and a usable backup key before touching the bot', () => {
  assert.doesNotThrow(() => validateCiDeployment(settings(), sha));
  assert.doesNotThrow(() => validateCiDeployment(settings({ GITHUB_EVENT_NAME: 'workflow_dispatch' }), sha));
  for (const overrides of [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { CI_CHECKED_SHA: 'c'.repeat(40) }, { GITHUB_SHA: 'd'.repeat(40) }, { CLOUDFLARE_API_TOKEN: '' },
    { HISTORY_BACKUP_PUBLIC_KEY: 'invalid' }, { CLOUDFLARE_ACCOUNT_ID: 'not an account ID' },
    { CLOUDFLARE_BOT_URL: 'http://synthetic-bot.example.workers.dev' }, { CLOUDFLARE_WORKER_NAME: 'different-bot' },
  ]) assert.throws(() => validateCiDeployment(settings(overrides), sha));
});

test('CI skips outdated main commits and fails closed if the current main cannot be verified', async () => {
  const env = settings();
  assert.equal(await isCurrentMain(env, async repository => { assert.equal(repository, env.GITHUB_REPOSITORY); return sha; }), true);
  assert.equal(await isCurrentMain(env, async () => 'e'.repeat(40)), false);
  await assert.rejects(isCurrentMain(env, async () => ''), /Could not verify/);
  await assert.rejects(isCurrentMain(settings({ GITHUB_REPOSITORY: '../other' }), async () => sha), /Invalid GitHub/);
});
