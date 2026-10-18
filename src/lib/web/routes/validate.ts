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

/**
 * A required finite number.
 *
 * @param missing - message for a missing value, default `<field> is required`
 * @returns the field rule
 */
export function requiredNumber(missing?: string): FieldRule<z.ZodType<number>> {
	return field =>
		z.number({
			error: issue =>
				issue.input === undefined || issue.input === null
					? (missing ?? `${field} is required`)
					: `${field} must be a number`,
		});
}

/**
 * The direction of a punch: `in`, `out` or `auto`; missing or blank means `auto`.
 *
 * @returns the field rule
 */
export function punchDirection(): FieldRule<z.ZodType<"in" | "out" | "auto">> {
	return field =>
		z
			.string({ error: `${field} must be a string` })
			.trim()
			.nullish()
			.transform((value, context) => {
				if (!value) {
					return "auto" as const;
				}
				if (value !== "in" && value !== "out" && value !== "auto") {
					context.addIssue({ code: "custom", message: `${field} must be in, out or auto (got ${value})` });
					return z.NEVER;
				}
				return value;
			});
}

/**
 * Writes a list of allowed values the way the messages name them: `accept or dismiss`, `in, out or auto`.
 *
 * @param values - allowed values
 * @returns the readable list
 */
function choices(values: readonly string[]): string {
	return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/**
 * A required text that must be one of the given values.
 *
 * @param values - allowed values
 * @returns the field rule
 */
export function requiredChoice<const V extends readonly [string, ...string[]]>(
	values: V,
): FieldRule<z.ZodType<V[number]>> {
	return field =>
		requiredText()(field).transform((value, context) => {
			if (!(values as readonly string[]).includes(value)) {
				context.addIssue({ code: "custom", message: `${field} must be ${choices(values)} (got ${value})` });
				return z.NEVER;
			}
			return value;
		});
}

/**
 * A list whose items follow the given schema.
 *
 * @param item - schema of one item
 * @returns the field rule
 */
export function listOf<T extends z.ZodType>(item: T): FieldRule<z.ZodArray<T>> {
	return field => z.array(item, { error: `${field} must be an array` });
}

/**
 * An object inside a list; a missing item (`null`) counts as an empty object, so its fields report what is missing.
 *
 * @param rules - one rule per field
 * @returns the schema of one item
 */
export function itemOf<R extends Record<string, FieldRule>>(rules: R): z.ZodType<z.output<z.ZodObject<ShapeOf<R>>>> {
	return z.preprocess(value => value ?? {}, bodySchema(rules));
}

/**
 * A text that is taken when it is one and replaced by an empty text otherwise (an identifier a client may leave out).
 *
 * @returns the field rule
 */
export function lenientText(): FieldRule<z.ZodType<string>> {
	return () => z.unknown().transform(value => (typeof value === "string" ? value : ""));
}
