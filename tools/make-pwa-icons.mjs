/**
 * Generates the app icons and the favicon of the web app from the master logo.
 *
 * The files are checked in, so a build never depends on this script; it exists so they can be produced again
 * whenever the logo changes:
 *
 *   node tools/make-pwa-icons.mjs
 *
 * Written are `src-pwa/public/icon-192.png`, `icon-512.png` and `favicon.svg`. The master is
 * `admin/src/zeiterfassung.png` (512x512, 8 bit RGBA, not interlaced): part of the repository, but not of the
 * npm package (the `files` rule of `package.json` excludes `admin/src`). PNG is read and written by hand
 * (zlib and CRC32 from Node), which keeps the repository free of image libraries and binary tooling.
 *
 * The layout follows two requirements of the manifest:
 *
 * - the content is cropped to its visible pixels first (alpha > 8), so transparent padding in the master does
 *   not shrink the mark,
 * - the mark is centred at 72 % of the icon edge on an opaque white background. The 512 icon is declared as
 *   `maskable`, and a launcher only guarantees the central 80 % of the image, so the mark keeps a margin of
 *   about 4 % per side. The opaque white background (the `background_color` of the manifest) also avoids the
 *   black plate iOS paints below a transparent touch icon.
 */

import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const masterPath = join(here, "..", "admin", "src", "zeiterfassung.png");
const targetDir = join(here, "..", "src-pwa", "public");

/** Edge length of the visible mark in relation to the icon (the rest is margin). */
const MARK_RATIO = 0.72;
/** Alpha above which a pixel counts as part of the mark. */
const ALPHA_THRESHOLD = 8;
const BACKGROUND = [255, 255, 255];
const SIZES = [192, 512];
/** Edge length of the raster embedded in `favicon.svg` (browsers draw tabs at 16-32 px). */
const FAVICON_SIZE = 64;

/** Bytes per pixel of the expected master format (RGBA, 8 bit). */
const BPP = 4;

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
 * Reverses the per scanline filters of a PNG image.
 *
 * @param {Buffer} raw - inflated image data (a filter byte plus pixels per scanline)
 * @param {number} width - image width in pixels
 * @param {number} height - image height in pixels
 * @returns {Buffer} unfiltered RGBA pixels
 */
function unfilter(raw, width, height) {
	const stride = width * BPP;
	const pixels = Buffer.alloc(stride * height);

	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		const target = y * stride;
		const previous = target - stride;

		for (let i = 0; i < stride; i++) {
			const left = i >= BPP ? pixels[target + i - BPP] : 0;
			const up = y > 0 ? pixels[previous + i] : 0;
			const upLeft = y > 0 && i >= BPP ? pixels[previous + i - BPP] : 0;
			const value = line[i];

			if (filter === 0) {
				pixels[target + i] = value;
			} else if (filter === 1) {
				pixels[target + i] = (value + left) & 0xff;
			} else if (filter === 2) {
				pixels[target + i] = (value + up) & 0xff;
			} else if (filter === 3) {
				pixels[target + i] = (value + ((left + up) >> 1)) & 0xff;
			} else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				pixels[target + i] = (value + predictor) & 0xff;
			} else {
				throw new Error(`unknown PNG filter ${filter} in scanline ${y}`);
			}
		}
	}

	return pixels;
}

/**
 * Reads a PNG image in the only format the master may use (8 bit RGBA, not interlaced).
 *
 * @param {string} path - file to read
 * @returns {{ width: number, height: number, pixels: Buffer }} image data
 */
function readPng(path) {
	const file = readFileSync(path);
	const idat = [];
	let width = 0;
	let height = 0;
	let header = null;

	for (let offset = 8; offset < file.length;) {
		const length = file.readUInt32BE(offset);
		const type = file.toString("ascii", offset + 4, offset + 8);
		const data = file.subarray(offset + 8, offset + 8 + length);

		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			header = { depth: data[8], colour: data[9], interlace: data[12] };
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}

		offset += 12 + length;
	}

	if (!header) {
		throw new Error(`${path} has no IHDR chunk`);
	}
	if (header.depth !== 8 || header.colour !== 6 || header.interlace !== 0) {
		throw new Error(
			`${path} must be an 8 bit RGBA PNG without interlacing (found depth ${header.depth}, ` +
				`colour type ${header.colour}, interlace ${header.interlace})`,
		);
	}

	return { width, height, pixels: unfilter(inflateSync(Buffer.concat(idat)), width, height) };
}

/**
 * Finds the box of the visible pixels, so transparent padding in the master is ignored.
 *
 * @param {Buffer} pixels - RGBA pixels
 * @param {number} width - image width in pixels
 * @param {number} height - image height in pixels
 * @returns {{ x: number, y: number, width: number, height: number }} visible box
 */
