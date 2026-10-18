/**
 * Types, limits and request readers shared by the route modules of the API.
 */

import type { Db } from "../../db/database";
import type { AbsencesRepository } from "../../db/repositories/absences";
import type { AutomationsRepository } from "../../db/repositories/automations";
import type { DayNotesRepository } from "../../db/repositories/dayNotes";
import type { EntriesRepository, EntryDirection, EntryRecord } from "../../db/repositories/entries";
import type { HolidaysRepository } from "../../db/repositories/holidays";
import type { PayoutsRepository } from "../../db/repositories/payouts";
import { type RfidRepository } from "../../db/repositories/rfid";
import type { RulesRepository } from "../../db/repositories/rules";
import type { SettingsRepository } from "../../db/repositories/settings";
import type { TerminalRecord, TerminalsRepository } from "../../db/repositories/terminals";
import type { TriggersRepository } from "../../db/repositories/triggers";
import type { UserRecord, UsersRepository, WorkProfileRecord } from "../../db/repositories/users";
import type { AggregationService } from "../../services/aggregation";
import type { AuthService } from "../../services/auth";
import type { SyncService } from "../../services/sync";
import type { BackupService } from "../../services/backup";
import { z } from "zod";
import { ValidationError, type FieldIssue } from "../../errors";
import { parseBody } from "./validate";
import { SETTING_DEFAULTS } from "../../db/seed";
import { utcToWallTime } from "../../util/time";
import { type EventBus } from "../events";
import { problem } from "../problem";
import { type RouteContext, type Router } from "../router";

/** Data sources of the API. */
export interface ApiDeps {
	/** Open database handle */
	db: Db;
	/** Authentication service */
	auth: AuthService;
	/** User storage */
	users: UsersRepository;
	/** Punch storage */
	entries: EntriesRepository;
	/** Absence storage */
	absences: AbsencesRepository;
	/** Notes the employees leave for the administration */
	dayNotes: DayNotesRepository;
	/** Holiday storage */
	holidays: HolidaysRepository;
	/** Surcharge and break rules */
	rules: RulesRepository;
	/** Paid out overtime */
	payouts: PayoutsRepository;
	/** Kiosk terminals */
	terminals: TerminalsRepository;
	/** RFID/NFC tags */
	rfid: RfidRepository;
	/** Trigger rules: ioBroker states that punch or set the presence */
	triggers: TriggersRepository;
	/** Automation rules: what the adapter does on its own (clock out, reminders) */
	automations: AutomationsRepository;
	/**
	 * Called after the trigger rules were saved, so the adapter watches the new states right away
	 * (`undefined` in tests that do not care).
	 */
	onTriggerRulesChanged?: () => void;
	/** Secret used to sign tag links (`hmacSecret`) */
	hmacSecret?: string;
	/** True when the kiosk terminal is switched on (instance setting) */
	kioskEnabled?: boolean;
	/** Lifetime of a terminal session in minutes; the heartbeat of the device extends it (default 15) */
	terminalSessionMinutes?: number;
	/**
	 * Trusts `x-forwarded-*` of a reverse proxy: the forwarded address is used for the rate limits and the
	 * audit trail, and `x-forwarded-proto: https` makes the session cookie `Secure`.
	 */
	trustProxy?: boolean;
	/** The server itself speaks HTTPS: the session cookie carries `Secure` without a proxy header */
	secureTransport?: boolean;
	/** Aggregation service (reports and refreshes) */
	aggregation: AggregationService;
	/** Offline synchronisation */
	sync: SyncService;
	/** Instance settings */
	settings: SettingsRepository;
	/** Backup service; without it the backup endpoints are not registered */
	backup?: BackupService;
	/** Live event bus; a private one is created when it is not given */
	events?: EventBus;
	/** Instant source, defaults to the system clock */
	now?: () => number;
	/** Version reported by `GET /version` */
	version?: string;
	/**
	 * Allowed login attempts per minute and address. The browser tests sign in once per case, so their harness
	 * raises the shipped limit of 20.
	 */
	loginRateLimit?: number;
}

/** Media type of the Excel export. */
export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Media type of the PDF export. */
export const PDF_CONTENT_TYPE = "application/pdf";

/**
 * Upper bound for an uploaded backup.
 *
 * A backup is the only request that may be bigger than the router-wide body limit, so the restore route raises
 * the limit for itself. The web server reads with the same bound, because the transport refuses a body before
 * any route sees it.
 */
export const MAX_BACKUP_UPLOAD_BYTES = 64 * 1024 * 1024;

