import { deflateSync, inflateSync } from "node:zlib";

// A small PNG writer and reader for the board tests: 8-bit RGB out (the test plates), and
// 8-bit or 16-bit grey or RGB in (the depth map and the mattes), no interlace.

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// An 8-bit RGB PNG from a pixel function (x, y) => [r, g, b], each 0 to 255.
export function writePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = Math.max(0, Math.min(255, Math.round(r)));
      raw[row + 2 + x * 3] = Math.max(0, Math.min(255, Math.round(g)));
      raw[row + 3 + x * 3] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export type Image = { width: number; height: number; depth: number; channels: number; data: number[] };

// Reads a non-interlaced grey (0) or RGB (2) PNG of bit depth 8 or 16. `data` holds the samples
// row by row, `channels` per pixel.
export function readPng(png: Buffer): Image {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const size = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + size);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      if (body[12] !== 0) throw new Error("interlaced");
    } else if (type === "IDAT") idat.push(body);
    at += 12 + size;
  }
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : 0;
  if (channels === 0 || (depth !== 8 && depth !== 16)) throw new Error(`colour type ${colour} depth ${depth}`);
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? rows[y * stride + i - bpp] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? rows[(y - 1) * stride + i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[y * stride + i] = v & 0xff;
    }
  }
  const data: number[] = [];
  for (let i = 0; i < width * height * channels; i++) data.push(depth === 8 ? rows[i] : rows.readUInt16BE(i * 2));
  return { width, height, depth, channels, data };
}

// The mean of channel 0 over a rectangle [x0, x1) x [y0, y1).
export function meanOver(image: Image, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += image.data[(y * image.width + x) * image.channels];
      n++;
    }
  }
  return sum / n;
}
