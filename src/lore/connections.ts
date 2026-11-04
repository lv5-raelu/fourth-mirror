export interface LoreConnection {
  readonly id: string;
  /** Specific concepts, never aliases asserting that the real-world topic is literally game lore. */
  readonly phrases: readonly string[];
  readonly entryIds: readonly string[];
  readonly comparison: string;
}

// Editorial bridges to researched, spoiler-free entries. Keep shared features explicit and limited.
export const loreConnections: readonly LoreConnection[] = [
  { id: 'milk-tea', phrases: ['milk tea', 'bubble tea', 'boba tea'], entryIds: ['immortals-delight'],
    comparison: 'A favorite indulgent tea drink recalls Immortal’s Delight. Compare the everyday pleasure, without inventing identical ingredients.' },
  { id: 'fermentation', phrases: ['fermented drink', 'fermented drinks', 'fermented soda', 'kombucha'], entryIds: ['xianzhou-drinks'],
    comparison: 'Fermentation connects the topic to Xianzhou’s Mung Bean Soda. A shared process does not make their recipes or health effects identical.' },
  { id: 'food-trends', phrases: ['viral dessert', 'food trend', 'food trends', 'celebrity endorsement', 'celebrity endorsements'], entryIds: ['golden-honeycake'],
    comparison: 'Golden Honeycake became fashionable through teleslate publicity. Compare how attention can popularize an older food.' },
  { id: 'novelty-food', phrases: ['theme park food', 'novelty ice cream', 'food truck menu', 'unusual ice cream'], entryIds: ['penacony-food'],
    comparison: 'Penacony’s novelty snacks connect playful presentation and food branding. Distinguish invented dream food from actual recipes.' },
  { id: 'public-baths', phrases: ['public baths', 'public bathhouse', 'communal baths', 'communal bathing'], entryIds: ['okhema'],
    comparison: 'Okhema’s Marmoreal Palace also serves as a social gathering place. Compare the communal function without claiming identical customs.' },
  { id: 'local-commerce', phrases: ['shopping street', 'local merchants', 'small business district', 'delivery routes', 'delivery route', 'logistics planning'], entryIds: ['aurum-alley'],
    comparison: 'Aurum Alley connects local commerce with practical logistics. Use the relevant shared feature, rather than claiming the same political situation.' },
  { id: 'translation', phrases: ['machine translation', 'translation app', 'translation apps', 'language barrier', 'language barriers'], entryIds: ['synesthesia-beacons'],
    comparison: 'Synesthesia Beacons bridge languages in the setting. Compare communication assistance while retaining real translation’s limits.' },
  { id: 'virtual-worlds', phrases: ['virtual reality', 'shared virtual world', 'shared virtual worlds', 'social vr'], entryIds: ['penacony-golden-hour'],
    comparison: 'Penacony’s shared Dreamscape offers a fictional connection to social virtual environments. Do not imply present-day VR literally links sleeping minds.' },
  { id: 'perspective', phrases: ['forced perspective', 'optical illusion', 'optical illusions', 'perspective puzzle'], entryIds: ['penacony-dreamers'],
    comparison: 'Dream’s Eye uses viewpoint to join apparent routes. Connect the visual idea without treating impossible dream geometry as real engineering.' },
  { id: 'simulations', phrases: ['research simulation', 'research simulations', 'sandbox experiment', 'sandbox experiments', 'test environment', 'test environments'], entryIds: ['simulated-universe'],
    comparison: 'The Simulated Universe offers a research comparison: test a model in controlled conditions and distinguish its result from reality.' },
  { id: 'education', phrases: ['knowledge sharing', 'sharing knowledge', 'science education', 'accessible education', 'open educational resources'], entryIds: ['dr-ratio'],
    comparison: 'Dr. Ratio’s wish to spread knowledge makes an apt connection to accessible learning. His theatrical delivery is not evidence for the real claim.' },
  { id: 'photographs', phrases: ['travel photos', 'travel photography', 'photo journal', 'photo journals', 'digital scrapbook'], entryIds: ['dan-heng-march'],
    comparison: 'March 7th’s photographs preserve new experiences. Keep her hidden past out of a cheerful everyday comparison.' },
  { id: 'departments', phrases: ['corporate departments', 'business divisions', 'different departments', 'department responsibilities'], entryIds: ['ipc-departments'],
    comparison: 'The IPC’s departments illustrate that one institution can contain different responsibilities and interests, without equating real coworkers with villains.' },
  { id: 'administration', phrases: ['division of responsibilities', 'separate government agencies', 'public administration'], entryIds: ['xianzhou-government'],
    comparison: 'The Xianzhou commissions divide specialist civic tasks. Compare that division rather than implying identical constitutions or legitimacy.' },
  { id: 'prevention', phrases: ['preventive maintenance', 'routine maintenance', 'prevent problems', 'preventing problems'], entryIds: ['jing-yuan-yanqing'],
    comparison: 'Jing Yuan’s preference for quiet prevention over dramatic rescue connects to careful routine work.' },
  { id: 'community', phrases: ['community organizing', 'neighborhood mutual aid', 'neighbourhood mutual aid'], entryIds: ['wildfire'],
    comparison: 'Wildfire’s neighbors helping neighbors offers a limited connection to voluntary community coordination, without borrowing the story’s suffering as a punchline.' },
  { id: 'tournaments', phrases: ['martial arts tournament', 'martial arts tournaments', 'sports festival'], entryIds: ['wardance'],
    comparison: 'The Wardance connects practiced skill with a public celebration. Do not turn a real sporting result into a claim about game power rankings.' },
  { id: 'working-animals', phrases: ['working animals', 'beasts of burden', 'pack animals'], entryIds: ['dromases'],
    comparison: 'Dromases help Amphorean daily work. Compare their social role, not their imaginary diet or biology.' },
];