/** A registered route (used for the documentation). */
export interface ApiRoute {
	/** HTTP method */
	method: string;
	/** Path pattern */
	path: string;
	/** Permission the route requires */
	permission?: string;
}

/** The API. */
export interface Api {
	/** Router the endpoints are registered on */
	router: Router;
	/** Route table */
	routes(): ApiRoute[];
	/** Bus every change is published on (also used by the WebSocket stream) */
	events: EventBus;
}

/**
 * Reads a required string field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @param maxLength - longest allowed value in characters (the routes that anybody may call set a small one)
 * @returns the trimmed value
 */
export function requireString(body: Record<string, unknown>, field: string, maxLength?: number): string {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) {
		throw new ValidationError(`${field} is required`);
	}
	return limitLength(value.trim(), field, maxLength);
}

/**
 * Refuses a value that is longer than the route allows.
 *
 * @param value - trimmed value
 * @param field - field name for the message
 * @param maxLength - longest allowed value, `undefined` = no limit of its own
 * @returns the value
 */
export function limitLength(value: string, field: string, maxLength: number | undefined): string {
	if (maxLength !== undefined && value.length > maxLength) {
		throw new ValidationError(`${field} is too long (at most ${maxLength} characters)`);
	}
	return value;
}

/**
 * Reads an optional string field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @param maxLength - longest allowed value in characters (the routes that anybody may call set a small one)
 * @returns the trimmed value or `null`
 */
export function optionalString(body: Record<string, unknown>, field: string, maxLength?: number): string | null {
	const value = body[field];
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new ValidationError(`${field} must be a string`);
	}
	const trimmed = value.trim();
	return trimmed ? limitLength(trimmed, field, maxLength) : null;
}

/** Longest login, password, device token, badge, PIN, scan token and note a caller may send without a session. */
export const MAX_LOGIN_LENGTH = 128;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_CODE_LENGTH = 512;
export const MAX_PUBLIC_NOTE_LENGTH = 500;

/**
 * Reads an optional number field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @returns the value or `null`
 */
export function optionalNumber(body: Record<string, unknown>, field: string): number | null {
	const value = body[field];
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ValidationError(`${field} must be a number`);
	}
	return value;
}

/**
 * Settings an administrator must not see through the API, even when they are compatible with the stored form.
 * They are matched case-insensitively and may occur anywhere in the key.
 */
export const SECRET_SETTING_KEYS = ["secret", "password", "token", "hash", "apikey"];

/** Settings whose value may be a nested structure (arrays and objects). */
export const JSON_SETTINGS = ["pause_staffel"];

/** Upper bound of a statistics range: every day of every employee is recalculated. */
export const MAX_STATISTICS_DAYS = 366;

/** Default lifetime of a terminal session; the heartbeat of the device extends it. */
export const TERMINAL_SESSION_MINUTES_DEFAULT = 15;

/** A terminal as it is handed out over the API (without any secret). */
export interface PublicTerminalPayload {
	/** Primary key */
	id: number;
	/** Display name */
	name: string;
	/** Optional location */
	location: string | null;
	/** True when a badge has to be combined with the personal PIN */
	pinRequired: boolean;
	/** False for revoked devices */
	isActive: boolean;
	/** Instant the device token expires, `null` = never */
	expiresAt: number | null;
	/** Instant of the last heartbeat */
	lastSeenAt: number | null;
	/** Instant of creation */
	createdAt: number;
	/** Employees shown on this terminal; an empty list means “all employees” */
	userIds: number[];
}

/**
 * Removes the internals of a terminal record.
 *
 * @param terminal - stored terminal
 * @returns the public part
 */
export function publicTerminal(terminal: TerminalRecord): PublicTerminalPayload {
	return {
		id: terminal.id,
		name: terminal.name,
		location: terminal.location,
		pinRequired: terminal.pinRequired,
		isActive: terminal.isActive,
		expiresAt: terminal.expiresAt,
		lastSeenAt: terminal.lastSeenAt,
		createdAt: terminal.createdAt,
		userIds: terminal.userIds,
	};
}

/**
 * Settings that may be changed through the API: the instance defaults from the seed plus the structured ones.
 *
 * The list is derived from the defaults on purpose — a setting the adapter does not know would silently be
 * ignored by the services, so it is refused instead.
 *
 * @returns editable setting keys
 */
export function editableSettings(): string[] {
	return [...Object.keys(SETTING_DEFAULTS), ...JSON_SETTINGS];
}