function visibleBox(pixels, width, height) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (pixels[(y * width + x) * BPP + 3] <= ALPHA_THRESHOLD) {
				continue;
			}
			if (x < minX) {
				minX = x;
			}
			if (y < minY) {
				minY = y;
			}
			if (x > maxX) {
				maxX = x;
			}
			if (y > maxY) {
				maxY = y;
			}
		}
	}

	if (maxX < 0) {
		throw new Error("the master has no visible pixels");
	}

	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Draws one icon: the visible mark, scaled to `MARK_RATIO` of the edge, centred on an opaque background.
 *
 * Scaling averages the source pixels covering a target pixel (box filter) and composites them over the
 * background first, so the anti aliased edge of the mark stays clean at every size. The master has to be at
 * least as large as the mark — for these icons it is.
 *
 * @param {Buffer} pixels - pixels of the master
 * @param {number} sourceWidth - width of the master
 * @param {{ x: number, y: number, width: number, height: number }} box - visible box inside the master
 * @param {number} size - edge length of the icon
 * @returns {Buffer} RGBA pixels of the icon
 */
function draw(pixels, sourceWidth, box, size) {
	const mark = Math.round(size * MARK_RATIO);
	const offset = Math.floor((size - mark) / 2);
	const icon = Buffer.alloc(size * size * BPP);

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const target = (y * size + x) * BPP;
			let red = 0;
			let green = 0;
			let blue = 0;
			let weight = 0;

			if (x >= offset && x < offset + mark && y >= offset && y < offset + mark) {
				const fromX = box.x + ((x - offset) * box.width) / mark;
				const toX = box.x + ((x - offset + 1) * box.width) / mark;
				const fromY = box.y + ((y - offset) * box.height) / mark;
				const toY = box.y + ((y - offset + 1) * box.height) / mark;

				for (let sy = Math.floor(fromY); sy < Math.ceil(toY) && sy < box.y + box.height; sy++) {
					const overlapY = Math.min(toY, sy + 1) - Math.max(fromY, sy);
					for (let sx = Math.floor(fromX); sx < Math.ceil(toX) && sx < box.x + box.width; sx++) {
						const area = (Math.min(toX, sx + 1) - Math.max(fromX, sx)) * overlapY;
						if (area <= 0) {
							continue;
						}
						const source = (sy * sourceWidth + sx) * BPP;
						const alpha = pixels[source + 3] / 255;
						red += (pixels[source] * alpha + BACKGROUND[0] * (1 - alpha)) * area;
						green += (pixels[source + 1] * alpha + BACKGROUND[1] * (1 - alpha)) * area;
						blue += (pixels[source + 2] * alpha + BACKGROUND[2] * (1 - alpha)) * area;
						weight += area;
					}
				}
			}

			if (weight > 0) {
				icon[target] = Math.round(red / weight);
				icon[target + 1] = Math.round(green / weight);
				icon[target + 2] = Math.round(blue / weight);
			} else {
				icon[target] = BACKGROUND[0];
				icon[target + 1] = BACKGROUND[1];
				icon[target + 2] = BACKGROUND[2];
			}
			icon[target + 3] = 255;
		}
	}

	return icon;
}

/**
 * Writes a PNG file.
 *
 * @param {number} size - edge length in pixels
 * @param {Buffer} pixels - RGBA pixels
 * @returns {Buffer} the PNG file
 */
function toPng(size, pixels) {
	// one filter byte (0 = none) in front of every scanline
	const raw = Buffer.alloc(size * (size * BPP + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * BPP + 1)] = 0;
		pixels.copy(raw, y * (size * BPP + 1) + 1, y * size * BPP, (y + 1) * size * BPP);
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

	return file;
}

/**
 * Writes one of the app icons.
 *
 * @param {number} size - edge length in pixels
 * @param {Buffer} pixels - RGBA pixels
 * @returns {void}
 */
function writeIcon(size, pixels) {
	const file = toPng(size, pixels);
	const path = join(targetDir, `icon-${size}.png`);
	writeFileSync(path, file);
	console.log(`wrote ${path} (${file.length} bytes, mark ${Math.round(size * MARK_RATIO)} px)`);
}

/**
 * Writes `favicon.svg`.
 *
 * The master is a raster image (a blue disc with the logo drawing, 4171 colours), so there is no vector
 * source to write out. The SVG therefore carries the icon as an embedded PNG — same layout as the app icons,
 * which keeps the tab icon and the installed app identical. `index.html` keeps a PNG link as fallback.
 *
 * @param {Buffer} pixels - pixels of the master
 * @param {number} sourceWidth - width of the master
 * @param {{ x: number, y: number, width: number, height: number }} box - visible box inside the master
 * @returns {void}
 */
function writeFavicon(pixels, sourceWidth, box) {
	const png = toPng(FAVICON_SIZE, draw(pixels, sourceWidth, box, FAVICON_SIZE));
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_SIZE} ${FAVICON_SIZE}" role="img" aria-label="Zeiterfassung">`,
		`\t<image width="${FAVICON_SIZE}" height="${FAVICON_SIZE}" href="data:image/png;base64,${png.toString("base64")}"/>`,
		"</svg>",
		"",
	].join("\n");

	const path = join(targetDir, "favicon.svg");
	writeFileSync(path, svg, "utf8");
	console.log(`wrote ${path} (${svg.length} bytes, embedded ${FAVICON_SIZE} px PNG)`);
}

const master = readPng(masterPath);
const box = visibleBox(master.pixels, master.width, master.height);
console.log(`master ${master.width}x${master.height}, visible ${box.width}x${box.height} at ${box.x},${box.y}`);

for (const size of SIZES) {
	writeIcon(size, draw(master.pixels, master.width, box, size));
}

writeFavicon(master.pixels, master.width, box);
