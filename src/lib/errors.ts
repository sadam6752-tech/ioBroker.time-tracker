/**
 * Error types shared by the domain, the storage layer and the web layer.
 *
 * The web layer maps them onto HTTP status codes, so a caller always gets the right status without guessing
 * from a message. Anything that is **not** one of these types is treated as an internal error (`500`) and its
 * message is never exposed.
 */

/** One field that the caller has to correct. */
export interface FieldIssue {
	/** Path of the field, e.g. `percent` or `entries[2].tsUtc` */
	path: string;
	/** What is wrong with it */
	message: string;
}

/** Input that the caller can correct (missing field, wrong format, value out of range). */
export class ValidationError extends Error {
	/** Issues per field, empty when the message alone describes the problem */
	public readonly fields: FieldIssue[];

	/**
	 * Creates the error.
	 *
	 * @param message - explanation that is safe to show to the caller
	 * @param fields - optional list of invalid fields (RFC 9457 `errors[]`)
	 */
	constructor(message: string, fields: FieldIssue[] = []) {
		super(message);
		this.name = "ValidationError";
		this.fields = fields;
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
