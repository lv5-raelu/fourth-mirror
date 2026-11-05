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
  image?: { url: string };
}

export interface BetaMessage {
  content?: string;
  embeds: BetaEmbed[];
  components?: BetaRow[];
  files?: BetaFile[];
}

export interface BetaFile { name: string; data: Uint8Array; description: string }

export type BetaButton = { type: 2; style: 5; label: string; url: string }
  | { type: 2; style: 1 | 2; label: string; custom_id: string; disabled?: boolean };
export type BetaRow = { type: 1; components: BetaButton[] }
  | { type: 1; components: [{ type: 3; custom_id: string; placeholder: string;
    options: { label: string; value: string; description?: string; default?: boolean }[] }] };

export interface BetaHeading { type: string; name: string; iconUrl?: string }
/** UTF-16 offsets into the corresponding plain description. */
export interface BetaTextRange { start: number; end: number }
export interface BetaDetailEntry {
  name: string; value: string; heading?: BetaHeading; emphasis?: BetaTextRange[];
  comparison?: { before: string | null; after: string | null; beforeEmphasis?: BetaTextRange[]; afterEmphasis?: BetaTextRange[] };
}
export interface BetaSection { id: string; title: string; entries: BetaDetailEntry[] }
