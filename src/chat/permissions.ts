import type { ChatMode } from './types.ts';

export function missingChatThreadPermissions(mode: ChatMode, hasPermission: (bit: bigint) => boolean): string[] {
  // /chat creates a standalone thread and only posts there. Parent-channel Send Messages is independent.
  const required: [bigint, string][] = [
    [1024n, 'View Channel'],
    [65536n, 'Read Message History'],
    [1n << (mode === 'group' ? 35n : 36n), `Create ${mode === 'group' ? 'Public' : 'Private'} Threads`],
    [1n << 38n, 'Send Messages in Threads'],
  ];
  return required.filter(([bit]) => !hasPermission(bit)).map(([, name]) => name);
}
