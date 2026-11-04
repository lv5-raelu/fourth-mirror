export type LoreCategory = 'cosmology' | 'person' | 'faction' | 'location' | 'lifeform' | 'culture' | 'technology' | 'history';
export type LoreSpoiler = 'setting' | 'story';

export interface LoreSource {
  readonly title: string;
  readonly url: string;
  readonly kind: 'game-text' | 'official-guide' | 'community-reference';
}

export interface LoreEntry {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly category: LoreCategory;
  readonly content: string;
  readonly related: readonly string[];
  readonly sources: readonly LoreSource[];
  /** Release containing the material summarized here; not a claim to cover every subsequent patch. */
  readonly release: string;
  readonly reviewedAt: string;
  readonly spoiler: LoreSpoiler;
  readonly status: 'released' | 'in-universe-account' | 'interpretation' | 'beta';
}
