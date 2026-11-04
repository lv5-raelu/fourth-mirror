import { loreCatalog } from './catalog.ts';
import { LoreLibrary } from './library.ts';

export const defaultLoreLibrary = new LoreLibrary(loreCatalog);
export const loreCatalogueInfo = {
  entries: loreCatalog.length,
  reviewedAt: loreCatalog.map(entry => entry.reviewedAt).sort().at(-1)!,
  defaultSpoilers: 'tagged',
  coverage: 'Curated foundational lore; release labels identify summarized material, not complete patch coverage.',
} as const;
