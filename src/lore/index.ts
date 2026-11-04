import { loreCatalog } from './catalog.ts';
import { LoreLibrary } from './library.ts';
import { loreConnections } from './connections.ts';

export const defaultLoreLibrary = new LoreLibrary(loreCatalog, loreConnections);
export const loreCatalogueInfo = {
  entries: loreCatalog.length,
  connections: loreConnections.length,
  reviewedAt: loreCatalog.map(entry => entry.reviewedAt).sort().at(-1)!,
  defaultSpoilers: 'tagged',
  coverage: 'Curated released lore across worlds, cultures, food, lifeforms, politics, people, and history; selected material through 4.5, not complete patch coverage.',
} as const;
