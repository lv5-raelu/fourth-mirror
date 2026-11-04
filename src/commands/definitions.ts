// Portable command metadata shared by the Node and Workers transports.
export const commandDefinitions = {
  help: { name: 'help', description: 'See the available commands.' },
  ping: { name: 'ping', description: 'Check whether the bot is awake.' },
  chat: { name: 'chat', description: 'Start a private personal chat or a public group chat.',
    mode: { name: 'mode', description: 'Personal creates a private thread; Group creates a public thread.',
      choices: [{ name: 'Personal', value: 'personal' }, { name: 'Group', value: 'group' }] },
  },
  reset: { name: 'reset', description: 'Clear the AI’s conversation context in your chat thread.' },
  beta: { name: 'beta', description: 'Explore HSR beta changes and manage update notifications.' },
} as const;

export const mentionHelp = 'For a one-off answer, mention me with a question in a server channel. I can use recent messages for context; I don’t save the exchange as chat history. Use /chat for an ongoing conversation.';
