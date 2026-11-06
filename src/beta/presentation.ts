import { BETA_URL } from './source.ts';
import type { BetaAlertState, BetaFeed, BetaMessage, BetaRevision } from './types.ts';
import { truncateDiscordText } from '../chat/messages.ts';
import { ENTITIES_PER_PAGE, entityMenu, pageButtons, viewId } from './navigation.ts';
import type { BetaMode } from './navigation.ts';

const color = 0xce6687;
const clean = (value: string): string => value.replace(/[\\`*_~|\[\]<>@]/g, '').slice(0, 120);
const linkButton = { type: 1 as const, components: [{ type: 2 as const, style: 5 as const, label: 'Open beta archive', url: BETA_URL }] };
const footer = { text: 'Gachabase • Unofficial beta data • Subject to change • Checked' };
const label = (revision: BetaRevision) => `v${revision.version} · Rev. ${revision.revision}`;

export function latestMessage(feed: BetaFeed, notifications?: BetaRevision[], requestedPage = 0, mode: BetaMode = 'visual'): BetaMessage {
  const revision = feed.revisions[0]!;
  const pages = Math.max(1, Math.ceil(revision.entities.length / ENTITIES_PER_PAGE));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const entities = revision.entities.slice(page * ENTITIES_PER_PAGE, (page + 1) * ENTITIES_PER_PAGE);
  const view = { revision: revision.key, entity: -1, section: 'overview', page, mode };
  const fields = [{ name: 'Version', value: `v${revision.version} (BETA)`, inline: true }, { name: 'Design revision', value: String(revision.revision), inline: true }];
  for (const category of [...new Set(entities.map(entity => entity.category))]) {
    const entries = entities.filter(entity => entity.category === category);
    const lines: string[] = [];
    for (const entity of entries) {
      const line = `${entity.status === 'new' ? '✦ New' : entity.status === 'removed' ? '− Removed' : '↻ Updated'} · ${clean(entity.name).slice(0, 90)}`;
      if (lines.join('\n').length + line.length > 850) break;
      lines.push(line);
    }
    if (lines.length < entries.length) lines.push(`+ ${entries.length - lines.length} more in the selector`);
    fields.push({ name: category, value: lines.join('\n'), inline: false });
  }
  if (!revision.entities.length) fields.push({ name: 'Tracked changes', value: 'Gachabase lists this revision without tracked character or item changes.', inline: false });
  if (notifications && notifications.length > 1) fields.push({ name: 'Also published since the last check', value: notifications.slice(1, 8).map(label).join('\n').slice(0, 700), inline: false });
  const description = feed.stale ? 'The archive is temporarily unavailable. These are the last successfully retrieved findings; they may no longer be current.'
    : notifications ? 'Ahem! Fresh findings from the beta archive. Gachabase has published a new revision.'
    : 'Choose a character or item below to read its changes, skills, and other details here in Discord.';
  return { embeds: [{ title: `Fourth Mirror’s Beta Archive · v${revision.version}`, description, url: BETA_URL, color,
    fields, footer: { text: `${footer.text}${pages > 1 ? ` • Entries page ${page + 1}/${pages}` : ''}` }, timestamp: new Date(feed.checkedAt).toISOString() }],
    components: [...entityMenu(revision, view, page), ...(pages > 1 ? [pageButtons(view, pages)] : []),
      { type: 1, components: [{ type: 2, style: 2, label: 'Share to channel', custom_id: viewId(view, 'share') }, ...linkButton.components] }] };
}

export function answerMessage(text: string, feed: BetaFeed): BetaMessage {
  const revision = feed.revisions[0]!;
  const description = truncateDiscordText(text.trim(), 3_800, '\n\n*Answer shortened.*');
  return { embeds: [{ title: 'Fourth Mirror · Beta Inquiry', description, color, url: BETA_URL,
    fields: [{ name: 'Archive snapshot', value: label(revision) + (feed.stale ? '\nCached data — Gachabase could not be refreshed.' : '') }],
    footer, timestamp: new Date(feed.checkedAt).toISOString() }], components: [{ type: 1, components: [
      { type: 2, style: 2, label: 'Share to channel', custom_id: 'beta:answer:share' }, ...linkButton.components,
    ] }] };
}

export function alertsMessage(state: BetaAlertState): BetaMessage {
  return { embeds: [{ title: 'Beta Update Notifications', description: state.channelId
    ? `Updates will be posted in <#${state.channelId}>. I check Gachabase every **10 minutes**; existing revisions are not announced when alerts are enabled.`
    : 'Notifications are disabled. An administrator can enable them with **/beta alerts channel:** and select a beta/spoiler channel.', color,
    fields: [
      { name: 'Last source check', value: state.lastCheckedAt ? `<t:${Math.floor(state.lastCheckedAt / 1_000)}:R>` : 'Not checked yet', inline: true },
      { name: 'Last announcement', value: state.lastAnnouncedAt ? `<t:${Math.floor(state.lastAnnouncedAt / 1_000)}:R>` : 'None yet', inline: true },
      ...(state.lastError ? [{ name: 'Status', value: state.lastError }] : []),
    ], footer }], components: [linkButton] };
}
