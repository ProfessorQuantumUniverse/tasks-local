#!/usr/bin/env node
/**
 * Render the app icon into the PNG sizes Android and iOS want.
 *
 * web/icon.svg stays the source of truth for the shape; this script draws the
 * same geometry and writes the raster versions the manifest points at. Chrome
 * on Android will not reliably treat an SVG-only manifest as installable, so
 * PNGs are not optional if the app should land on the home screen.
 *
 * No image dependency: the icon is a rounded rectangle and one round-capped
 * polyline, which is a few lines of signed-distance maths, and Node already
 * ships the deflate needed for a PNG.
 *
 *   node scripts/make-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'web', 'icons');

// Geometry in the 64x64 coordinate system of web/icon.svg.
const VIEW = 64;
const BG = [0x0a, 0x0a, 0x0a];
const FG = [0x00, 0xff, 0x88];
const CORNER_RADIUS = 14;
const STROKE = 7;
const CHECK = [[16, 33.5], [27, 44], [48, 21]];

// ── Signed distance fields ────────────────────────────────────────────────

function sdRoundedBox(px, py, halfW, halfH, r) {
    const qx = Math.abs(px) - (halfW - r);
    const qy = Math.abs(py) - (halfH - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
    const pax = px - ax;
    const pay = py - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Round joins and caps come for free: the union of round-capped segments. */
function sdPolyline(px, py, points) {
    let d = Infinity;
    for (let i = 0; i < points.length - 1; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        d = Math.min(d, sdSegment(px, py, ax, ay, bx, by));
    }
    return d;
}

/** Distance in pixels -> coverage, antialiased across a one pixel band. */
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));

function overlay(dst, offset, colour, alpha) {
    if (alpha <= 0) return;
    const inv = 1 - alpha;
    for (let c = 0; c < 3; c += 1) {
        dst[offset + c] = Math.round(colour[c] * alpha + dst[offset + c] * inv);
    }
    dst[offset + 3] = Math.round(255 * alpha + dst[offset + 3] * inv);
}

/**
 * @param {number} size      edge length in pixels
 * @param {boolean} maskable full bleed background, artwork inside the safe zone
 */
function render(size, { maskable = false } = {}) {
    const pixels = new Uint8Array(size * size * 4);
    const scale = size / VIEW;
    const half = size / 2;

    // Android masks a maskable icon to its own shape, so the background must
    // reach every corner and the artwork must stay inside the middle 80%.
    const radius = maskable ? 0 : CORNER_RADIUS * scale;
    const checkScale = maskable ? 0.88 : 1;

    const check = CHECK.map(([x, y]) => [
        half + (x - VIEW / 2) * scale * checkScale,
        half + (y - VIEW / 2) * scale * checkScale,
    ]);
    const strokeRadius = (STROKE / 2) * scale * checkScale;

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const px = x + 0.5;
            const py = y + 0.5;
            const offset = (y * size + x) * 4;

            overlay(pixels, offset, BG, coverage(sdRoundedBox(px - half, py - half, half, half, radius)));
            overlay(pixels, offset, FG, coverage(sdPolyline(px, py, check) - strokeRadius));
        }
    }

    return pixels;
}

// ── Minimal PNG writer (8 bit RGBA, one IDAT) ─────────────────────────────

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    // 10..12 stay zero: deflate, adaptive filtering, no interlace.

    // Every scanline gets filter type 0; the shapes are smooth enough that
    // fancier filters would not pay for the complexity.
    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y += 1) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Output set ────────────────────────────────────────────────────────────

const TARGETS = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable-192.png', size: 192, maskable: true },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
    // iOS applies its own mask and does not read the manifest.
    { file: 'apple-touch-icon.png', size: 180, maskable: true },
];

await mkdir(outDir, { recursive: true });

for (const { file, size, maskable } of TARGETS) {
    const png = encodePng(render(size, { maskable }), size);
    await writeFile(join(outDir, file), png);
    console.log(`[icons] ${file.padEnd(24)} ${size}x${size}  ${png.length} bytes`);
}
