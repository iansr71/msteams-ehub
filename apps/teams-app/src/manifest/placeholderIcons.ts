import { encodePng, type RgbaImage } from './png.js';

/*
 * PLACEHOLDER icons, generated so the package is valid before real artwork exists. Replace
 * them with Skin Renewal-approved artwork that meets the requirements in docs/teams-app.md;
 * `teams:validate` checks size and (for the outline icon) colours.
 */

type Rgba = readonly [number, number, number, number];

function canvas(size: number, fill: Rgba): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    pixels.set(fill, index * 4);
  }
  return pixels;
}

function rect(
  pixels: Uint8Array,
  size: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgba,
): void {
  for (let row = y; row < y + h; row += 1) {
    for (let column = x; column < x + w; column += 1) {
      pixels.set(color, (row * size + column) * 4);
    }
  }
}

/** A block "E" scaled to the canvas. */
function drawE(pixels: Uint8Array, size: number, color: Rgba): void {
  const unit = size / 16;
  const at = (value: number): number => Math.round(value * unit);
  rect(pixels, size, at(4), at(3), at(2), at(10), color);
  rect(pixels, size, at(4), at(3), at(8), at(2), color);
  rect(pixels, size, at(4), at(7), at(6), at(2), color);
  rect(pixels, size, at(4), at(11), at(8), at(2), color);
}

const WHITE: Rgba = [255, 255, 255, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

export function placeholderColorIcon(accent: Rgba = [0x5b, 0x3f, 0x8c, 255]): Buffer {
  const size = 192;
  const pixels = canvas(size, accent);
  drawE(pixels, size, WHITE);
  const image: RgbaImage = { width: size, height: size, pixels };
  return encodePng(image);
}

export function placeholderOutlineIcon(): Buffer {
  const size = 32;
  const pixels = canvas(size, TRANSPARENT);
  drawE(pixels, size, WHITE);
  return encodePng({ width: size, height: size, pixels });
}
