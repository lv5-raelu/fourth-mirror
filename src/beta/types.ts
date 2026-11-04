export interface BetaEntity {
  id: number;
  name: string;
  category: string;
  status: string;
  url: string;
  diffUrl?: string;
}

export interface BetaRevision {
  key: string;
  version: string;
  revision: number;
  resourceRevision: number;
  publishedAt?: number;
  entities: BetaEntity[];
}

export interface BetaFeed {
  checkedAt: number;
  revisions: BetaRevision[];
  stale?: boolean;
}

export interface BetaAlertState {
  guildId: string;
  channelId: string | null;
  checkpoint: BetaRevision | null;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  lastAnnouncedAt: number | null;
  lastError: string | null;
  deliveryPending: boolean;
}

export interface BetaStateStore {
  load(guildId: string): Promise<BetaAlertState | undefined>;
  save(state: BetaAlertState): Promise<void>;
}

export interface BetaStateCollection extends BetaStateStore {
  list(): Promise<BetaAlertState[]>;
}

export interface BetaEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer: { text: string };
  timestamp?: string;
}

export interface BetaMessage {
  content?: string;
  embeds: BetaEmbed[];
  components?: { type: 1; components: { type: 2; style: 5; label: string; url: string }[] }[];
}
