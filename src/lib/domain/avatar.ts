/**
 * Picture of an employee (`users.avatar`).
 *
 * The picture is stored as a data URL (`data:image/png;base64,…`) because it belongs to the account: it travels with
 * a backup and with the synchronisation between two hosts, and no file has to be kept in step with the database.
 * Only the API turns it into an image again (`GET /users/<id>/avatar`), so the JSON payloads stay small.
 *
 * A picture the agent can draw is not required: where none is stored, the web app shows the placeholder image.
 */

/** Content types a picture may have. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** Largest accepted picture (bytes of the decoded image). */
export const MAX_AVATAR_BYTES = 256 * 1024;

/** A checked picture. */
export interface AvatarImage {
	/** Content type of the image */
	contentType: (typeof AVATAR_TYPES)[number];
	/** Base64 payload without the prefix, exactly as the data URL carries it */
	base64: string;
	/** Size of the decoded image in bytes */
	bytes: number;
}

/** Matches a data URL of an image with a base64 payload. */
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i;

/**
 * Checks a data URL that should become the picture of an employee.
 *
 * @param value - value as the administration sent it
 * @returns the checked image, or `null` when the value is not a usable picture
 */
export function parseAvatarDataUrl(value: string): AvatarImage | null {
	const match = DATA_URL.exec(value.trim());
	if (!match) {
		return null;
	}

	const contentType = match[1].toLowerCase();
	if (!(AVATAR_TYPES as readonly string[]).includes(contentType)) {
		return null;
	}

	// the payload is the decoded image: 4 base64 characters carry 3 bytes, and padding shrinks it
	const base64 = match[2].replace(/[\r\n]/g, "");
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	const bytes = Math.floor((base64.length * 3) / 4) - padding;
	if (bytes <= 0 || bytes > MAX_AVATAR_BYTES) {
		return null;
	}

	return { contentType: contentType as AvatarImage["contentType"], base64, bytes };
}

/**
 * Turns a stored data URL into an image and its content type.
 *
 * @param stored - value as it stands in the database
 * @returns the image, or `null` when nothing usable is stored
 */
export function readAvatar(stored: string | null | undefined): AvatarImage | null {
	if (!stored) {
		return null;
	}
	return parseAvatarDataUrl(stored);
}
