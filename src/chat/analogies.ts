import type { ChatContext, ChatMessage } from './types.ts';

export const MAX_RECENT_ANALOGY_REPLIES = 6;
export const MAX_RECENT_ANALOGY_REFERENCES = 8;

// Recognize common fallbacks and the library's specific connections. These are
// fixed labels, never excerpts or instructions copied from conversation text.
const references: readonly { label: string; pattern: RegExp }[] = [
  { label: 'Skill Points and resource-pool comparisons', pattern: /\bskill[\s-]*points?\b|\btrailblaze power\b|\bultimate energy\b/i },
  { label: 'Astral Express journeys', pattern: /\bastral express\b|\bthe express\b/i },
  { label: 'Simulated Universe experiments', pattern: /\bsimulated universe\b|\bdivergent universe\b/i },
  { label: 'Curio catalogues', pattern: /\bcurios?\b/i },
  { label: 'IPC bureaucracy and accounting', pattern: /\bipc\b|\binterastral peace corporation\b/i },
  { label: 'Combat team roles', pattern: /\bdps\b|\bdamage dealers?\b|\bsustain slots?\b/i },
  { label: 'Immortal’s Delight and Xianzhou tea', pattern: /\bimmortal['’]s delight\b/i },
  { label: 'Mung Bean Soda', pattern: /\bmung bean soda\b/i },
  { label: 'Golden Honeycake publicity', pattern: /\bgolden honeycakes?\b/i },
  { label: 'Aurum Alley merchants and logistics', pattern: /\baurum alley\b/i },
  { label: 'Synesthesia Beacons', pattern: /\bsynesthesia beacons?\b/i },
  { label: 'Penacony’s Dreamscape', pattern: /\bpenacony\b|\bdreamscape\b|\bdream['’]s eye\b/i },
  { label: 'Marmoreal Palace public baths', pattern: /\bmarmoreal palace\b/i },
  { label: 'Dr. Ratio and accessible learning', pattern: /\bdr\.? ratio\b|\bdoctor ratio\b/i },
  { label: 'March 7th’s photographs', pattern: /\bmarch 7th\b|\bmarch 7\b/i },
  { label: 'Xianzhou commissions', pattern: /\b(?:xianzhou|six) commissions\b/i },
  { label: 'Jing Yuan’s prevention', pattern: /\bjing yuan\b/i },
  { label: 'Wildfire’s community work', pattern: /\bwildfire\b/i },
  { label: 'Wardance tournaments', pattern: /\bwardance\b/i },
  { label: 'Dromases as working animals', pattern: /\bdromas(?:es)?\b/i },
];

/** A bounded, per-request reminder; no cross-channel state or additional model call. */
export function recentAnalogyReferences(messages: readonly ChatMessage[], context?: ChatContext): readonly string[] {
  const latestQuestion = messages.findLastIndex(message => message.role === 'user');
  const replies = [
    ...(context?.recentMessages.filter(message => message.isOwnReply).map(message => message.content) ?? []),
    ...messages.slice(0, latestQuestion < 0 ? 0 : latestQuestion).filter(message => message.role === 'assistant').map(message => message.content),
  ].slice(-MAX_RECENT_ANALOGY_REPLIES).reverse();
  const found = new Set<string>();
  for (const reply of replies) {
    const prose = reply.slice(0, 8_000).replace(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`/g, ' ')
      .replace(/^\s*>.*$/gm, ' ').replace(/https?:\/\/\S+/g, ' ');
    for (const reference of references) if (reference.pattern.test(prose)) {
      found.add(reference.label);
      if (found.size === MAX_RECENT_ANALOGY_REFERENCES) return [...found];
    }
  }
  return [...found];
}
