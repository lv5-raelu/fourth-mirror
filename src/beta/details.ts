import { plainText } from './text.ts';
import type { BetaDetailEntry, BetaHeading, BetaSection } from './types.ts';
import { isBetaIconUrl } from './icons.ts';
import { formatDescription } from './description.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): RecordValue[] => Array.isArray(value) ? value.slice(0, 150).map(object) : [];
const text = (value: unknown): string => {
  const item = object(value);
  return plainText(typeof value === 'string' ? value : typeof item.override === 'string' && item.override ? item.override : typeof item.text === 'string' ? item.text : '');
};

export function renderDescription(value: unknown, parameters: unknown): string {
  return formatDescription(value, parameters).text;
}

interface Block extends BetaDetailEntry { key: string; section: string }
function blocks(value: unknown, refs?: unknown, side: 'source' | 'target' = 'target'): Block[] {
  const dto = object(value), result: Block[] = [];
  const assets = object(object(refs).assets);
  const heading = (type: string, name: string, hash: unknown): BetaHeading => {
    const asset = object(assets[`${String(hash)}-${side}`] ?? assets[String(hash)]);
    const iconUrl = isBetaIconUrl(asset.url) && (typeof asset.width !== 'number' || asset.width <= 512) &&
      (typeof asset.height !== 'number' || asset.height <= 512) && (typeof asset.file_size !== 'number' || asset.file_size <= 256 * 1024) ? asset.url : undefined;
    return { type, name, ...(iconUrl ? { iconUrl } : {}) };
  };
  const add = (key: string, section: string, name: string, description: ReturnType<typeof formatDescription>, heading?: BetaHeading): void => {
    if (description.text) result.push({ key, section, name, value: description.text,
      ...(description.emphasis.length ? { emphasis: description.emphasis } : {}), ...(heading ? { heading } : {}) });
  };
  const skills = (value: unknown, prefix: string, group: string): void => {
    for (const [index, skill] of list(value).entries()) {
      const type = text(skill.type), name = text(skill.name) || 'Unnamed ability';
      add(`${prefix}:${skill.id ?? index}`, 'kit', [group, type, name].filter(Boolean).join(' · '),
        formatDescription(skill.description ?? skill.short_description, skill.description_params ?? skill.short_description_params),
        heading([group, type].filter(Boolean).join(' · ') || 'Ability', name, skill.ultimate_icon_path_hash ?? skill.icon_path_hash));
    }
  };
  skills(dto.skills, 'skills', '');
  skills(dto.global_passives, 'global_passives', 'Passive');
  skills(object(dto.memosprite).skills, 'memosprite', 'Memosprite');
  for (const node of list(dto.skill_tree)) {
    const level = list(node.levels).find(level => text(level.description));
    if (level) add(`trace:${node.id}`, 'traces', text(level.name) || 'Trace', formatDescription(level.description, level.description_params),
      heading('Trace', text(level.name) || 'Trace', node.icon_path_hash));
  }
  for (const [index, eidolon] of list(dto.eidolons).entries()) {
    add(`eidolon:${eidolon.id ?? index}`, 'eidolons', `E${eidolon.level ?? index + 1} · ${text(eidolon.name) || 'Eidolon'}`,
      formatDescription(eidolon.description, eidolon.params ?? eidolon.description_params),
      heading(`E${eidolon.level ?? index + 1}`, text(eidolon.name) || 'Eidolon', eidolon.icon_path_hash));
  }
  for (const [index, eidolon] of list(dto.affinitive_eidolons).entries()) {
    add(`affinitive:${eidolon.id ?? index}`, 'eidolons', `Affinitive Eidolon · ${text(eidolon.name) || 'Effect'}`,
      formatDescription(eidolon.description, eidolon.params ?? eidolon.description_params),
      heading('Affinitive Eidolon', text(eidolon.name) || 'Effect', eidolon.icon_path_hash));
  }
  for (const [index, bonus] of list(dto.set_bonuses).entries()) {
    add(`set:${bonus.pieces ?? index}`, 'details', `${bonus.pieces ?? '?'}-piece bonus`, formatDescription(bonus.description, bonus.description_params));
  }
  // Light Cone passives are supplied as a single skill rather than character skills.
  const skill = object(dto.skill);
  add('skill', 'details', text(skill.name) || 'Effect', formatDescription(skill.description, skill.params ?? skill.description_params),
    heading('Effect', text(skill.name) || 'Effect', skill.icon_path_hash));
  const superimpositions = object(dto.superimpositions);
  add('superimpositions', 'details', `S1 · ${text(superimpositions.name) || 'Light Cone effect'}`,
    formatDescription(superimpositions.description, superimpositions.description_params));
  add('description', 'details', 'Description', formatDescription(dto.description, dto.description_params));
  for (const key of ['rarity', 'max_energy']) {
    if (typeof dto[key] === 'number') add(key, 'details', key === 'rarity' ? 'Rarity' : 'Max Energy', formatDescription(String(dto[key]), undefined));
  }
  return result;
}

