import webpWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';
import { configureWebpDecoder } from '../../src/chat/webp-decoder.ts';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { configureBetaRenderer } from '../../src/beta/render.ts';

// Compiling downloaded WASM is disallowed in Workers; Wrangler bundles this module.
configureWebpDecoder(webpWasm);
configureBetaRenderer(resvgWasm);
