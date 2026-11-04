import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cliError, project } from './common.mjs';

try {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const file = resolve(values.output || resolve(project, 'data/ci-backup-private.pem'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, keys.privateKey, { mode: 0o600, flag: 'wx' });
  await writeFile(file + '.pub', keys.publicKey, { mode: 0o600, flag: 'wx' });
  console.log('Created a private recovery key and its public key under ' + dirname(file) + '. Existing key files are never overwritten.');
} catch (error) { cliError(error); }
