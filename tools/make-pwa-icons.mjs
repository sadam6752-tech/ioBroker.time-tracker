/**
 * Generates the app icons and the favicon of the web app from the master logo.
 *
 * The files are checked in, so a build never depends on this script; it exists so they can be produced again
 * whenever the logo changes:
 *
 *   node tools/make-pwa-icons.mjs
 *
 * Written are `src-pwa/public/icon-192.png`, `icon-512.png` and `favicon.svg`. There are two masters, both
 * part of the repository but not of the npm package (the `files` rule of `package.json` excludes
 * `admin/src`):
 *
 * - `admin/src/zeiterfassung.png` (512x512, 8 bit RGBA, not interlaced) for the two icons. PNG is read and
 *   written by hand (zlib and CRC32 from Node), which keeps the repository free of image libraries.
 * - `admin/src/zeiterfassung.svg` (a tracing of the logo) for the favicon: the drawing is vector, so a tab
 *   keeps it sharp at any size. Its `viewBox` is computed from the drawing, see `writeFavicon`.
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
const vectorPath = join(here, "..", "admin", "src", "zeiterfassung.svg");
const targetDir = join(here, "..", "src-pwa", "public");

/** Edge length of the visible mark in relation to the icon (the rest is margin). */
const MARK_RATIO = 0.72;
/** Alpha above which a pixel counts as part of the mark. */
const ALPHA_THRESHOLD = 8;
const BACKGROUND = [255, 255, 255];
const SIZES = [192, 512];
/** Margin around the drawing in `favicon.svg`, in relation to the drawing (it needs no white plate). */
const FAVICON_MARGIN = 0.05;

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
 * Collects the points of a path (absolute, in user units), curve control points included.
 *
 * @param {string} d - value of the `d` attribute
 * @returns {number[][]} pairs of coordinates
 */
function pathPoints(d) {
	const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
	const points = [];
	let command = "";
	let x = 0;
	let y = 0;
	let index = 0;

	/** Reads one coordinate of the path data. */
	const read = () => Number(tokens[index++]);

	while (index < tokens.length) {
		if (/[A-Za-z]/.test(tokens[index])) {
			command = tokens[index++];
		}
		if (command === "") {
			throw new Error(`path data without a command in ${vectorPath}`);
		}

		// a relative command counts from the current point, an absolute one from the origin
		const originX = command === command.toLowerCase() ? x : 0;
		const originY = command === command.toLowerCase() ? y : 0;
		/** Reads a point and remembers it for the box. */
		const take = () => {
			const point = [originX + read(), originY + read()];
			points.push(point);
			return point;
		};

		switch (command.toUpperCase()) {
			case "M":
			case "L":
			case "T": {
				[x, y] = take();
				if (command === "M") {
					command = "L";
				} else if (command === "m") {
					command = "l";
				}
				break;
			}
			case "H": {
				x = originX + read();
				break;
			}
			case "V": {
				y = originY + read();
				break;
			}
			case "C": {
				take();
				take();
				[x, y] = take();
				break;
			}
			case "S":
			case "Q": {
				take();
				[x, y] = take();
				break;
			}
			case "A": {
				read();
				read();
				read();
				read();
				read();
				[x, y] = take();
				break;
			}
			default: {
				if (command !== "Z" && command !== "z") {
					throw new Error(`unsupported SVG path command "${command}" in ${vectorPath}`);
				}
			}
		}
	}

	return points;
}

/**
 * Reads the transform of an element as scale and offset.
 *
 * Rotation and skew are refused instead of being ignored: a wrong box would clip the drawing without anybody
 * noticing, and the logo masters only use `translate`/`scale`/`matrix`.
 *
 * @param {string} transform - value of the `transform` attribute
 * @returns {{ scaleX: number, scaleY: number, moveX: number, moveY: number }} the transform
 */
function svgTransform(transform) {
	let scaleX = 1;
	let scaleY = 1;
	let moveX = 0;
	let moveY = 0;

	for (const part of transform.split(")").filter(Boolean)) {
		const [name, values] = part.split("(");
		const args = (values ?? "")
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		if (name.trim() === "translate") {
			moveX += args[0];
			moveY += args[1] ?? 0;
		} else if (name.trim() === "scale") {
			scaleX *= args[0];
			scaleY *= args[1] ?? args[0];
		} else if (name.trim() === "matrix" && args[1] === 0 && args[2] === 0) {
			scaleX *= args[0];
			scaleY *= args[3];
			moveX += args[4];
			moveY += args[5];
		} else {
			throw new Error(`unsupported SVG transform "${transform}" in ${vectorPath}`);
		}
	}

	return { scaleX, scaleY, moveX, moveY };
}

/**
 * Computes the box around the drawing of an SVG.
 *
 * @param {string} svg - content of the SVG file
 * @returns {{ x: number, y: number, width: number, height: number }} box around the drawing
 */
function svgDrawingBox(svg) {
	const paths = [...svg.matchAll(/<path\b([^>]*)>/g)];
	if (paths.length === 0) {
		throw new Error(`${vectorPath} has no <path> elements`);
	}

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const [, attributes] of paths) {
		const transform = svgTransform(/transform="([^"]*)"/.exec(attributes)?.[1] ?? "");
		for (const [pathX, pathY] of pathPoints(/d="([^"]+)"/.exec(attributes)?.[1] ?? "")) {
			const x = pathX * transform.scaleX + transform.moveX;
			const y = pathY * transform.scaleY + transform.moveY;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}

	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Writes `favicon.svg` from the vector master.
 *
 * The master is a tracing of the logo (VTracer, 435x435, 9 flat colours). It carries no `viewBox` and its
 * disc sticks out over the edge of the canvas, so the viewBox is **computed from the drawing**: a browser
 * would clip the overflowing parts, and that cut would sit right at the rim of the mark. `width`/`height` are
 * dropped for the same reason — without them the SVG follows every size, from 16 px in a tab to a large
 * bookmark tile. The paths themselves are written through unchanged.
 *
 * @returns {void}
 */
function writeFavicon() {
	const master = readFileSync(vectorPath, "utf8");
	const box = svgDrawingBox(master);
	const margin = Math.max(box.width, box.height) * FAVICON_MARGIN;
	const side = Math.max(box.width, box.height) + margin * 2;
	// a square viewBox, centred on the drawing
	const x = box.x + box.width / 2 - side / 2;
	const y = box.y + box.height / 2 - side / 2;
	const round = value => Math.round(value * 100) / 100;

	const svg = [
		"<!-- Generated by tools/make-pwa-icons.mjs from admin/src/zeiterfassung.svg, do not edit. -->",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(x)} ${round(y)} ${round(side)} ${round(side)}" role="img" aria-label="Zeiterfassung">`,
		...[...master.matchAll(/<path\b[^>]*>/g)].map(match => `\t${match[0]}`),
		"</svg>",
		"",
	].join("\n");

	const path = join(targetDir, "favicon.svg");
	writeFileSync(path, svg, "utf8");
	console.log(
		`wrote ${path} (${svg.length} bytes, drawing ${round(box.width)}x${round(box.height)} at ${round(box.x)},${round(box.y)})`,
	);
}

const master = readPng(masterPath);
const box = visibleBox(master.pixels, master.width, master.height);
console.log(`master ${master.width}x${master.height}, visible ${box.width}x${box.height} at ${box.x},${box.y}`);

for (const size of SIZES) {
	writeIcon(size, draw(master.pixels, master.width, box, size));
}

writeFavicon();
