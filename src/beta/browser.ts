import { ChatError } from '../chat/types.ts';
import { truncateDiscordText } from '../chat/messages.ts';
import { latestMessage } from './presentation.ts';
import { ENTITIES_PER_PAGE, entityMenu, pageButtons, readView, sectionMenu, viewId } from './navigation.ts';
import type { BetaView } from './navigation.ts';
import type { BetaClient } from './source.ts';
import { entitySourceUrl } from './source.ts';
import type { BetaDetailEntry, BetaFeed, BetaMessage, BetaRevision } from './types.ts';
import { discordText } from './text.ts';
import { currentImagePages, diffImagePages } from './diff-image.ts';
import { renderDiffImage } from './render.ts';
import { betaIcons } from './icons.ts';

/** Exercise the hosted source and image renderer without sending a Discord post. */
export async function verifyBeta(client: BetaClient) {
  const source = await client.verify();
  const revision = (await client.feed()).revisions[0]!;
  const entity = revision.entities.find(entity => entity.diffUrl);
  const details = entity ? await client.entityDetails(entity, revision) : undefined;
  const page = details ? diffImagePages(details.sections.find(section => section.id === 'changes')!.entries)[0] : undefined;
  return { ...source, comparisonImageBytes: page ? (await renderDiffImage(page)).length : 0,
    comparisonIconBytes: page?.iconUrl ? (await betaIcons.load(page.iconUrl))?.length ?? 0 : 0 };
}

/** Compile a few real comparisons without making an overview as long as a kit. */
export async function overviewMessage(client: BetaClient, feed: BetaFeed, notifications?: BetaRevision[], page = 0): Promise<BetaMessage> {
  const message = latestMessage(feed, notifications, page), revision = feed.revisions[0]!;
  const actualPage = Math.min(page, Math.max(0, Math.ceil(revision.entities.length / ENTITIES_PER_PAGE) - 1));
  const signal = AbortSignal.timeout(12_000);
  const previews = await Promise.all(revision.entities.slice(actualPage * ENTITIES_PER_PAGE, actualPage * ENTITIES_PER_PAGE + 3).map(async entity => {
    try {
      const details = await client.entityDetails(entity, revision, signal);
      const section = details.sections.find(section => section.id === (entity.status === 'new' ? 'kit' : 'changes')) ?? details.sections[0]!;
      const first = section.entries[0]!;
      const snippet = first.comparison
        ? `${truncateDiscordText(first.comparison.before ?? 'Not present', 160, '…')}\n↓\n${truncateDiscordText(first.comparison.after ?? 'Removed', 160, '…')}`
        : truncateDiscordText(first.value, 340, '…');
      return { name: entity.name, value: `${truncateDiscordText(first.name, 100, '…')}\n${snippet}` };
    } catch { return { name: entity.name, value: 'Details could not be retrieved. Select this entry to retry.' }; }
  }));
  if (previews.length) {
    // Keep the short version fields and names, with real source details above them.
    message.embeds[0]!.fields!.splice(2, 0, ...previews.map(preview => ({ name: discordText(preview.name).slice(0, 256),
      value: truncateDiscordText(discordText(preview.value), 500, '…\nSelect this entry to read more.'), inline: false })));
  }
  return message;
}

/** Split long source text across pages; never silently cut off a tooltip. */
export function detailPages(entries: BetaDetailEntry[]): BetaDetailEntry[][] {
  const pages: BetaDetailEntry[][] = [];
  let fields: BetaDetailEntry[] = [], size = 0;
  for (const entry of entries) {
    const parts = splitFields(discordText(entry.value));
    for (const [index, value] of parts.entries()) {
      const name = truncateDiscordText(discordText(entry.name), 220, '…') + (parts.length > 1 ? ` (${index + 1}/${parts.length})` : '');
      if (fields.length && (fields.length >= 4 || size + name.length + value.length > 3_200)) {
        pages.push(fields); fields = []; size = 0;
      }
      fields.push({ name, value }); size += name.length + value.length;
    }
  }
  if (fields.length) pages.push(fields);
  return pages.length ? pages : [[{ name: 'Details', value: 'No readable details were supplied for this section.' }]];
}

