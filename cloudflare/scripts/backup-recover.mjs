import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decryptHistory } from './backup.mjs';
import { cliError, saveHistory } from './common.mjs';

try {
  const { values } = parseArgs({ options: { input: { type: 'string' }, key: { type: 'string' }, output: { type: 'string' } } });
  if (!values.input || !values.key || !values.output) throw new Error('Usage: node cloudflare/scripts/backup-recover.mjs --input BACKUP.enc --key PRIVATE.pem --output HISTORY.json');
  const data = decryptHistory(await readFile(values.input, 'utf8'), await readFile(values.key, 'utf8'));
  await saveHistory(values.output, data);
  console.log('Recovered a private history file. The output file was not imported into the bot.');
} catch (error) { cliError(error); }
