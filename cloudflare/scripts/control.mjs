import { readFile } from 'node:fs/promises';
import { parseHistory } from '../../src/chat/history.ts';
import { cliError, control, saveHistory } from './common.mjs';

try {
  const [command, file] = process.argv.slice(2);
  if (['status', 'preflight'].includes(command)) console.log(JSON.stringify(await control('/' + command), null, 2));
  else if (['start', 'stop', 'drain', 'verify'].includes(command)) console.log(JSON.stringify(await control('/' + command, 'POST'), null, 2));
  else if (command === 'export' && file) console.log(`Exported ${await saveHistory(file, await control('/history'))} conversations to ${file}.`);
  else if (command === 'import' && file) {
    const history = parseHistory(JSON.parse(await readFile(file, 'utf8')));
    console.log(JSON.stringify(await control('/history/import', 'POST', history)));
  } else throw new Error('Usage: cloudflare:control -- status|preflight|verify|start|stop|drain|export NEW_FILE|import FILE');
} catch (error) { cliError(error); }
