import { Buffer } from 'node:buffer';
import type { BetaMessage } from './types.ts';

/** Replace previous image attachments when editing a private page. */
export function nodeBetaMessage(message: BetaMessage) {
  const { files, ...payload } = message;
  return { ...payload, attachments: [], files: (files ?? []).map(file => ({ name: file.name, attachment: Buffer.from(file.data), description: file.description })) };
}
