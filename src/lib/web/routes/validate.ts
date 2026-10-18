/**
 * Declarative checks of request bodies with zod.
 *
 * A route describes its body as an object of field rules; `parseBody` checks the body against it and returns the
 * typed values. A rule receives the name of its field, so every message names the field the caller has to fix —
 * the wording is the one the hand-written readers of `shared.ts` used, so a client sees the same messages as before.
 *
 * Every invalid field is reported in `errors[]` (RFC 9457); the message of the problem is the one of the first
 * field, in the order the rules are written.
 */

import { z } from "zod";
import { ValidationError, type FieldIssue } from "../../errors";

/** A field rule: builds the zod schema of one field from its name (the name goes into the messages). */
export type FieldRule<T extends z.ZodType = z.ZodType> = (field: string) => T;

/** The schemas a set of field rules produces. */
type ShapeOf<R extends Record<string, FieldRule>> = { [K in keyof R]: ReturnType<R[K]> };

/**
 * Builds the schema of a request body from field rules.
 *
 * Fields the rules do not name are ignored, as the readers did before.
 *
 * @param rules - one rule per field
 * @returns the object schema
 */
export function bodySchema<R extends Record<string, FieldRule>>(rules: R): z.ZodObject<ShapeOf<R>> {
	const shape = {} as ShapeOf<R>;
	for (const key of Object.keys(rules) as (keyof R & string)[]) {
		shape[key] = rules[key](key) as ShapeOf<R>[typeof key];
	}
	return z.object(shape);
}

/**
 * Writes the path of an issue the way the API reports it: `entries[2].tsUtc`.
 *
 * @param path - path of the zod issue
 * @returns the readable path
 */
function issuePath(path: readonly PropertyKey[]): string {
	let out = "";
	for (const part of path) {
		if (typeof part === "number") {
			out += `[${part}]`;
		} else {
			out += out ? `.${String(part)}` : String(part);
		}
	}
	return out;
}

/**
 * Checks a request body against a schema.
 *
 * @param schema - schema of the body (usually from `bodySchema`)
 * @param body - parsed JSON body
 * @returns the checked and normalised values
 */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
	const result = schema.safeParse(body);
	if (result.success) {
		return result.data;
	}
	const fields: FieldIssue[] = result.error.issues.map(issue => ({
		path: issuePath(issue.path),
		message: issue.message,
	}));
	throw new ValidationError(fields[0]?.message ?? "the request is not valid", fields);
}

/**
 * A required text: trimmed, not empty, optionally limited in length.
 *
 * @param maxLength - longest allowed value in characters
 * @returns the field rule
 */
export function requiredText(maxLength?: number): FieldRule<z.ZodType<string>> {
	return field => {
		const required = `${field} is required`;
		let schema = z.string({ error: required }).trim().min(1, { error: required });
		if (maxLength !== undefined) {
			schema = schema.max(maxLength, { error: `${field} is too long (at most ${maxLength} characters)` });
		}
		return schema;
	};
}

/**
 * An optional text: trimmed; missing, `null` or blank becomes `null`.
 *
 * @param maxLength - longest allowed value in characters
 * @returns the field rule
 */
export function optionalText(maxLength?: number): FieldRule<z.ZodType<string | null>> {
	return field => {
		let schema = z.string({ error: `${field} must be a string` }).trim();
		if (maxLength !== undefined) {
			schema = schema.max(maxLength, { error: `${field} is too long (at most ${maxLength} characters)` });
		}
		return schema.nullish().transform(value => (value ? value : null));
	};
}

/**
 * An optional finite number; missing or `null` becomes `null`.
 *
 * @returns the field rule
 */
export function optionalNumber(): FieldRule<z.ZodType<number | null>> {
	return field =>
		z
			.number({ error: `${field} must be a number` })
			.nullish()
			.transform(value => value ?? null);
}

/**
 * A required boolean.
 *
 * @returns the field rule
 */
export function requiredFlag(): FieldRule<z.ZodType<boolean>> {
	return field =>
		z.boolean({
			// a missing value is missing, a value of the wrong kind is wrong
			error: issue =>
				issue.input === undefined || issue.input === null
					? `${field} is required`
					: `${field} must be a boolean`,
		});
}

/**
 * An optional boolean; missing or `null` becomes `null`.
 *
 * @returns the field rule
 */
export function optionalFlag(): FieldRule<z.ZodType<boolean | null>> {
	return field =>
		z
			.boolean({ error: `${field} must be a boolean` })
			.nullish()
			.transform(value => value ?? null);
}
