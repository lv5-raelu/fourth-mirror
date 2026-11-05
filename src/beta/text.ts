export function plainText(value: string, trim = true): string {
  const text = value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '').replace(/\\n/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return trim ? text.trim() : text;
}

// Source text must not create mentions, links, or Discord formatting of its own.
export const discordText = (value: string): string => value.replace(/@/g, '@\u200b').replace(/[\\`*_~|\[\]<>]/g, '\\$&');
