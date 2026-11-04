import { crc32, deflateSync, inflateSync } from 'node:zlib';

/*
 * Minimal PNG support for the app icons: write 8-bit RGBA images, and read the header and
 * (for 8-bit RGBA, non-interlaced files) the pixels, so the outline icon's colours can be
 * checked. Other PNG variants are reported as "not checkable" rather than guessed at.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** width × height × 4 bytes, row by row. */
  readonly pixels: Uint8Array;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(image: RgbaImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colorType: number;
  readonly interlaced: boolean;
  readonly hasAlphaChannel: boolean;
}

export class PngFormatError extends Error {}

interface ParsedPng {
  readonly info: PngInfo;
  readonly data: Buffer;
}

function parse(bytes: Uint8Array): ParsedPng {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngFormatError('Not a PNG file.');
  }
  let offset = 8;
  let info: PngInfo | undefined;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) {
      throw new PngFormatError('Truncated PNG chunk.');
    }
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const colorType = data[9] ?? -1;
      info = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] ?? 0,
        colorType,
        interlaced: data[12] === 1,
        hasAlphaChannel: colorType === 4 || colorType === 6,
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = end;
  }
  if (info === undefined) {
    throw new PngFormatError('PNG has no header.');
  }
  return { info, data: Buffer.concat(idat) };
}

export function readPngInfo(bytes: Uint8Array): PngInfo {
  return parse(bytes).info;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Pixels of an 8-bit RGBA, non-interlaced PNG; undefined for any other variant. */
export function decodeRgbaPng(bytes: Uint8Array): RgbaImage | undefined {
  const { info, data } = parse(bytes);
  if (info.bitDepth !== 8 || info.colorType !== 6 || info.interlaced) {
    return undefined;
  }
  const raw = inflateSync(data);
  const stride = info.width * 4;
  if (raw.length !== (stride + 1) * info.height) {
    throw new PngFormatError('PNG image data has the wrong size.');
  }
  const pixels = new Uint8Array(stride * info.height);
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = x >= 4 && y > 0 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0;
      let decoded: number;
      switch (filter) {
        case 0:
          decoded = value;
          break;
        case 1:
          decoded = value + left;
          break;
        case 2:
          decoded = value + up;
          break;
        case 3:
          decoded = value + Math.floor((left + up) / 2);
          break;
        case 4:
          decoded = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PngFormatError('Unknown PNG filter.');
      }
      pixels[y * stride + x] = decoded & 0xff;
    }
  }
  return { width: info.width, height: info.height, pixels };
}
