import { readFileSync } from 'node:fs';

// The repository's personas/ directory is two levels above both src/chat/ and dist/chat/.
const defaultPersona = new URL('../../personas/fourth-mirror.md', import.meta.url);

export function readSystemPrompt(env: NodeJS.ProcessEnv): string {
  const inlinePrompt = env.AI_SYSTEM_PROMPT?.trim();
  if (inlinePrompt) return inlinePrompt;

  const personaFile = env.AI_PERSONA_FILE?.trim();
  let prompt: string;
  try {
    prompt = readFileSync(personaFile || defaultPersona, 'utf8').trim();
  } catch {
    throw new Error('Could not read AI_PERSONA_FILE. Provide a readable persona file or set AI_SYSTEM_PROMPT. Include personas/ when deploying the bot.');
  }
  if (!prompt) {
    throw new Error('AI_PERSONA_FILE must contain character instructions.');
  }
  return prompt;
}
