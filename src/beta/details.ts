import { plainText } from './text.ts';
import type { BetaDetailEntry, BetaSection } from './types.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): RecordValue[] => Array.isArray(value) ? value.slice(0, 150).map(object) : [];
const text = (value: unknown): string => {
  const item = object(value);
  return plainText(typeof value === 'string' ? value : typeof item.override === 'string' && item.override ? item.override : typeof item.text === 'string' ? item.text : '');
};

/** Gachabase indices are zero-based; tooltip placeholders are one-based. */
export function renderDescription(value: unknown, parameters: unknown): string {
  const params = list(parameters);
  return text(value).replace(/#(\d+)\[(?:i|f\d+)\](%?)/g, (_match, index: string, percent: string) => {
    const values = params.find(param => param.index === Number(index) - 1)?.values;
    const number = Array.isArray(values) ? values[0] : undefined;
    if (typeof number !== 'number' || !Number.isFinite(number)) return `[parameter ${index} unavailable]`;
    return String(Number((number * (percent ? 100 : 1)).toFixed(4))) + percent;
  });
}

interface Block extends BetaDetailEntry { key: string; section: string }
function blocks(value: unknown): Block[] {
  const dto = object(value), result: Block[] = [];
  const add = (key: string, section: string, name: string, description: string): void => {
    if (description) result.push({ key, section, name, value: description });
  };
  const skills = (value: unknown, prefix: string, group: string): void => {
    for (const [index, skill] of list(value).entries()) {
      const type = text(skill.type), name = text(skill.name) || 'Unnamed ability';
      add(`${prefix}:${skill.id ?? index}`, 'kit', [group, type, name].filter(Boolean).join(' · '),
        renderDescription(skill.description ?? skill.short_description, skill.description_params ?? skill.short_description_params));
    }
  };
  skills(dto.skills, 'skills', '');
  skills(dto.global_passives, 'global_passives', 'Passive');
  skills(object(dto.memosprite).skills, 'memosprite', 'Memosprite');
  for (const node of list(dto.skill_tree)) {
    const level = list(node.levels).find(level => text(level.description));
    if (level) add(`trace:${node.id}`, 'traces', text(level.name) || 'Trace', renderDescription(level.description, level.description_params));
  }
  for (const [index, eidolon] of list(dto.eidolons).entries()) {
    add(`eidolon:${eidolon.id ?? index}`, 'eidolons', `E${eidolon.level ?? index + 1} · ${text(eidolon.name) || 'Eidolon'}`,
      renderDescription(eidolon.description, eidolon.params ?? eidolon.description_params));
  }
  for (const [index, eidolon] of list(dto.affinitive_eidolons).entries()) {
    add(`affinitive:${eidolon.id ?? index}`, 'eidolons', `Affinitive Eidolon · ${text(eidolon.name) || 'Effect'}`,
      renderDescription(eidolon.description, eidolon.params ?? eidolon.description_params));
  }
  for (const [index, bonus] of list(dto.set_bonuses).entries()) {
    add(`set:${bonus.pieces ?? index}`, 'details', `${bonus.pieces ?? '?'}-piece bonus`, renderDescription(bonus.description, bonus.description_params));
  }
  // Light Cone passives are supplied as a single skill rather than character skills.
  const skill = object(dto.skill);
  add('skill', 'details', text(skill.name) || 'Effect', renderDescription(skill.description, skill.params ?? skill.description_params));
  const superimpositions = object(dto.superimpositions);
  add('superimpositions', 'details', `S1 · ${text(superimpositions.name) || 'Light Cone effect'}`,
    renderDescription(superimpositions.description, superimpositions.description_params));
  add('description', 'details', 'Description', renderDescription(dto.description, dto.description_params));
  for (const key of ['rarity', 'max_energy']) {
    if (typeof dto[key] === 'number') add(key, 'details', key === 'rarity' ? 'Rarity' : 'Max Energy', String(dto[key]));
  }
  return result;
}

const humanize = (field: string): string => field.replace(/\.text$/, '').replace(/\[id=(\d+)\]/g, ' $1').replace(/\[(\d+)\]/g, (_, index: string) => ` ${Number(index) + 1}`).replace(/[_.]/g, ' ').replace(/^./, char => char.toUpperCase());

export function detailSections(before: unknown, after: unknown, rawChanges: { field: string; before: string | null; after: string | null }[], compared: boolean): BetaSection[] {
  const old = new Map(blocks(before).map(block => [block.key, block]));
  const current = blocks(after), next = new Map(current.map(block => [block.key, block]));
  const changes: BetaDetailEntry[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const prev = old.get(key), cur = next.get(key);
    if (compared && (prev?.value !== cur?.value || prev?.name !== cur?.name)) {
      const renamed = prev && cur && prev.name !== cur.name;
      const before = prev ? (renamed ? prev.name + '\n' : '') + prev.value : null;
      const after = cur ? (renamed ? cur.name + '\n' : '') + cur.value : null;
      changes.push({ name: cur?.name ?? prev!.name, value: `${before ?? 'Not present'}\n\n↓\n\n${after ?? 'Removed'}`, comparison: { before, after } });
    }
  }
  // Retain the explicit numeric diff as a separate section, including higher levels
  // that might change while the first listed level's description stays the same.
  const raw = rawChanges.map(change => ({ name: humanize(change.field), value: `${change.before ?? 'Not present'} → ${change.after ?? 'Removed'}`, comparison: { before: change.before, after: change.after } }));
  const sections: BetaSection[] = [{ id: 'changes', title: 'Changes', entries: changes.length ? changes : raw.length ? raw : [{ name: 'Comparison', value: compared
    ? 'No gameplay or text differences were found in the retrieved comparison. Gachabase may have updated assets or other metadata.'
    : 'No before/after comparison is available for this entry. Browse its current details below.' }] }];
  for (const [id, title] of [['kit', 'Skills & Passives'], ['traces', 'Traces'], ['eidolons', 'Eidolons'], ['details', 'Details']]) {
    const entries = current.filter(block => block.section === id).map(({ name, value }) => ({ name, value }));
    if (entries.length) sections.push({ id: id!, title: title!, entries });
  }
  if (changes.length && raw.length) sections.push({ id: 'values', title: 'All Changed Values', entries: raw });
  return sections;
}
