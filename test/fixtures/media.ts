import { encodePNG, encodeAPNG } from 'lottie.js';

export const imageUrl = 'https://cdn.discordapp.com/attachments/123456789012345678/223456789012345678/image.png';
export const gif = new Uint8Array(Buffer.from('R0lGODlhAgABAIEAAP8AAAD/AAAA/wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAgABAAACAgQKACH5BAwKAAAALAAAAAABAAEAAAICTAEAIfkECAoAAAAsAQAAAAEAAQAAAgJUAQAh+QQECgAAACwAAAAAAQABAAACAkwBADs=', 'base64'));
export const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255];
export const png = () => encodePNG(new Uint8Array(red), 1, 1);
export const apng = () => encodeAPNG([new Uint8Array(red), new Uint8Array(green), new Uint8Array(blue)], 1, 1, { fps: 10 });
export const lottie = { v: '5.5.7', w: 32, h: 32, ip: 0, op: 20, fr: 10, layers: [{
  ty: 1, ind: 1, ip: 0, op: 20, sw: 8, sh: 8, sc: '#ff0000', ks: {
    o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
    p: { a: 1, k: [{ t: 0, s: [0, 8, 0], e: [24, 8, 0] }, { t: 19, s: [24, 8, 0] }] },
  },
}] };
