/**
 * `application/problem+json` responses (RFC 7807) with stable machine readable codes.
 *
 * Expected failures are raised as `HttpProblem` by the route handlers. Errors from the domain and storage
 * layers are mapped here, so a client always receives the same shape:
 *
 * ```
 * { "type": "about:blank", "title": "Not Found", "status": 404, "code": "not_found", "detail": "…" }
 * ```
 *
 * Messages of unknown errors are **not** exposed (they may contain internals); they are logged by the caller.
 */

import { RevisionConflictError } from "../db/repositories/entries";
import { LoginExistsError, UnknownRoleError } from "../db/repositories/users";
import { UnknownAbsenceTypeError } from "../db/repositories/absences";
import { NotFoundError, ValidationError, type FieldIssue } from "../errors";

/** The content type every problem document is sent with (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";

/** Stable error codes of the API. */
export type ProblemCode =
	| "bad_request"
	| "invalid_credentials"
	| "locked_out"
	| "no_session"
	| "session_expired"
	| "user_inactive"
	| "permission_denied"
	| "csrf_rejected"
	| "not_found"
	| "method_not_allowed"
	| "conflict"
	| "revision_conflict"
	| "payload_too_large"
	| "unsupported_media_type"
	| "kiosk_disabled"
	| "not_configured"
	| "report_font_missing"
	| "import_mismatch"
	| "rate_limited"
	| "internal_error";

/** A problem document. */
export interface ProblemDetails {
	/** URI reference identifying the problem type (always `about:blank` here) */
	type: string;
	/** Short, human readable summary */
	title: string;
	/** HTTP status code */
	status: number;
	/** Stable machine readable code */
	code: ProblemCode;
	/** Explanation of this occurrence */
	detail?: string;
	/** Request path the problem occurred on */
	instance?: string;
	/** Invalid fields of a validation failure (RFC 9457) */
	errors?: { path: string; message: string }[];
}

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	413: "Payload Too Large",
	415: "Unsupported Media Type",
	423: "Locked",
	429: "Too Many Requests",
	500: "Internal Server Error",
};

/** An error that is returned to the client as `application/problem+json`. */
export class HttpProblem extends Error {
	/** Title used in the problem document. */
	public readonly problemTitle: string;

	/**
	 * Creates the error.
	 *
	 * @param status - HTTP status code
	 * @param code - stable error code
	 * @param detail - optional explanation
	 * @param title - optional title (defaults to the reason phrase of the status)
	 * @param fields - optional list of invalid fields
	 */
	constructor(
		public readonly status: number,
		public readonly code: ProblemCode,
		public readonly detail?: string,
		title?: string,
		public readonly fields: FieldIssue[] = [],
	) {
		super(`${status} ${code}${detail ? `: ${detail}` : ""}`);
		this.name = "HttpProblem";
		this.problemTitle = title ?? TITLES[status] ?? "Error";
	}

	/**
	 * Converts the error into a problem document.
	 *
	 * @param instance - request path the problem occurred on
	 * @returns problem document
	 */
	public toProblem(instance?: string): ProblemDetails {
		return {
			type: "about:blank",
			title: this.problemTitle,
			status: this.status,
			code: this.code,
			...(this.detail ? { detail: this.detail } : {}),
			...(this.fields.length > 0
				? { errors: this.fields.map(field => ({ path: field.path, message: field.message })) }
				: {}),
			...(instance ? { instance } : {}),
		};
	}
}

/**
 * Short helper for the common cases.
 *
 * @param status - HTTP status code
 * @param code - stable error code
 * @param detail - optional explanation
 * @returns the problem error
 */
export function problem(status: number, code: ProblemCode, detail?: string): HttpProblem {
	return new HttpProblem(status, code, detail);
}

/**
 * Maps an arbitrary error onto a problem document.
 *
 * Known domain errors keep their meaning (a stale revision is a `409`, a duplicate login a `409`); messages of
 * unknown errors are replaced by a generic text, so no internals leak into the response.
 *
 * @param error - error thrown by a handler or a service
 * @param instance - request path
 * @returns problem document and a flag telling whether this is an unexpected (server side) failure
 */
export function toProblem(error: unknown, instance?: string): { problem: ProblemDetails; unexpected: boolean } {
	if (error instanceof HttpProblem) {
		return { problem: error.toProblem(instance), unexpected: false };
	}
	if (error instanceof ValidationError) {
		return {
			problem: new HttpProblem(400, "bad_request", error.message, undefined, error.fields).toProblem(instance),
			unexpected: false,
		};
	}
	if (error instanceof NotFoundError) {
		return { problem: new HttpProblem(404, "not_found", error.message).toProblem(instance), unexpected: false };
	}
	if (error instanceof RevisionConflictError) {
		return {
			problem: new HttpProblem(
				409,
				"revision_conflict",
				`the record was changed by someone else (current revision ${error.current.revision})`,
			).toProblem(instance),
			unexpected: false,
		};
	}
	if (error instanceof LoginExistsError || error instanceof UnknownRoleError) {
		return { problem: new HttpProblem(409, "conflict", error.message).toProblem(instance), unexpected: false };
	}
	if (error instanceof UnknownAbsenceTypeError) {
		return { problem: new HttpProblem(400, "bad_request", error.message).toProblem(instance), unexpected: false };
	}

	return {
		problem: new HttpProblem(500, "internal_error", "the request could not be processed").toProblem(instance),
		unexpected: true,
	};
}
