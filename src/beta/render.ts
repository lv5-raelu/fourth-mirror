import { Buffer } from 'node:buffer';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { fontBase64 } from './fonts/noto-sans-mono.ts';
import type { DiffImagePage } from './diff-image.ts';

let module: Parameters<typeof initWasm>[0] | undefined;
let initializing: Promise<void> | undefined;
const font = new Uint8Array(Buffer.from(fontBase64, 'base64'));
const images = new Map<string, Promise<Uint8Array>>();
export function configureBetaRenderer(compiled: Parameters<typeof initWasm>[0]): void { module = compiled; }

async function initialize(): Promise<void> {
  if (!module) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    module = new Uint8Array(await readFile(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))));
  }
  await initWasm(module);
}

export async function renderDiffImage(page: DiffImagePage): Promise<Uint8Array> {
  let image = images.get(page.svg);
  if (!image) {
    image = (async () => {
      if (page.width > 1_000 || page.height > 1_600) throw new Error('Comparison image exceeds the rendering limit.');
      initializing ??= initialize().catch(error => { initializing = undefined; throw error; });
      await initializing;
      const renderer = new Resvg(page.svg, { font: { fontBuffers: [font], defaultFontFamily: 'Noto Sans Mono' } });
      try {
        const rendered = renderer.render();
        try { return new Uint8Array(rendered.asPng()); }
        finally { rendered.free(); }
      } finally { renderer.free(); }
    })();
    images.set(page.svg, image);
    if (images.size > 12) images.delete(images.keys().next().value!);
    void image.catch(() => { if (images.get(page.svg) === image) images.delete(page.svg); });
  }
  return image;
}
