import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'devalue';
import UPNG from 'upng-js';
import { formatDescription } from '../src/beta/description.ts';
import { currentImagePages, diffImagePages } from '../src/beta/diff-image.ts';
import { renderDiffImage } from '../src/beta/render.ts';
import { parseDetails } from '../src/beta/source.ts';
import type { BetaTextRange } from '../src/beta/types.ts';

const page = (data: unknown) => JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: JSON.parse(stringify({ data })) }] });
const marked = (text: string, ranges: BetaTextRange[] = []) => ranges.map(range => text.slice(range.start, range.end));
const ability = (power: number, name = 'Beam') => ({ id: 42, name: { text: name }, type: { text: 'Skill' },
  description: { text: 'Deals <color=#f29e38ff><unbreak>#1[i]%</unbreak></color> DMG for <unbreak>#2[i]</unbreak> turns.' },
  description_params: [{ index: 0, values: [power] }, { index: 1, values: [2] }] });

test('preserves highlighted phrases and tooltip values through nested tags, entities, newlines, and Unicode', () => {
  const description = formatDescription({ text: 'Unused', override: '  😀 Gain <color=#f29e38ff><u>extra turn</u> &amp; <unbreak>#1[f1]</unbreak></color>%; gain #2[i] stacks at 3 allies.<br/>End.  ' },
    [{ index: 1, values: [2] }, { index: 0, values: [0.125] }]);
  assert.equal(description.text, '😀 Gain extra turn & 12.5%; gain 2 stacks at 3 allies.\nEnd.');
  assert.deepEqual(marked(description.text, description.emphasis), ['extra turn & 12.5%', '2']);
  assert.ok(description.emphasis.every(range => range.start >= 0 && range.end <= description.text.length));
});

test('highlights parameters without a colour tag, preserves static source emphasis, and keeps missing values explicit', () => {
  const description = formatDescription('<color=#f29e38ff>Gain <u>extra turn</u> <color=#cb2f2f>warning</color> now</color>\\n<unbreak>#1[i]</unbreak> and #2[f1]% at <unbreak>15</unbreak>. <color=orange>#3[i]%</color>',
    [{ index: 0, values: [-12.5] }, { index: 1, values: [0.8] }]);
  assert.equal(description.text, 'Gain extra turn warning now\n-12.5 and 80% at 15. [parameter 3 unavailable]');
  assert.deepEqual(marked(description.text, description.emphasis), ['Gain extra turn ', ' now', '-12.5', '80%']);
  assert.equal(formatDescription(null, null).text, '');
});

test('carries source emphasis into current kits, traces, eidolons, and both sides of a renamed comparison', () => {
  const details = parseDetails(page({ source: { dto: { skills: [ability(1, 'Old Beam')] } },
    target: { dto: { skills: [ability(1.2, 'New Beam')],
      skill_tree: [{ id: 1, levels: [{ name: { text: 'Trace' }, description: '#1[i]% bonus.', description_params: [{ index: 0, values: [0.1] }] }] }],
      eidolons: [{ id: 1, description: '<color=#f29e38ff>extra turn</color>' }] } } }));
  const change = details.sections[0]!.entries[0]!.comparison!;
  assert.deepEqual(marked(change.before!, change.beforeEmphasis), ['100%', '2']);
  assert.deepEqual(marked(change.after!, change.afterEmphasis), ['120%', '2']);
  for (const [section, expected] of [['kit', ['120%', '2']], ['traces', ['10%']], ['eidolons', ['extra turn']]] as const) {
    const entry = details.sections.find(value => value.id === section)!.entries[0]!;
    assert.deepEqual(marked(entry.value, entry.emphasis), expected);
  }
  const unchanged = parseDetails(page({ source: { dto: { skills: [{ id: 42, description: '<color=#f29e38ff>Gain 2 charges.</color>' }] } },
    target: { dto: { skills: [{ id: 42, description: 'Gain 2 charges.' }] } } }));
  assert.equal(unchanged.changes.length, 0);
  assert.equal(unchanged.sections[0]!.entries[0]!.comparison, undefined);
});

test('renders real amber pixels while whole changed values take red/green priority', async () => {
  const details = parseDetails(page({ source: { dto: { skills: [ability(1)] } }, target: { dto: { skills: [ability(1.2)] } } }));
  const current = currentImagePages(details.sections.find(section => section.id === 'kit')!.entries)[0]!;
  assert.match(current.svg, /fill="#f29e38">120%<\/tspan>/);
  assert.match(current.svg, /fill="#f29e38">2<\/tspan>/);
  const diff = diffImagePages(details.sections[0]!.entries)[0]!;
  assert.doesNotMatch(diff.svg, /Source emphasis/);
  assert.match(diff.svg, /fill="#ff8b94" text-decoration="line-through">100%<\/tspan>/);
  assert.match(diff.svg, /fill="#83e3a4">120%<\/tspan>/);
  assert.match(diff.svg, /fill="#f29e38">2<\/tspan>/);
  for (const [image, expected] of [[current, ['242,158,56']], [diff, ['242,158,56', '255,139,148', '131,227,164']]] as const) {
    const bytes = await renderDiffImage(image);
    const decoded = UPNG.decode(new Uint8Array(bytes).buffer);
    const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]!);
    const colors = new Set<string>();
    // Examine the description area, excluding the header and footer legend.
    for (let y = 155; y < decoded.height - 85; y++) for (let x = 0; x < decoded.width; x++) {
      const offset = (y * decoded.width + x) * 4;
      colors.add([...pixels.slice(offset, offset + 3)].join(','));
    }
    for (const color of expected) assert.ok(colors.has(color), `Description contains ${color} pixels`);
  }
});

test('keeps emphasis through long wrapped descriptions and escapes decoded source markup', () => {
  const description = formatDescription('😀 Opening. <color=#f29e38ff>' + 'Critical value 12.5% &amp; bonus. '.repeat(200) + '</color> FINAL SENTENCE', []);
  const pages = currentImagePages([{ name: 'Long passive', value: description.text, emphasis: description.emphasis }]);
  assert.equal(pages.length, 1);
  assert.match(pages[0]!.svg, /fill="#f29e38">Critical/);
  assert.match(pages[0]!.text, /FINAL\s+SENTENCE$/);
  const unsafe = formatDescription('<color=#f29e38ff>&lt;image href=&quot;https://private.invalid/&quot;/&gt;</color>', []);
  const image = currentImagePages([{ name: 'Unsafe source', value: unsafe.text, emphasis: unsafe.emphasis }])[0]!;
  assert.ok(!image.svg.includes('<image ') && image.svg.includes('&lt;image'));
});
