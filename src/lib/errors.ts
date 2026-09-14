/**
 * Error types shared by the domain, the storage layer and the web layer.
 *
 * The web layer maps them onto HTTP status codes, so a caller always gets the right status without guessing
 * from a message. Anything that is **not** one of these types is treated as an internal error (`500`) and its
 * message is never exposed.
 */

/** Input that the caller can correct (missing field, wrong format, value out of range). */
export class ValidationError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param message - explanation that is safe to show to the caller
	 */
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** A record the caller referred to does not exist (anymore). */
export class NotFoundError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param message - explanation that is safe to show to the caller
	 */
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}