const humanize = (field: string): string => field.replace(/\.text$/, '').replace(/\[id=(\d+)\]/g, ' $1').replace(/\[(\d+)\]/g, (_, index: string) => ` ${Number(index) + 1}`).replace(/[_.]/g, ' ').replace(/^./, char => char.toUpperCase());

export function detailSections(before: unknown, after: unknown, rawChanges: { field: string; before: string | null; after: string | null }[], compared: boolean, beforeRefs?: unknown, afterRefs?: unknown): BetaSection[] {
  const old = new Map(blocks(before, beforeRefs, 'source').map(block => [block.key, block]));
  const current = blocks(after, afterRefs), next = new Map(current.map(block => [block.key, block]));
  const changes: BetaDetailEntry[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const prev = old.get(key), cur = next.get(key);
    if (compared && (prev?.value !== cur?.value || prev?.name !== cur?.name)) {
      const renamed = prev && cur && prev.name !== cur.name;
      const before = prev ? (renamed ? prev.name + '\n' : '') + prev.value : null;
      const after = cur ? (renamed ? cur.name + '\n' : '') + cur.value : null;
      const heading = cur?.heading ?? prev?.heading;
      const shifted = (block: Block) => block.emphasis!.map(range => ({ start: range.start + (renamed ? block.name.length + 1 : 0), end: range.end + (renamed ? block.name.length + 1 : 0) }));
      changes.push({ name: cur?.name ?? prev!.name, value: `${before ?? 'Not present'}\n\n↓\n\n${after ?? 'Removed'}`, comparison: { before, after,
        ...(prev?.emphasis ? { beforeEmphasis: shifted(prev) } : {}), ...(cur?.emphasis ? { afterEmphasis: shifted(cur) } : {}) }, ...(heading ? { heading } : {}) });
    }
  }
  // Retain the explicit numeric diff as a separate section, including higher levels
  // that might change while the first listed level's description stays the same.
  const raw = rawChanges.map(change => ({ name: humanize(change.field), value: `${change.before ?? 'Not present'} → ${change.after ?? 'Removed'}`, comparison: { before: change.before, after: change.after } }));
  const sections: BetaSection[] = [{ id: 'changes', title: 'Changes', entries: changes.length ? changes : raw.length ? raw : [{ name: 'Comparison', value: compared
    ? 'No gameplay or text differences were found in the retrieved comparison. Gachabase may have updated assets or other metadata.'
    : 'No before/after comparison is available for this entry. Browse its current details below.' }] }];
  for (const [id, title] of [['kit', 'Skills & Passives'], ['traces', 'Traces'], ['eidolons', 'Eidolons'], ['details', 'Details']]) {
    const entries = current.filter(block => block.section === id).map(({ name, value, heading, emphasis }) => ({ name, value, ...(heading ? { heading } : {}), ...(emphasis ? { emphasis } : {}) }));
    if (entries.length) sections.push({ id: id!, title: title!, entries });
  }
  if (changes.length && raw.length) sections.push({ id: 'values', title: 'All Changed Values', entries: raw });
  return sections;
}
