import { ChatError } from '../chat/types.ts';
import type { BetaRevision, BetaRow, BetaSection } from './types.ts';

export const ENTITIES_PER_PAGE = 20;
export type BetaMode = 'visual' | 'text';
export interface BetaView { revision: string; entity: number; section: string; page: number; mode?: BetaMode }
export const viewId = (view: BetaView, control = 'view'): string => `beta:${view.revision}:${view.entity}:${view.section}:${view.page}:${view.mode ?? 'visual'}:${control}`;

const legacySections: Record<string, string> = { text: 'changes', textkit: 'kit', texttrace: 'traces', texteid: 'eidolons' };
function normalizeSection(view: BetaView): void {
  if (legacySections[view.section]) { view.section = legacySections[view.section]!; view.mode = 'text'; }
}

export function readView(customId: string, values: string[] = []): BetaView {
  const match = /^beta:(beta_\d{1,3}\.\d{1,3}\.\d{1,3}_\d{1,16}):(-1|\d{1,4}):([a-z]{1,10}):(\d{1,4}):(?:(visual|text):)?(view|entity|section|format|mode|share)$/.exec(customId);
  if (!match) throw new ChatError('That beta control is no longer available. Run /beta latest again.');
  const view: BetaView = { revision: match[1]!, entity: Number(match[2]), section: match[3]!, page: Number(match[4]), mode: match[5] === 'text' ? 'text' : 'visual' };
  normalizeSection(view);
  if (match[6] === 'entity') {
    if (values.length !== 1 || !/^\d{1,4}$/.test(values[0]!)) throw new ChatError('Choose a character or item from the menu.');
    view.entity = Number(values[0]); view.section = 'changes'; view.page = 0;
  } else if (match[6] === 'section') {
    if (values.length !== 1 || !/^[a-z]{1,10}$/.test(values[0]!)) throw new ChatError('Choose a section from the menu.');
    view.section = values[0]!; view.page = 0; normalizeSection(view);
  } else if (match[6] === 'format') {
    if (values.length !== 1 || !['visual', 'text'].includes(values[0]!)) throw new ChatError('Choose Visual or Text from the menu.');
    view.mode = values[0] as BetaMode; view.page = 0;
  } else if (match[6] === 'mode') {
    // Keep buttons on older shared messages usable.
    view.mode = view.mode === 'text' ? 'visual' : 'text'; view.page = 0;
  }
  return view;
}

export function entityMenu(revision: BetaRevision, view: BetaView, listPage: number): BetaRow[] {
  const entities = revision.entities.slice(listPage * ENTITIES_PER_PAGE, (listPage + 1) * ENTITIES_PER_PAGE);
  return entities.length ? [{ type: 1, components: [{ type: 3, custom_id: viewId(view, 'entity'), placeholder: 'Read character or item details',
    options: entities.map((entity, index) => ({ label: entity.name.slice(0, 100), value: String(listPage * ENTITIES_PER_PAGE + index),
      description: `${entity.category} · ${entity.status}`.slice(0, 100), default: view.entity === listPage * ENTITIES_PER_PAGE + index })) }] }] : [];
}

export function sectionMenu(view: BetaView, sections: BetaSection[]): BetaRow {
  return { type: 1, components: [{ type: 3, custom_id: viewId(view, 'section'), placeholder: 'Choose a detail section',
    options: sections.map(section => ({ label: section.title, value: section.id, default: view.section === section.id })) }] };
}

export function modeMenu(view: BetaView, disabled = false): BetaRow {
  return { type: 1, components: [{ type: 3, custom_id: viewId(view, 'format'), placeholder: 'Display format', disabled,
    options: [{ label: 'Visual', value: 'visual', default: view.mode !== 'text' }, { label: 'Text', value: 'text', default: view.mode === 'text' }] }] };
}

export function pageButtons(view: BetaView, count: number): BetaRow {
  return { type: 1, components: [
    { type: 2, style: 2, label: 'Previous', custom_id: viewId({ ...view, page: Math.max(0, view.page - 1) }), disabled: view.page === 0 },
    { type: 2, style: 2, label: 'Next', custom_id: viewId({ ...view, page: view.page + 1 }), disabled: view.page + 1 >= count },
  ] };
}
