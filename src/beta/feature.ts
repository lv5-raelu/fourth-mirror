import { ChatError } from '../chat/types.ts';
import type { ChatService } from '../chat/service.ts';
import type { BetaClient } from './source.ts';
import { hasTrackedChanges } from './source.ts';
import type { BetaMonitor } from './monitor.ts';
import { alertsMessage, answerMessage, noTrackedChangesMessage } from './presentation.ts';
import { overviewMessage } from './browser.ts';
import type { BetaFeed, BetaMessage } from './types.ts';

export interface BetaFeature { client: BetaClient; monitor: BetaMonitor }
export interface BetaRequest {
  action: string;
  userId: string;
  canManage: boolean;
  question?: string;
  channelId?: string;
  enabled?: boolean;
}

export async function executeBeta(request: BetaRequest, feature: BetaFeature, chat: ChatService | null,
  edit: (message: BetaMessage) => Promise<void>, validateChannel: (channelId: string) => Promise<void>): Promise<void> {
  if (request.action === 'latest') {
    const feed = await feature.client.feed();
    const revision = feed.revisions.find(hasTrackedChanges);
    await edit(revision ? await overviewMessage(feature.client, { ...feed, revisions: [revision] }) : noTrackedChangesMessage(feed));
    return;
  }
  if (request.action === 'ask') {
    if (!chat) throw new ChatError('AI chat is not configured. You can still use /beta latest to browse the archive.');
    const question = request.question?.trim();
    if (!question || question.length > 1_000) throw new ChatError('Ask a beta question between 1 and 1,000 characters.');
    let feed: BetaFeed;
    await chat.answer(request.userId, question, async text => edit(answerMessage(text, feed)), {
      source: async () => { const result = await feature.client.question(question); feed = result.feed; return result.source; },
    });
    return;
  }
  if (request.action !== 'alerts') throw new ChatError('Choose /beta latest, /beta ask, or /beta alerts.');
  if (!request.canManage) throw new ChatError('You need Manage Server permission to view or change beta notification settings.');
  if (request.enabled === false) { await edit(alertsMessage(await feature.monitor.configure(null))); return; }
  if (request.channelId) {
    await validateChannel(request.channelId);
    await edit(alertsMessage(await feature.monitor.configure(request.channelId)));
    return;
  }
  if (request.enabled === true) throw new ChatError('Select a channel to enable beta notifications.');
  await edit(alertsMessage(await feature.monitor.status()));
}