function splitFields(text: string): string[] {
  const parts: string[] = [];
  while (text.length > 900) {
    let end = Math.max(text.lastIndexOf('\n', 900), text.lastIndexOf(' ', 900));
    if (end < 450) end = 900;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    // Keep a Markdown escape with the character it escapes.
    let slashes = 0;
    while (text[end - slashes - 1] === '\\') slashes++;
    if (slashes % 2) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

export async function browseMessage(client: BetaClient, customId: string, values: string[] = [], imagesAllowed = true): Promise<BetaMessage> {
  const view = readView(customId, values);
  const feed = await client.feed();
  const revision = feed.revisions.find(revision => revision.key === view.revision);
  if (!revision) throw new ChatError('This revision is no longer in the retrieved archive. Run /beta latest for the current data.');
  const snapshot = { ...feed, revisions: [revision] };
  if (view.entity === -1) return overviewMessage(client, snapshot, undefined, view.page);
  const entity = revision.entities[view.entity];
  if (!entity) throw new ChatError('This entry is no longer available. Run /beta latest again.');
  let details: Awaited<ReturnType<BetaClient['entityDetails']>>;
  try { details = await client.entityDetails(entity, revision); }
  catch { return unavailableMessage(view, revision, feed); }
  const sections = [...details.sections];
  const textSections: Record<string, string> = { kit: 'textkit', traces: 'texttrace', eidolons: 'texteid' };
  for (const section of details.sections) if (textSections[section.id]) {
    sections.splice(sections.findIndex(value => value.id === section.id) + 1, 0, { ...section, id: textSections[section.id]!, title: `${section.title} (Text)` });
  }
  const changes = sections.find(section => section.id === 'changes');
  if (changes?.entries.some(entry => entry.comparison)) sections.splice(1, 0, { ...changes, id: 'text', title: 'Text Comparison' });
  const section = sections.find(section => section.id === view.section);
  if (!section) throw new ChatError('That section is no longer available. Select the character or item again.');
  let imagePages: ReturnType<typeof diffImagePages> = [];
  let imageFailure = false;
  const isImageSection = view.section === 'changes' || Boolean(textSections[view.section]);
  if (isImageSection && imagesAllowed) {
    try { imagePages = view.section === 'changes' ? diffImagePages(section.entries) : currentImagePages(section.entries); }
    catch { imageFailure = true; }
  }
  const pages = detailPages(section.entries);
  let count = imagePages.length || pages.length;
  view.page = Math.min(view.page, count - 1);
  let file;
  const imagePage = imagePages[view.page];
  if (imagePage) {
    try { file = { name: 'beta-diff.png', data: await renderDiffImage(imagePage), description: truncateDiscordText(imagePage.text, 1_024, '…') }; }
    catch {
      console.warn('Beta comparison image could not be rendered.');
      imageFailure = true; count = pages.length; view.page = Math.min(view.page, count - 1);
    }
  }
  const description = [`v${revision.version} · Rev. ${revision.revision} · ${entity.status}`,
    `${section.title} · Page ${view.page + 1}/${count}`,
    ...(details.from && details.to ? [`Comparison: ${identityLabel(details.from)} → ${identityLabel(details.to)}`] : []),
    'Descriptions show the first listed level/rank. All Changed Values includes other levels when supplied.',
    ...(feed.stale ? ['Cached archive — Gachabase could not be refreshed.'] : []),
    ...(file ? [view.section === 'changes' ? 'Red: removed · Green: added. Use Text Comparison for selectable text.' : `Use ${section.title} (Text) for selectable text.`] : []),
    ...(imageFailure ? ['Image preview unavailable; showing the text view.'] : []),
    ...(!imagesAllowed && isImageSection ? ['Image previews need Attach Files permission here; showing the text view.'] : []),
  ].join('\n');
  return { embeds: [{ title: discordText(entity.name).slice(0, 256), description, color: 0xce6687, url: entitySourceUrl(entity, revision),
    ...(file ? { image: { url: 'attachment://beta-diff.png' } } : { fields: pages[view.page]! }),
    footer: { text: 'Gachabase • Unofficial beta data • Subject to change • Checked' }, timestamp: new Date(feed.checkedAt).toISOString() }],
    ...(file ? { files: [file] } : {}),
    components: [...entityMenu(revision, view, Math.floor(view.entity / ENTITIES_PER_PAGE)), sectionMenu(view, sections),
      ...(count > 1 ? [pageButtons(view, count)] : []), { type: 1, components: [
        { type: 2, style: 2, label: 'Back to overview', custom_id: viewId({ ...view, entity: -1, section: 'overview', page: Math.floor(view.entity / ENTITIES_PER_PAGE) }) },
        { type: 2, style: 2, label: 'Share to channel', custom_id: viewId(view, 'share') },
        { type: 2, style: 5, label: 'View source', url: entitySourceUrl(entity, revision) },
      ] }] };
}

export const isBetaShare = (customId: string): boolean => customId.endsWith(':share');

/** Public posts keep browsing controls, which open private views for each reader. */
export function sharedMessage(message: BetaMessage): BetaMessage {
  return { ...(message.content ? { content: message.content } : {}), embeds: message.embeds,
    components: (message.components ?? []).map(row => row.components[0]?.type === 3 ? row : ({ ...row,
    components: row.components.filter(component => !('custom_id' in component && isBetaShare(component.custom_id))),
  })).filter(row => row.components.length) as NonNullable<BetaMessage['components']> };
}

function identityLabel(value: {}): string {
  const identity = value as { version?: unknown; revision?: unknown };
  return `v${identity.version} / ${identity.revision}`;
}

function unavailableMessage(view: BetaView, revision: BetaRevision, feed: BetaFeed): BetaMessage {
  const entity = revision.entities[view.entity]!;
  return { embeds: [{ title: discordText(entity.name).slice(0, 256), color: 0xce6687,
    description: `v${revision.version} · Rev. ${revision.revision}\nGachabase’s details could not be retrieved. Use Retry to try this entry again.`,
    footer: { text: 'Gachabase • Details unavailable' }, timestamp: new Date(feed.checkedAt).toISOString() }],
    components: [{ type: 1, components: [
      { type: 2, style: 1, label: 'Retry', custom_id: viewId(view) },
      { type: 2, style: 2, label: 'Back to overview', custom_id: viewId({ ...view, entity: -1, section: 'overview', page: Math.floor(view.entity / ENTITIES_PER_PAGE) }) },
      { type: 2, style: 5, label: 'View source', url: entitySourceUrl(entity, revision) },
    ] }] };
}