/** Settings that a read leaves out: they are large pictures and are delivered by their own routes. */
export const HIDDEN_SETTING_KEYS = ["brand_logo", "brand_background"];

/**
 * Removes settings that look like secrets from a read.
 *
 * @param all - all stored settings
 * @returns the settings that may be shown
 */
export function readableSettings(all: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(all)) {
		const lower = key.toLowerCase();
		if (SECRET_SETTING_KEYS.some(marker => lower.includes(marker))) {
			continue;
		}
		if (HIDDEN_SETTING_KEYS.includes(key)) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

/**
 * Checks whether a value may be stored as a setting.
 *
 * @param value - value from the request body
 * @param allowStructured - true for settings that may hold arrays or objects
 * @returns true when the value is supported
 */
export function isSettingValue(value: unknown, allowStructured: boolean): boolean {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return typeof value !== "number" || Number.isFinite(value);
	}
	if (!allowStructured) {
		return false;
	}
	if (Array.isArray(value)) {
		return value.every(entry => isSettingValue(entry, true));
	}
	return (
		typeof value === "object" &&
		Object.values(value as Record<string, unknown>).every(entry => isSettingValue(entry, true))
	);
}

/**
 * Reads a required boolean field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @returns the value
 */
export function requireBoolean(body: Record<string, unknown>, field: string): boolean {
	const value = optionalBoolean(body, field);
	if (value === null) {
		throw new ValidationError(`${field} is required`);
	}
	return value;
}

/**
 * Reads a year and an optional month from a body or the query.
 *
 * The range matches the validation of the payout repository, so a wrong year is refused by the API before it
 * reaches the storage layer.
 *
 * @param year - raw year
 * @param month - raw month, `null`/empty for the whole year
 * @returns validated year and month
 */
export function readPeriod(year: unknown, month: unknown): { year: number; month: number | null } {
	const parsedYear = Number(year);
	if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
		throw new ValidationError(`year must be a four digit year between 2000 and 2100 (got ${JSON.stringify(year)})`);
	}
	if (month === null || month === undefined || month === "") {
		return { year: parsedYear, month: null };
	}
	const parsedMonth = Number(month);
	if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
		throw new ValidationError(`month must be between 1 and 12 (got ${JSON.stringify(month)})`);
	}
	return { year: parsedYear, month: parsedMonth };
}

/**
 * Reads an optional whole-number query parameter.
 *
 * @param context - route context
 * @param name - parameter name
 * @param fallback - value used when the parameter is missing
 * @returns the parsed number
 */
export function optionalNumberQuery(context: RouteContext, name: string, fallback: number): number {
	const raw = context.query(name);
	if (raw === null) {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new ValidationError(`${name} must be a non-negative whole number (got ${raw})`);
	}
	return value;
}

/**
 * Reads a list of role keys.
 *
 * @param body - parsed request body
 * @returns the role keys or `null` when the field is absent
 */
export function readRoleKeys(body: Record<string, unknown>): string[] | null {
	const value = body.roleKeys;
	if (value === undefined || value === null) {
		return null;
	}
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
		throw new ValidationError("roleKeys must be an array of strings");
	}
	return (value as string[]).map(entry => entry.trim()).filter(entry => entry.length > 0);
}

/**
 * Reads an optional list of user ids (the employees of a terminal).
 *
 * @param body - request body
 * @returns the ids without duplicates, `null` when the field is missing
 */
export function readUserIds(body: Record<string, unknown>): number[] | null {
	const value = body.userIds;
	if (value === undefined || value === null) {
		return null;
	}
	if (!Array.isArray(value) || value.some(entry => !Number.isInteger(entry))) {
		throw new ValidationError("userIds must be an array of whole numbers");
	}
	return [...new Set(value as number[])];
}

/** Fields of a work profile a client may change. */
export const PROFILE_FIELDS: (keyof Omit<WorkProfileRecord, "userId">)[] = [
	"percent",
	"weeklyHours",
	"workdays",
	"startDate",
	"endDate",
	"overtimeCarryover",
	"vorholzeitPerYear",
	"vacationCarryover",
	"vacationPerYear",
	"overtimeModel",
	"holidayFlags",
	"pausePaidMinutes",
	"showWorkedTime",
];

/**
 * A field of a work profile: a value that is not sent stays out of the patch, everything else is read with `Number`
 * (a number in a text counts, as before) and checked.
 *
 * @param test - true when the number is fine
 * @param message - message for a value that fails the test
 * @returns the schema of the field
 */
