/**
 * Prepares a picture an administrator picked: a phone photo is several megabytes and a data URL grows by about a
 * third on top of that, so such a file is scaled down and re-encoded until it fits the limit the server accepts.
 * A picture that already fits is stored unchanged.
 */

/** Limit the API accepts for the branding (mirrors `MAX_BRANDING_BYTES` of the server). */
export const BRANDING_MAX_BYTES = 512 * 1024;

/** Limit the API accepts for the picture of an employee (mirrors `MAX_AVATAR_BYTES` of the server). */
export const AVATAR_MAX_BYTES = 256 * 1024;

/** Why a picture could not be prepared. */
export type ImageProblem = "type" | "unreadable" | "tooLarge";

/** A picture that is ready to be stored. */
export interface PreparedImage {
	/** Picture as a data URL */
	dataUrl: string;
	/** Size of the data URL in bytes */
	bytes: number;
	/** True when the picture had to be scaled down or re-encoded */
	resized: boolean;
}

/** Outcome of {@link prepareImage}. */
export type ImageResult = { ok: true; image: PreparedImage } | { ok: false; problem: ImageProblem };

/** Longest edge a picture is scaled down to. */
const MAX_DIMENSION = 2560;

/** Quality steps tried while re-encoding; a bigger value keeps more detail. */
const QUALITIES = [0.85, 0.7, 0.55, 0.4];

/** Picture types the API accepts. */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Reads a file as a data URL.
 *
 * @param file - file the administrator picked
 * @returns the data URL
 */
function readAsDataUrl(file: File): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(new Error("unreadable"));
		reader.readAsDataURL(file);
	});
}

/**
 * Decodes a data URL.
 *
 * @param dataUrl - picture as a data URL
 * @returns the decoded picture
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("unreadable"));
		image.src = dataUrl;
	});
}

/**
 * Prepares a picture for storage: it is scaled down and re-encoded until it fits `maxBytes`.
 *
 * @param file - file the administrator picked
 * @param maxBytes - limit of the data URL (the same value the server checks)
 * @returns the prepared picture, or the reason why it cannot be used
 */
export async function prepareImage(file: File, maxBytes: number): Promise<ImageResult> {
	if (!ACCEPTED_TYPES.includes(file.type)) {
		return { ok: false, problem: "type" };
	}

	let original: string;
	try {
		original = await readAsDataUrl(file);
	} catch {
		return { ok: false, problem: "unreadable" };
	}
	if (original.length <= maxBytes) {
		return { ok: true, image: { dataUrl: original, bytes: original.length, resized: false } };
	}

	let source: HTMLImageElement;
	try {
		source = await loadImage(original);
	} catch {
		return { ok: false, problem: "unreadable" };
	}
	const longest = Math.max(source.width, source.height);
	if (longest === 0) {
		return { ok: false, problem: "unreadable" };
	}

	// step down until the picture fits; the page is filled white so a picture with transparency does not turn black
	for (let dimension = Math.min(longest, MAX_DIMENSION); dimension >= 320; dimension = Math.floor(dimension / 2)) {
		const scale = dimension / longest;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(source.width * scale));
		canvas.height = Math.max(1, Math.round(source.height * scale));
		const context = canvas.getContext("2d");
		if (!context) {
			return { ok: false, problem: "unreadable" };
		}
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(source, 0, 0, canvas.width, canvas.height);

		for (const quality of QUALITIES) {
			const encoded = canvas.toDataURL("image/jpeg", quality);
			if (encoded.length <= maxBytes) {
				return { ok: true, image: { dataUrl: encoded, bytes: encoded.length, resized: true } };
			}
		}
	}

	return { ok: false, problem: "tooLarge" };
}
