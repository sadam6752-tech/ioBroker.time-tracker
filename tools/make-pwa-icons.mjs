/**
 * Generates the app icons of the web app (a clock on the ioBroker blue).
 *
 * The icons are checked in, so a build does not depend on this script; it exists so the icons can be
 * regenerated in any size without an image library:
 *
 *   node tools/make-pwa-icons.mjs
 *
 * PNG is written by hand (IHDR/IDAT/IEND with zlib and CRC32), which keeps the repository free of binary tools.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targetDir = join(here, "..", "src-pwa", "public");

const BACKGROUND = [25, 118, 210, 255];
const FACE = [255, 255, 255, 255];

/** CRC32 table (PNG uses the standard polynomial). */
const crcTable = Array.from({ length: 256 }, (_value, index) => {
	let c = index;
	for (let bit = 0; bit < 8; bit++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return c >>> 0;
});

/**
 * Computes the CRC32 of a buffer.
 *
 * @param {Buffer} buffer - data
 * @returns {number} checksum
 */
function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a PNG chunk.
 *
 * @param {string} type - chunk type
 * @param {Buffer} data - chunk payload
 * @returns {Buffer} the chunk
 */
function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Blends a colour over another one.
 *
 * @param {number[]} base - bottom colour
 * @param {number[]} top - top colour
 * @param {number} alpha - coverage of the top colour
 * @returns {number[]} resulting colour
 */
function blend(base, top, alpha) {
	return base.map((value, index) => Math.round(value * (1 - alpha) + top[index] * alpha));
}

/**
 * Draws the icon as RGBA pixels.
 *
 * @param {number} size - edge length in pixels
 * @returns {Buffer} raw RGBA data
 */
function draw(size) {
	const pixels = Buffer.alloc(size * size * 4);
	const center = size / 2;
	const faceRadius = size * 0.36;
	const handWidth = size * 0.055;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x + 0.5 - center;
			const dy = y + 0.5 - center;
			const distance = Math.hypot(dx, dy);

			let colour = BACKGROUND;

			// clock face with a soft edge
			const faceCoverage = Math.min(1, Math.max(0, faceRadius + 1 - distance));
			if (faceCoverage > 0) {
				colour = blend(colour, FACE, faceCoverage);
			}

			// minute hand (up) and hour hand (right), drawn over the face
			const onVerticalHand = Math.abs(dx) <= handWidth / 2 && dy <= 0 && Math.abs(dy) <= size * 0.26;
			const onHorizontalHand = Math.abs(dy) <= handWidth / 2 && dx >= 0 && dx <= size * 0.2;
			if ((onVerticalHand || onHorizontalHand) && distance <= faceRadius) {
				colour = BACKGROUND;
			}

			const offset = (y * size + x) * 4;
			pixels[offset] = colour[0];
			pixels[offset + 1] = colour[1];
			pixels[offset + 2] = colour[2];
			pixels[offset + 3] = 255;
		}
	}

	return pixels;
}

/**
 * Writes a PNG file.
 *
 * @param {number} size - edge length in pixels
 * @returns {void}
 */
function writeIcon(size) {
	const pixels = draw(size);
	// one filter byte (0 = none) in front of every scanline
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0;
		pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // colour type: RGBA
	header[10] = 0; // compression
	header[11] = 0; // filter
	header[12] = 0; // interlace

	const file = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);

	const path = join(targetDir, `icon-${size}.png`);
	writeFileSync(path, file);
	console.log(`wrote ${path} (${file.length} bytes)`);
}

writeIcon(192);
writeIcon(512);