function profileNumber(test: (value: number) => boolean, message: string): z.ZodType<number | undefined> {
	return z
		.unknown()
		.transform((value, context) => {
			if (value === undefined) {
				return undefined;
			}
			const number = Number(value);
			if (!test(number)) {
				context.addIssue({ code: "custom", message });
				return z.NEVER;
			}
			return number;
		})
		.optional();
}

/** Schema of a work profile patch (unknown fields are refused by `readProfilePatch`, one issue per field). */
const PROFILE_PATCH = z.object({
	// the reason travels with the patch into the audit trail and is not part of the profile
	reason: z.unknown().optional(),
	percent: profileNumber(
		value => Number.isInteger(value) && value >= 0 && value <= 100,
		"must be a whole number between 0 and 100",
	),
	weeklyHours: profileNumber(
		value => Number.isFinite(value) && value >= 0 && value <= 168,
		"must be between 0 and 168",
	),
	workdays: z
		.string({ error: "must be a string of weekdays" })
		.trim()
		.refine(value => /^\d(;\d)*$/.test(value) && !value.split(";").some(day => Number(day) > 6), {
			error: 'must be weekdays separated by ";" (0 = Sunday … 6 = Saturday)',
		})
		.optional(),
	startDate: profileInstant(),
	endDate: profileInstant(),
	overtimeCarryover: profileNumber(Number.isInteger, "must be a whole number of minutes"),
	vorholzeitPerYear: profileNumber(Number.isInteger, "must be a whole number of minutes"),
	vacationCarryover: profileNumber(Number.isInteger, "must be a whole number of minutes"),
	vacationPerYear: profileNumber(Number.isInteger, "must be a whole number of minutes"),
	overtimeModel: z
		.enum(["cumulative", "yearly", "monthly"], { error: "must be cumulative, yearly or monthly" })
		.optional(),
	holidayFlags: z.string({ error: "must be a JSON string or null" }).nullable().optional(),
	// minutes of the break per day that are paid; a whole number, at most a full day
	pausePaidMinutes: profileNumber(
		value => Number.isInteger(value) && value >= 0 && value <= 1440,
		"must be a whole number of minutes between 0 and 1440",
	),
	// whether the presence card shows the worked time of the day for this employee
	showWorkedTime: z.boolean({ error: "must be true or false" }).optional(),
});

/**
 * The start or end of a work profile: an instant in seconds or `null`; a value that is not sent stays out.
 *
 * @returns the schema of the field
 */
function profileInstant(): z.ZodType<number | null | undefined> {
	return z
		.unknown()
		.transform((value, context) => {
			if (value === undefined || value === null) {
				return value;
			}
			const number = Number(value);
			if (!Number.isInteger(number) || number < 0) {
				context.addIssue({ code: "custom", message: "must be an instant in seconds or null" });
				return z.NEVER;
			}
			return number;
		})
		.optional();
}

/**
 * Reads a work profile patch and checks its values.
 *
 * The repository merges the given fields into the stored profile, so every value has to be validated here —
 * a broken profile would silently spoil the target time of every later calculation. Every invalid field is
 * reported (RFC 9457 `errors[]`), so the client sees all problems at once.
 *
 * @param body - parsed request body
 * @returns the patch, only with the fields that were sent
 */
