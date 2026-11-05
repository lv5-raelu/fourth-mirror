import moduleFactory from '@jsquash/webp/codec/dec/webp_dec.js';

// Node's ES-only type libraries omit WebAssembly. Keep this declaration local;
// Workers supplies its own native WebAssembly implementation and compiled module.
declare const WebAssembly: {
  compile(bytes: Uint8Array<ArrayBuffer>): Promise<unknown>;
  Instance: new (module: unknown, imports: unknown) => { exports: unknown };
};

interface Pixels { data: Uint8ClampedArray; width: number; height: number }
interface Decoder { decode(data: ArrayBuffer): Pixels | null }
let compiledModule: unknown;
let decoder: Promise<Decoder> | undefined;

export function configureWebpDecoder(module: unknown): void { compiledModule = module; }

async function initialize(): Promise<Decoder> {
  if (!compiledModule) {
    // This branch runs in Node only. Workers imports the WASM at bundle time.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    compiledModule = await WebAssembly.compile(new Uint8Array(await readFile(fileURLToPath(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')))));
  }
  if (!('ImageData' in globalThis)) Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; }
  } });
  const factory = moduleFactory as unknown as (options: { noInitialRun: boolean; instantiateWasm: (imports: unknown, callback: (instance: unknown) => void) => unknown; printErr: () => void }) => Promise<Decoder>;
  return factory({ noInitialRun: true, printErr: () => {}, instantiateWasm: (imports, callback) => {
    const instance = new WebAssembly.Instance(compiledModule, imports);
    callback(instance);
    return instance.exports;
  } });
}

export async function decodeWebp(data: Uint8Array): Promise<Pixels> {
  decoder ??= initialize().catch(error => { decoder = undefined; throw error; });
  const image = (await decoder).decode(new Uint8Array(data).buffer);
  if (!image) throw new Error('WebP decoding failed');
  return image;
}
