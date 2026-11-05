import webpWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';
import { configureWebpDecoder } from '../../src/chat/webp-decoder.ts';

// Compiling downloaded WASM is disallowed in Workers; Wrangler bundles this module.
configureWebpDecoder(webpWasm);