export function readProfilePatch(body: Record<string, unknown>): Partial<Omit<WorkProfileRecord, "userId">> {
	// every invalid field is collected instead of failing on the first one, so the client sees all problems at once
	const issues: FieldIssue[] = Object.keys(body)
		.filter(key => !Object.prototype.hasOwnProperty.call(PROFILE_PATCH.shape, key))
		.map(path => ({ path, message: "unknown field of a work profile" }));
	let parsed: z.output<typeof PROFILE_PATCH> | null = null;
	try {
		parsed = parseBody(PROFILE_PATCH, body);
	} catch (error) {
		if (!(error instanceof ValidationError)) {
			throw error;
		}
		issues.push(...error.fields);
	}
	if (issues.length > 0 || parsed === null) {
		throw new ValidationError(`${issues.length} field(s) of the work profile are not valid`, issues);
	}
	const { reason: _reason, ...patch } = parsed;
	// a field that was not sent must not reach the merge as `undefined`
	return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** A user as it is handed out over the API (without the password hashes). */
export interface PublicUserPayload {
	/** Primary key */
	id: number;
	/** Login name */
	login: string;
	/** Shown name */
	displayName: string;
	/** E-mail address */
	email: string | null;
	/** RFID card id */
	rfidCard: string | null;
	/** False for deactivated accounts */
	isActive: boolean;
	/** True while the user has to set a new password */
	mustChangePw: boolean;
	/** Preferred language */
	locale: string;
	/** Same value as `locale`; the web app reads the language of the session from this field */
	language: string;
	/** IANA time zone */
	timezone: string;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
	/** Instant of the last change, UTC epoch seconds */
	updatedAt: number;
	/** Instant of the last login, `null` if never */
	lastLoginAt: number | null;
	/** Address of the picture of the user, `null` when none is stored (the web app shows a placeholder) */
	avatarUrl: string | null;
}

/**
 * Removes everything a client must not see from a user record.
 *
 * The list is explicit on purpose: a column added later stays invisible until it is added here.
 *
 * @param user - stored user
 * @returns the public part
 */
export function publicUser(user: UserRecord): PublicUserPayload {
	return {
		id: user.id,
		login: user.login,
		displayName: user.displayName,
		email: user.email,
		rfidCard: user.rfidCard,
		isActive: user.isActive,
		mustChangePw: user.mustChangePw,
		locale: user.locale,
		language: user.locale,
		timezone: user.timezone,
		// the picture is served by its own route, so it never travels inside the JSON answer; the version in the
		// query makes the browser fetch it again after a change
		avatarUrl: user.avatar ? `/api/users/${user.id}/avatar?v=${user.updatedAt}` : null,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
		lastLoginAt: user.lastLoginAt,
	};
}

/**
 * Reads an optional boolean field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @returns the value or `null`
 */
export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | null {
	const value = body[field];
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "boolean") {
		throw new ValidationError(`${field} must be a boolean`);
	}
	return value;
}

/**
 * Reads a numeric path parameter.
 *
 * @param context - route context
 * @param name - parameter name
 * @returns the parsed number
 */
export function numberParam(context: RouteContext, name: string): number {
	const raw = context.params[name];
	const value = Number(raw);
	if (!Number.isInteger(value)) {
		throw new ValidationError(`${name} must be a whole number (got ${raw})`);
	}
	return value;
}

/**
 * Reads the day direction of a punch.
 *
 * @param body - parsed request body
 * @returns the direction
 */
export function optionalDirection(body: Record<string, unknown>): EntryDirection {
	const value = optionalString(body, "direction");
	if (value === null) {
		return "auto";
	}
	if (value !== "in" && value !== "out" && value !== "auto") {
		throw new ValidationError(`direction must be in, out or auto (got ${value})`);
	}
	return value;
}

/**
 * Resolves the employee a request refers to and checks the matching permission.
 *
 * @param context - route context with the authenticated caller
 * @param requested - user id from the request, `null` for “the caller”
 * @param ownPermission - permission needed for the own account
 * @param otherPermission - permission needed for another employee
 * @returns the target user id
 */
export function resolveScope(
	context: RouteContext,
	requested: number | null,
	ownPermission: string,
	otherPermission: string,
): number {
	if (!context.auth) {
		throw problem(401, "no_session", "request rejected (no_session)");
	}
	const target = requested ?? context.auth.user.id;
	if (target === context.auth.user.id) {
		return target;
	}
	if (!context.auth.permissions.includes(otherPermission)) {
		throw problem(403, "permission_denied", `request rejected (permission_denied: ${otherPermission})`);
	}
	return target;
}

/**
 * Creates the API.
 *
 * @param deps - data sources
 * @returns API with its router
 */
/**
 * Builds the CSV of the raw punches of one employee.
 *
 * The header is stable and English, because the file is meant for a payroll tool rather than for reading: the
 * separator is a semicolon and the file starts with a UTF-8 byte order mark — that is what a spreadsheet in a
 * European locale expects.
 *
 * @param entries - punches of the employee in chronological order
 * @param timeZone - time zone of the employee, used for the time column
 * @returns the CSV document
 */
export function buildEntriesCsv(entries: EntryRecord[], timeZone: string): Buffer {
	const lines = ["date;time;direction;source;note"];
	for (const entry of entries) {
		const seconds = utcToWallTime(entry.tsUtc, timeZone) % 86_400;
		const hour = String(Math.floor(seconds / 3600)).padStart(2, "0");
		const minute = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
		// a note may carry the separator and quotes: quoting keeps the columns intact
		const note = `"${(entry.note ?? "").replace(/"/g, '""')}"`;
		lines.push([entry.localDate, `${hour}:${minute}`, entry.direction ?? "", entry.source, note].join(";"));
	}
	return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}
