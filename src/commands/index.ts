import { help } from './help.ts';
import { ping } from './ping.ts';
import { createCommandRegistry } from './registry.ts';
import { chat } from './chat.ts';
import { reset } from './reset.ts';
import { beta } from './beta.ts';

// Add new commands here. Runtime routing, deployment, and /help share this list.
export const commands = createCommandRegistry([help, ping, chat, reset, beta]);
