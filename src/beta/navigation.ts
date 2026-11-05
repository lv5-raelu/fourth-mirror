import { ChatError } from '../chat/types.ts';
import type { BetaRevision, BetaRow, BetaSection } from './types.ts';

export const ENTITIES_PER_PAGE = 20;
export interface BetaView { revision: string; entity: number; section: string; page: number }
export const viewId = (view: BetaView, control = 'view'): string => `beta:${view.revision}:${view.entity}:${view.section}:${view.page}:${control}`;

export function readView(customId: string, values: string[] = []): BetaView {
  const match = /^beta:(beta_\d{1,3}\.\d{1,3}\.\d{1,3}_\d{1,16}):(-1|\d{1,4}):([a-z]{1,10}):(\d{1,4}):(view|entity|section|share)$/.exec(customId);
  if (!match) throw new ChatError('That beta control is no longer available. Run /beta latest again.');
  const view = { revision: match[1]!, entity: Number(match[2]), section: match[3]!, page: Number(match[4]) };
  if (match[5] === 'entity') {
    if (values.length !== 1 || !/^\d{1,4}$/.test(values[0]!)) throw new ChatError('Choose a character or item from the menu.');
    view.entity = Number(values[0]); view.section = 'changes'; view.page = 0;
  } else if (match[5] === 'section') {
    if (values.length !== 1 || !/^[a-z]{1,10}$/.test(values[0]!)) throw new ChatError('Choose a section from the menu.');
    view.section = values[0]!; view.page = 0;
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

export function pageButtons(view: BetaView, count: number): BetaRow {
  return { type: 1, components: [
    { type: 2, style: 2, label: 'Previous', custom_id: viewId({ ...view, page: Math.max(0, view.page - 1) }), disabled: view.page === 0 },
    { type: 2, style: 2, label: 'Next', custom_id: viewId({ ...view, page: view.page + 1 }), disabled: view.page + 1 >= count },
  ] };
}
