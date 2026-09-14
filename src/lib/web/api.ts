/**
 * REST API of the adapter.
 *
 * The endpoints are registered on the server agnostic router, so the same table can later be mounted on an own
 * HTTP server (`native.port`) or handed to the web extension of a `web` instance.
 *
 * Conventions:
 *  - the paths follow the API specification (section 4): `/auth/...`, `/punch...`, `/entries...`, `/absences...`,
 *    `/aggregates/{day,month,year}`; the server mounts all of them below the prefix `/api`;
 *  - the session token travels in the `x-session-token` header, the CSRF token in `x-csrf-token`;
 *  - `?userId=` selects another employee and requires the matching `…_other` permission (otherwise the caller
 *    only sees their own data);
 *  - every write answers with the stored record and, where it matters, with the refreshed aggregates;
 *  - reads recalculate the requested period, so a report is always up to date.
 */

import type { Db } from "../db/database";
import type { AbsencesRepository, AbsenceRecord } from "../db/repositories/absences";
import type { EntriesRepository, EntryDirection } from "../db/repositories/entries";
import type { HolidaysRepository } from "../db/repositories/holidays";
import type { PayoutsRepository } from "../db/repositories/payouts";
import type { RulesRepository } from "../db/repositories/rules";
import type { SettingsRepository, SettingValue } from "../db/repositories/settings";
import type { TerminalRecord, TerminalsRepository } from "../db/repositories/terminals";
import type { UserRecord, UsersRepository, WorkProfileRecord } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import type { AuthService } from "../services/auth";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../services/auth";
import type { SyncService } from "../services/sync";
import { NotFoundError, ValidationError } from "../errors";
import { SETTING_DEFAULTS } from "../db/seed";
import { roundToStep } from "../domain/punch";
import { dateRange, isValidTimeZone, localDate } from "../util/time";
import { problem, toProblem } from "./problem";
import {
	createRouter,
	json,
	noContent,
	type HttpMethod,
	type RouteContext,
	type RouteResponse,
	type Router,
} from "./router";

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
	/** Holiday storage */
	holidays: HolidaysRepository;
	/** Surcharge and break rules */
	rules: RulesRepository;
	/** Paid out overtime */
	payouts: PayoutsRepository;
	/** Kiosk terminals */
	terminals: TerminalsRepository;
	/** True when the kiosk terminal is switched on (instance setting) */
	kioskEnabled?: boolean;
	/** Aggregation service (reports and refreshes) */
	aggregation: AggregationService;
	/** Offline synchronisation */
	sync: SyncService;
	/** Instance settings */
	settings: SettingsRepository;
	/** Instant source, defaults to the system clock */
	now?: () => number;
	/** Version reported by `GET /version` */
	version?: string;
}

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
}

/**
 * Reads a required string field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @returns the trimmed value
 */
function requireString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) {
		throw new ValidationError(`${field} is required`);
	}
	return value.trim();
}

/**
 * Reads an optional string field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @returns the trimmed value or `null`
 */
function optionalString(body: Record<string, unknown>, field: string): string | null {
	const value = body[field];
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new ValidationError(`${field} must be a string`);
	}
	return value.trim() || null;
}

/**
 * Reads an optional number field.
 *
 * @param body - parsed request body
 * @param field - field name
 * @returns the value or `null`
 */
function optionalNumber(body: Record<string, unknown>, field: string): number | null {
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
const SECRET_SETTING_KEYS = ["secret", "password", "token", "hash", "apikey"];

/** Settings whose value may be a nested structure (arrays and objects). */
const JSON_SETTINGS = ["pause_staffel"];

/** Upper bound of a statistics range: every day of every employee is recalculated. */
const MAX_STATISTICS_DAYS = 366;

/** Lifetime of a terminal session; the heartbeat of the device extends it. */
const TERMINAL_SESSION_MINUTES = 15;

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
}

/**
 * Removes the internals of a terminal record.
 *
 * @param terminal - stored terminal
 * @returns the public part
 */
function publicTerminal(terminal: TerminalRecord): PublicTerminalPayload {
	return {
		id: terminal.id,
		name: terminal.name,
		location: terminal.location,
		pinRequired: terminal.pinRequired,
		isActive: terminal.isActive,
		expiresAt: terminal.expiresAt,
		lastSeenAt: terminal.lastSeenAt,
		createdAt: terminal.createdAt,
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
function editableSettings(): string[] {
	return [...Object.keys(SETTING_DEFAULTS), ...JSON_SETTINGS];
}

/**
 * Removes settings that look like secrets from a read.
 *
 * @param all - all stored settings
 * @returns the settings that may be shown
 */
function readableSettings(all: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(all)) {
		const lower = key.toLowerCase();
		if (SECRET_SETTING_KEYS.some(marker => lower.includes(marker))) {
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
function isSettingValue(value: unknown, allowStructured: boolean): boolean {
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
function requireBoolean(body: Record<string, unknown>, field: string): boolean {
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
function readPeriod(year: unknown, month: unknown): { year: number; month: number | null } {
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
function optionalNumberQuery(context: RouteContext, name: string, fallback: number): number {
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
function readRoleKeys(body: Record<string, unknown>): string[] | null {
	const value = body.roleKeys;
	if (value === undefined || value === null) {
		return null;
	}
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
		throw new ValidationError("roleKeys must be an array of strings");
	}
	return (value as string[]).map(entry => entry.trim()).filter(entry => entry.length > 0);
}

/** Fields of a work profile a client may change. */
const PROFILE_FIELDS: (keyof Omit<WorkProfileRecord, "userId">)[] = [
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
];

/**
 * Reads a work profile patch and checks its values.
 *
 * The repository merges the given fields into the stored profile, so every value has to be validated here —
 * a broken profile would silently spoil the target time of every later calculation.
 *
 * @param body - parsed request body
 * @returns the patch
 */
function readProfilePatch(body: Record<string, unknown>): Partial<Omit<WorkProfileRecord, "userId">> {
	const patch: Partial<Omit<WorkProfileRecord, "userId">> = {};
	for (const [key, value] of Object.entries(body)) {
		if (key === "reason") {
			continue;
		}
		if (!(PROFILE_FIELDS as string[]).includes(key)) {
			throw new ValidationError(`"${key}" is not part of a work profile`);
		}

		if (key === "percent") {
			const percent = Number(value);
			if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
				throw new ValidationError("percent must be a whole number between 0 and 100");
			}
			patch.percent = percent;
		} else if (key === "weeklyHours") {
			const hours = Number(value);
			if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
				throw new ValidationError("weeklyHours must be between 0 and 168");
			}
			patch.weeklyHours = hours;
		} else if (key === "workdays") {
			if (typeof value !== "string") {
				throw new ValidationError("workdays must be a string");
			}
			const workdays = value.trim();
			if (!/^\d(;\d)*$/.test(workdays) || workdays.split(";").some(day => Number(day) > 6)) {
				throw new ValidationError('workdays must be weekdays separated by ";" (0 = Sunday … 6 = Saturday)');
			}
			patch.workdays = workdays;
		} else if (key === "overtimeModel") {
			if (value !== "cumulative" && value !== "yearly" && value !== "monthly") {
				throw new ValidationError(`overtimeModel must be cumulative, yearly or monthly (got ${String(value)})`);
			}
			patch.overtimeModel = value;
		} else if (key === "startDate" || key === "endDate") {
			if (value !== null && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
				throw new ValidationError(`${key} must be an instant in seconds or null`);
			}
			patch[key] = value === null ? null : Number(value);
		} else if (key === "holidayFlags") {
			if (value !== null && typeof value !== "string") {
				throw new ValidationError("holidayFlags must be a JSON string or null");
			}
			patch.holidayFlags = value;
		} else {
			const number = Number(value);
			if (!Number.isInteger(number)) {
				throw new ValidationError(`${key} must be a whole number of minutes`);
			}
			patch[key as "overtimeCarryover" | "vorholzeitPerYear" | "vacationCarryover" | "vacationPerYear"] = number;
		}
	}
	return patch;
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
	/** IANA time zone */
	timezone: string;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
	/** Instant of the last change, UTC epoch seconds */
	updatedAt: number;
	/** Instant of the last login, `null` if never */
	lastLoginAt: number | null;
}

/**
 * Removes everything a client must not see from a user record.
 *
 * The list is explicit on purpose: a column added later stays invisible until it is added here.
 *
 * @param user - stored user
 * @returns the public part
 */
function publicUser(user: UserRecord): PublicUserPayload {
	return {
		id: user.id,
		login: user.login,
		displayName: user.displayName,
		email: user.email,
		rfidCard: user.rfidCard,
		isActive: user.isActive,
		mustChangePw: user.mustChangePw,
		locale: user.locale,
		timezone: user.timezone,
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
function optionalBoolean(body: Record<string, unknown>, field: string): boolean | null {
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
function numberParam(context: RouteContext, name: string): number {
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
function optionalDirection(body: Record<string, unknown>): EntryDirection {
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
function resolveScope(
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
export function createApi(deps: ApiDeps): Api {
	const { auth, users, entries, absences, holidays, rules, payouts, terminals, aggregation, sync, settings } = deps;
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const registered: ApiRoute[] = [];
	const router = createRouter({ auth, now });

	/**
	 * Registers a route and remembers it for the documentation.
	 *
	 * @param method - HTTP method(s)
	 * @param path - path pattern
	 * @param routeSettings - permission and visibility of the route
	 * @param routeSettings.permission - permission required
	 * @param routeSettings.public - true when no session is needed
	 * @param routeSettings.csrf - true when a CSRF token is required, false to skip it
	 * @param handler - handler of the route
	 */
	const route = (
		method: HttpMethod | HttpMethod[],
		path: string,
		routeSettings: { permission?: string; public?: boolean; csrf?: boolean },
		handler: (context: RouteContext) => ReturnType<Parameters<Router["add"]>[0]["handler"]>,
	): void => {
		const methods = Array.isArray(method) ? method : [method];
		for (const entry of methods) {
			registered.push({
				method: entry,
				path,
				...(routeSettings.permission ? { permission: routeSettings.permission } : {}),
			});
		}
		router.add({
			method,
			path,
			permission: routeSettings.permission,
			requiresAuth: routeSettings.public !== true,
			requiresCsrf: routeSettings.csrf,
			handler,
		});
	};

	// authentication

	route("POST", "/auth/login", { public: true, csrf: false }, context => {
		const body = context.jsonBody();
		const result = auth.login({
			login: requireString(body, "login"),
			password: requireString(body, "password"),
			userAgent: context.header("user-agent"),
			ip: context.request.remoteAddress ?? null,
			now: now(),
		});

		if (!result.ok) {
			throw problem(
				result.error === "locked_out" ? 423 : 401,
				result.error,
				result.error === "locked_out"
					? "too many failed attempts, try again later"
					: "login or password is not correct",
			);
		}
		return json(200, {
			token: result.token,
			csrfToken: result.csrfToken,
			expiresAt: result.expiresAt,
			user: result.user,
		});
	});

	route("POST", "/auth/logout", { csrf: true }, context => {
		auth.logout({
			token: context.header("x-session-token") ?? "",
			actorId: context.auth?.user.id ?? null,
			ip: context.request.remoteAddress ?? null,
			now: now(),
		});
		return noContent();
	});

	route("GET", "/auth/me", {}, context =>
		json(200, {
			user: context.auth?.user,
			permissions: context.auth?.permissions ?? [],
			expiresAt: context.auth?.expiresAt,
		}),
	);

	route("POST", "/auth/password", { csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const password = requireString(context.jsonBody(), "password");

		auth.setPassword({ userId: context.auth.user.id, password, actorId: context.auth.user.id, now: now() });
		// a password change ends all running sessions, including this one
		auth.revokeSessions({ userId: context.auth.user.id, actorId: context.auth.user.id, now: now() });
		return noContent();
	});

	// A session is renewed on every authenticated request (sliding renewal), so this route reports the current
	// expiry together with a fresh CSRF token; integration clients use it instead of repeating their login.
	route("POST", "/auth/refresh", { csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const token = context.header("x-session-token") ?? "";
		return json(200, {
			expiresAt: context.auth.expiresAt,
			csrfToken: auth.csrfToken(token),
			user: context.auth.user,
			permissions: context.auth.permissions,
		});
	});

	// punching

	/**
	 * Resolves the employee a read request refers to from `?userId=`.
	 *
	 * @param context - route context with the authenticated caller
	 * @param ownPermission - permission needed for the own account
	 * @param otherPermission - permission needed for another employee
	 * @returns the target user id
	 */
	const scopeUser = (
		context: RouteContext,
		ownPermission = "report.view_own",
		otherPermission = "report.view_other",
	): number => {
		const raw = context.query("userId");
		return resolveScope(context, raw ? Number(raw) : null, ownPermission, otherPermission);
	};

	/**
	 * Reads a required whole-number query parameter.
	 *
	 * @param context - route context
	 * @param name - parameter name
	 * @returns the parsed number
	 */
	const numberQuery = (context: RouteContext, name: string): number => {
		const raw = context.query(name);
		const value = Number(raw);
		// a missing parameter is `null`, which would silently become `0`
		if (raw === null || raw.trim() === "" || !Number.isInteger(value)) {
			throw new ValidationError(`${name} is required and must be a whole number`);
		}
		return value;
	};

	/**
	 * Stores a punch of the caller and refreshes the day aggregate.
	 *
	 * @param context - route context with the authenticated caller
	 * @param options - options of the punch
	 * @param options.quick - true rounds the instant to the configured quicktime step
	 * @returns response with the stored entry and the refreshed day
	 */
	const punch = (context: RouteContext, options: { quick: boolean }): RouteResponse => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const timestamp = now();
		const user = users.findById(context.auth.user.id);
		if (!user) {
			throw new NotFoundError(`user ${context.auth.user.id} not found`);
		}

		const requestedTs = optionalNumber(body, "tsUtc") ?? timestamp;
		const quickRoundMinutes = options.quick ? settings.getNumber("quick_round_minutes", 0) : 0;
		const tsUtc = quickRoundMinutes > 0 ? roundToStep(requestedTs, quickRoundMinutes, user.timezone) : requestedTs;

		const stored = entries.insert({
			userId: user.id,
			tsUtc,
			clientTsUtc: optionalNumber(body, "clientTsUtc"),
			timeZone: user.timezone,
			source: "web",
			direction: optionalDirection(body),
			idempotencyKey: optionalString(body, "idempotencyKey"),
			note: optionalString(body, "note"),
			actorId: user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: timestamp,
		});

		const day = aggregation.recalculateDay(user.id, stored.entry.localDate, { now: timestamp });
		return json(
			201,
			{
				entry: stored.entry,
				created: stored.created,
				day,
				...(quickRoundMinutes > 0
					? { rounded: { from: requestedTs, to: tsUtc, roundMinutes: quickRoundMinutes } }
					: {}),
			},
			{ location: `/entries/${stored.entry.id}` },
		);
	};

	route("POST", "/punch", { permission: "time.punch", csrf: true }, context => punch(context, { quick: false }));

	route("POST", "/punch/quick", { permission: "time.punch", csrf: true }, context => punch(context, { quick: true }));

	route("GET", "/punch/status", { permission: "report.view_own" }, context => {
		const userId = scopeUser(context);
		const user = users.findById(userId);
		if (!user) {
			throw new NotFoundError(`user ${userId} not found`);
		}

		const date = localDate(now(), user.timezone);
		const day = aggregation.recalculateDay(userId, date, { now: now() });
		const todayEntries = entries.listByRange(userId, date, date);
		return json(200, {
			date,
			day,
			hasOpenEntry: day.hasOpenEntry,
			lastEntry: todayEntries.length > 0 ? todayEntries[todayEntries.length - 1] : null,
			// what a punch would do right now, so a client does not have to derive it
			nextDirection: day.hasOpenEntry ? "out" : "in",
		});
	});

	// offline synchronisation

	route("POST", "/entries/sync", { permission: "time.punch", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const user = users.findById(context.auth.user.id);
		if (!user) {
			throw new NotFoundError(`user ${context.auth.user.id} not found`);
		}
		if (!Array.isArray(body.punches)) {
			throw new ValidationError("punches must be an array");
		}

		const result = sync.sync({
			userId: user.id,
			timeZone: user.timezone,
			punches: (body.punches as unknown[]).map(raw => {
				const punch = (raw ?? {}) as Record<string, unknown>;
				const tsUtc = optionalNumber(punch, "tsUtc");
				if (tsUtc === null) {
					throw new ValidationError("tsUtc is required for every queued punch");
				}
				return {
					idempotencyKey: typeof punch.idempotencyKey === "string" ? punch.idempotencyKey : "",
					tsUtc,
					clientTsUtc: optionalNumber(punch, "clientTsUtc"),
					direction: optionalDirection(punch),
					note: optionalString(punch, "note"),
				};
			}),
			actorId: user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, result);
	});

	route("GET", "/entries/conflicts", { permission: "time.resolve_conflict" }, context =>
		json(200, { conflicts: sync.conflicts(context.auth?.user.id ?? 0) }),
	);

	route("POST", "/entries/:id/resolve", { permission: "time.resolve_conflict", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const action = requireString(body, "action");
		if (action !== "accept" && action !== "dismiss") {
			throw new ValidationError(`action must be accept or dismiss (got ${action})`);
		}

		const result = sync.resolve({
			entryId: numberParam(context, "id"),
			action,
			tsUtc: optionalNumber(body, "tsUtc") ?? undefined,
			reason: optionalString(body, "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, result);
	});

	// aggregates and reports

	route("GET", "/aggregates/day", { permission: "report.view_own" }, context => {
		const userId = scopeUser(context);
		const from = context.query("from");
		const to = context.query("to") ?? from;

		// a range lists the single days (used by the calendar of the web app)
		if (from && to) {
			const range = aggregation.recalculateRange(userId, from, to, { now: now() });
			return json(200, { from, to, ...range, days: aggregation.days(userId, from, to) });
		}

		const user = users.findById(userId);
		if (!user) {
			throw new NotFoundError(`user ${userId} not found`);
		}
		const date = context.query("date") ?? localDate(now(), user.timezone);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			throw new ValidationError(`date must be YYYY-MM-DD (got ${date})`);
		}
		return json(200, { day: aggregation.recalculateDay(userId, date, { now: now() }) });
	});

	route("GET", "/aggregates/month", { permission: "report.view_own" }, context => {
		const userId = scopeUser(context);
		const year = numberQuery(context, "year");

		const requestedMonth = context.query("month");
		if (!requestedMonth) {
			// the whole year: one recalculation pass, then the twelve monthly rows
			const totals = aggregation.recalculateYear(userId, year, { now: now() });
			const months = Array.from({ length: 12 }, (_, index) => aggregation.month(userId, year, index + 1));
			return json(200, { year: totals, months });
		}

		const month = Number(requestedMonth);
		if (!Number.isInteger(month) || month < 1 || month > 12) {
			throw new ValidationError(`month must be between 1 and 12 (got ${requestedMonth})`);
		}
		const monthly = aggregation.recalculateMonth(userId, year, month, { now: now() });
		const yearly = aggregation.recalculateYear(userId, year, { now: now() });
		return json(200, { month: monthly, year: yearly });
	});

	route("GET", "/aggregates/year", { permission: "report.view_own" }, context => {
		const userId = scopeUser(context);
		const year = numberQuery(context, "year");
		return json(200, { year: aggregation.recalculateYear(userId, year, { now: now() }) });
	});

	route("GET", "/entries", { permission: "report.view_own" }, context => {
		const userId = scopeUser(context);
		const from = context.query("from");
		const to = context.query("to") ?? from;
		if (!from || !to) {
			throw new ValidationError("from and to are required");
		}
		return json(200, { entries: entries.listByRange(userId, from, to) });
	});

	route("POST", "/entries", { permission: "time.edit_own", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const target = Number(context.query("userId") ?? context.auth.user.id);
		if (!Number.isInteger(target)) {
			throw new ValidationError("userId must be a whole number");
		}
		// adding a punch for someone else is an administrative correction
		const own = target === context.auth.user.id;
		if (!own && !context.auth.permissions.includes("time.edit_other")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: time.edit_other)");
		}

		const user = users.findById(target);
		if (!user) {
			throw new NotFoundError(`user ${target} not found`);
		}
		const tsUtc = optionalNumber(body, "tsUtc");
		if (tsUtc === null) {
			throw new ValidationError("tsUtc is required");
		}

		const timestamp = now();
		const stored = entries.insert({
			userId: target,
			tsUtc,
			clientTsUtc: optionalNumber(body, "clientTsUtc"),
			timeZone: user.timezone,
			source: own ? "web" : "admin",
			direction: optionalDirection(body),
			idempotencyKey: optionalString(body, "idempotencyKey"),
			note: optionalString(body, "note"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: timestamp,
		});

		const day = aggregation.recalculateDay(target, stored.entry.localDate, { now: timestamp });
		return json(
			201,
			{ entry: stored.entry, created: stored.created, day },
			{ location: `/entries/${stored.entry.id}` },
		);
	});

	// absences

	route("GET", "/absences", { permission: "report.view_own" }, context => {
		const requested = context.query("userId") ? Number(context.query("userId")) : null;
		const userId = resolveScope(context, requested, "report.view_own", "report.view_other");
		const year = context.query("year") ? Number(context.query("year")) : undefined;
		return json(200, { absences: absences.listByUser(userId, year === undefined ? {} : { year }) });
	});

	route("POST", "/absences", { permission: "absence.request", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const userId = resolveScope(context, optionalNumber(body, "userId"), "absence.request", "absence.edit_other");

		const status = optionalString(body, "status");
		if (status !== null && status !== "taken" && status !== "planned") {
			throw new ValidationError(`status must be taken or planned (got ${status})`);
		}

		const created = absences.create({
			userId,
			typeCode: optionalString(body, "typeCode") ?? undefined,
			typeId: optionalNumber(body, "typeId") ?? undefined,
			dateFrom: requireString(body, "dateFrom"),
			dateTo: optionalString(body, "dateTo") ?? undefined,
			dayPortion: optionalNumber(body, "dayPortion") ?? undefined,
			hours: optionalNumber(body, "hours"),
			status: status ?? undefined,
			note: optionalString(body, "note"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(201, { absence: created }, { location: `/absences/${created.id}` });
	});

	route("POST", "/absences/:id/status", { permission: "absence.approve", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const status = requireString(context.jsonBody(), "status");
		if (status !== "taken" && status !== "planned") {
			throw new ValidationError(`status must be taken or planned (got ${status})`);
		}

		const updated = absences.setStatus({
			id: numberParam(context, "id"),
			status,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, { absence: updated });
	});

	/**
	 * Loads an absence and checks whether the caller may change it.
	 *
	 * @param context - route context
	 * @returns the absence
	 */
	const changeableAbsence = (context: RouteContext): AbsenceRecord => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const absence = absences.findById(numberParam(context, "id"));
		if (!absence) {
			throw new NotFoundError(`absence ${context.params.id} not found`);
		}
		if (absence.userId !== context.auth.user.id && !context.auth.permissions.includes("absence.edit_other")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: absence.edit_other)");
		}
		return absence;
	};

	route("PATCH", "/absences/:id", { permission: "absence.request", csrf: true }, context => {
		const absence = changeableAbsence(context);
		const body = context.jsonBody();
		const status = optionalString(body, "status");

		if (status !== null && status !== "taken" && status !== "planned") {
			throw new ValidationError(`status must be taken or planned (got ${status})`);
		}
		// changing the state of an absence is an approval, even for the own one
		if (status !== null && !context.auth?.permissions.includes("absence.approve")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: absence.approve)");
		}

		const patch = {
			typeId: optionalNumber(body, "typeId") ?? undefined,
			typeCode: optionalString(body, "typeCode") ?? undefined,
			dateFrom: optionalString(body, "dateFrom") ?? undefined,
			dateTo: optionalString(body, "dateTo") ?? undefined,
			dayPortion: optionalNumber(body, "dayPortion") ?? undefined,
			...(Object.prototype.hasOwnProperty.call(body, "hours") ? { hours: optionalNumber(body, "hours") } : {}),
			...(Object.prototype.hasOwnProperty.call(body, "note") ? { note: optionalString(body, "note") } : {}),
		};
		const hasFields = Object.values(patch).some(value => value !== undefined);

		if (status !== null) {
			absences.setStatus({
				id: absence.id,
				status,
				actorId: context.auth?.user.id ?? 0,
				actorIp: context.request.remoteAddress ?? null,
				now: now(),
			});
		}

		const updated = hasFields
			? absences.update({
					id: absence.id,
					patch,
					reason: optionalString(body, "reason"),
					actorId: context.auth?.user.id ?? 0,
					actorIp: context.request.remoteAddress ?? null,
					now: now(),
				})
			: (absences.findById(absence.id) ?? absence);

		return json(200, { absence: updated });
	});

	route("DELETE", "/absences/:id", { permission: "absence.request", csrf: true }, context => {
		const absence = changeableAbsence(context);
		const removed = absences.remove({
			id: absence.id,
			actorId: context.auth?.user.id ?? 0,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`absence ${absence.id} not found`);
		}
		return noContent();
	});

	// master data: absence types, holidays and instance settings

	route("GET", "/absence-types", {}, context =>
		json(200, { types: absences.types({ userId: context.auth?.user.id ?? null }) }),
	);

	route("POST", "/absence-types", { permission: "absence.manage_types", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const result = absences.upsertType({
			userId: optionalNumber(body, "userId"),
			code: requireString(body, "code"),
			name: requireString(body, "name"),
			paid: optionalBoolean(body, "paid") ?? undefined,
			factor: optionalNumber(body, "factor") ?? undefined,
			reduceVacation: optionalBoolean(body, "reduceVacation") ?? undefined,
			isActive: optionalBoolean(body, "isActive") ?? undefined,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(result.created ? 201 : 200, { type: result.type, created: result.created });
	});

	route("GET", "/holidays", { permission: "report.view_own" }, context => {
		const year = numberQuery(context, "year");
		const region = context.query("region") ?? undefined;
		return json(200, { year, region: region ?? null, holidays: holidays.listByYear(year, region) });
	});

	route("POST", "/holidays", { permission: "holiday.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const created = holidays.add({
			date: requireString(body, "date"),
			name: requireString(body, "name"),
			region: optionalString(body, "region") ?? undefined,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(201, { holiday: created }, { location: `/holidays/${created.id}` });
	});

	route("DELETE", "/holidays/:id", { permission: "holiday.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const removed = holidays.remove({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`holiday ${context.params.id} not found`);
		}
		return noContent();
	});

	route("GET", "/settings", { permission: "settings.view" }, () =>
		json(200, { settings: readableSettings(settings.all()) }),
	);

	route("PUT", "/settings", { permission: "settings.edit", csrf: true }, context => {
		const body = context.jsonBody();
		const changes: Record<string, SettingValue> = {};
		for (const [key, value] of Object.entries(body)) {
			if (!editableSettings().includes(key)) {
				throw new ValidationError(`setting "${key}" cannot be changed through the API`);
			}
			if (!isSettingValue(value, JSON_SETTINGS.includes(key))) {
				throw new ValidationError(`setting "${key}" has an unsupported value`);
			}
			changes[key] = value as SettingValue;
		}
		if (Object.keys(changes).length === 0) {
			throw new ValidationError("no settings given");
		}

		for (const [key, value] of Object.entries(changes)) {
			settings.set(key, value, context.auth?.user.id ?? null, now());
		}
		return json(200, { settings: changes });
	});

	route("GET", "/version", { public: true }, () =>
		json(200, { name: "iobroker.zeiterfassung", version: deps.version ?? "0.0.0" }),
	);

	// corrections

	route("PATCH", "/entries/:id", { permission: "time.edit_own", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const entryId = numberParam(context, "id");
		const existing = entries.findById(entryId);
		if (!existing) {
			throw new NotFoundError(`entry ${entryId} not found`);
		}
		if (existing.userId !== context.auth.user.id && !context.auth.permissions.includes("time.edit_other")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: time.edit_other)");
		}

		const body = context.jsonBody();
		const revision = optionalNumber(body, "revision");
		if (revision === null) {
			throw new ValidationError("revision is required");
		}
		const target = users.findById(existing.userId);
		if (!target) {
			throw new NotFoundError(`user ${existing.userId} not found`);
		}

		const updated = entries.update({
			id: entryId,
			expectedRevision: revision,
			patch: {
				tsUtc: optionalNumber(body, "tsUtc") ?? undefined,
				note: optionalString(body, "note"),
			},
			reason: optionalString(body, "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			timeZone: target.timezone,
			now: now(),
		});

		const day = aggregation.recalculateDay(updated.userId, updated.localDate, { now: now() });
		return json(200, { entry: updated, day });
	});

	route("DELETE", "/entries/:id", { permission: "time.delete", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const entryId = numberParam(context, "id");
		const existing = entries.findById(entryId);
		if (!existing) {
			throw new NotFoundError(`entry ${entryId} not found`);
		}

		entries.remove({
			id: entryId,
			actorId: context.auth.user.id,
			reason: optionalString(context.optionalJsonBody(), "reason"),
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		aggregation.recalculateDay(existing.userId, existing.localDate, { now: now() });
		return noContent();
	});

	// users, roles and work profiles

	route("GET", "/users", { permission: "user.view" }, context => {
		const includeInactive = context.query("includeInactive") === "true";
		const search = (context.query("q") ?? "").trim().toLowerCase();
		const limit = optionalNumberQuery(context, "limit", Number.MAX_SAFE_INTEGER);
		const offset = optionalNumberQuery(context, "offset", 0);

		const all = users.list({ includeInactive });
		const filtered = search
			? all.filter(
					user =>
						user.login.toLowerCase().includes(search) || user.displayName.toLowerCase().includes(search),
				)
			: all;

		return json(200, {
			total: filtered.length,
			offset,
			users: filtered.slice(offset, offset + limit).map(user => ({
				...publicUser(user),
				roles: users.roles(user.id),
			})),
		});
	});

	route("GET", "/users/:id", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		const user = users.findById(id);
		if (!user) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, {
			user: { ...publicUser(user), roles: users.roles(id), permissions: users.permissions(id) },
			profile: users.getWorkProfile(id),
		});
	});

	route("POST", "/users", { permission: "user.create", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const password = requireString(body, "password");
		const policyIssue = checkPasswordPolicy(password);
		if (policyIssue) {
			throw new ValidationError(policyIssue);
		}

		const created = users.create({
			login: requireString(body, "login"),
			displayName: requireString(body, "displayName"),
			passwordHash: hashPassword(password),
			email: optionalString(body, "email"),
			locale: optionalString(body, "locale") ?? undefined,
			timezone: optionalString(body, "timezone") ?? undefined,
			mustChangePw: optionalBoolean(body, "mustChangePw") ?? undefined,
			roleKeys: readRoleKeys(body) ?? undefined,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});

		return json(
			201,
			{ user: { ...publicUser(created), roles: users.roles(created.id) } },
			{ location: `/users/${created.id}` },
		);
	});

	route("GET", "/roles", { permission: "user.view" }, () => json(200, { roles: users.roleCatalog() }));

	route("PATCH", "/users/:id", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}

		const body = context.jsonBody();
		const roleKeys = readRoleKeys(body);
		// assigning roles is a right of its own
		if (roleKeys !== null && !context.auth.permissions.includes("user.manage_roles")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: user.manage_roles)");
		}

		const password = optionalString(body, "password");
		if (password !== null) {
			const policyIssue = checkPasswordPolicy(password);
			if (policyIssue) {
				throw new ValidationError(policyIssue);
			}
		}

		const patch: {
			displayName?: string;
			email?: string | null;
			locale?: string;
			timezone?: string;
			rfidCard?: string | null;
			isActive?: boolean;
			mustChangePw?: boolean;
			passwordHash?: string;
		} = {};
		if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
			patch.displayName = requireString(body, "displayName");
		}
		if (Object.prototype.hasOwnProperty.call(body, "email")) {
			patch.email = optionalString(body, "email");
		}
		if (Object.prototype.hasOwnProperty.call(body, "locale")) {
			patch.locale = requireString(body, "locale");
		}
		if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
			const timezone = requireString(body, "timezone");
			if (!isValidTimeZone(timezone)) {
				throw new ValidationError(`timezone is not a valid IANA name (got ${timezone})`);
			}
			patch.timezone = timezone;
		}
		if (Object.prototype.hasOwnProperty.call(body, "rfidCard")) {
			patch.rfidCard = optionalString(body, "rfidCard");
		}
		if (Object.prototype.hasOwnProperty.call(body, "mustChangePw")) {
			patch.mustChangePw = requireBoolean(body, "mustChangePw");
		}
		const isActive = optionalBoolean(body, "isActive");
		if (isActive !== null) {
			if (isActive === false && id === context.auth.user.id) {
				throw new ValidationError("an account cannot deactivate itself");
			}
			patch.isActive = isActive;
		}
		if (password !== null) {
			patch.passwordHash = hashPassword(password);
		}

		const updated = users.update({
			id,
			patch,
			reason: optionalString(body, "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		const roles = roleKeys
			? users.setRoles({
					userId: id,
					roleKeys,
					actorId: context.auth.user.id,
					actorIp: context.request.remoteAddress ?? null,
					now: now(),
				})
			: users.roles(id);

		return json(200, { user: { ...publicUser(updated), roles } });
	});

	route("DELETE", "/users/:id", { permission: "user.deactivate", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		const target = users.findById(id);
		if (!target) {
			throw new NotFoundError(`user ${id} not found`);
		}
		if (!target.isActive) {
			// a second call has nothing left to do and says so
			throw new NotFoundError(`user ${id} is already deactivated`);
		}
		if (id === context.auth.user.id) {
			throw new ValidationError("an account cannot deactivate itself");
		}

		// accounts are never deleted, they are deactivated and keep their history
		users.update({
			id,
			patch: { isActive: false },
			reason: optionalString(context.optionalJsonBody(), "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return noContent();
	});

	route("GET", "/users/:id/profile", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, { profile: users.getWorkProfile(id) });
	});

	route("PUT", "/users/:id/profile", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		const body = context.jsonBody();

		const profile = users.saveWorkProfile({
			userId: id,
			profile: readProfilePatch(body),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, { profile });
	});

	route("GET", "/users/:id/shift-rules", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, { shiftRules: rules.shiftRules(id, { includeInactive: true }) });
	});

	route("PUT", "/users/:id/shift-rules", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}

		const body = context.jsonBody();
		if (!Array.isArray(body.shiftRules)) {
			throw new ValidationError("shiftRules must be an array");
		}
		const actor = {
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		};
		const wanted = (body.shiftRules as unknown[]).map(raw => {
			const rule = (raw ?? {}) as Record<string, unknown>;
			return {
				id: optionalNumber(rule, "id") ?? undefined,
				surcharge: Number(rule.surcharge),
				dayOfWeek: optionalNumber(rule, "dayOfWeek"),
				fromMin: optionalNumber(rule, "fromMin"),
				toMin: optionalNumber(rule, "toMin"),
				isActive: optionalBoolean(rule, "isActive") ?? undefined,
			};
		});

		// the payload replaces the rules of the employee: missing rules are removed, the rest is saved
		const keep = new Set(wanted.map(rule => rule.id).filter((value): value is number => value !== undefined));
		for (const existing of rules.shiftRules(id, { includeInactive: true })) {
			if (!keep.has(existing.id)) {
				rules.removeShiftRule({ id: existing.id, ...actor });
			}
		}
		const saved = wanted.map(rule =>
			rules.saveShiftRule({
				...(rule.id !== undefined ? { id: rule.id } : {}),
				userId: id,
				surcharge: rule.surcharge,
				...(rule.dayOfWeek !== null ? { dayOfWeek: rule.dayOfWeek } : {}),
				...(rule.fromMin !== null ? { fromMin: rule.fromMin } : {}),
				...(rule.toMin !== null ? { toMin: rule.toMin } : {}),
				...(rule.isActive !== undefined ? { isActive: rule.isActive } : {}),
				...actor,
			}),
		);
		return json(200, { shiftRules: saved });
	});

	// payouts (paid out overtime)

	route("GET", "/payouts", { permission: "payout.view" }, context => {
		const requested = context.query("userId");
		const userId = requested ? Number(requested) : (context.auth?.user.id ?? 0);
		if (!Number.isInteger(userId)) {
			throw new ValidationError("userId must be a whole number");
		}
		const period = readPeriod(context.query("year"), context.query("month"));
		const list = payouts.list(
			userId,
			period.month === null ? { year: period.year } : { year: period.year, month: period.month },
		);
		return json(200, {
			userId,
			...period,
			totalMinutes: payouts.sumMinutes(userId, period.year, period.month ?? undefined),
			payouts: list,
		});
	});

	route("POST", "/payouts", { permission: "payout.create", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const target = Number(body.userId ?? context.auth.user.id);
		if (!Number.isInteger(target) || !users.findById(target)) {
			throw new ValidationError("userId must reference an existing employee");
		}
		const period = readPeriod(body.year, body.month);
		const minutes = optionalNumber(body, "minutes");
		if (minutes === null || !Number.isInteger(minutes) || minutes === 0) {
			throw new ValidationError("minutes must be a non-zero whole number");
		}

		const created = payouts.create({
			userId: target,
			...period,
			minutes,
			amount: optionalNumber(body, "amount"),
			note: optionalString(body, "note"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(201, { payout: created }, { location: `/payouts/${created.id}` });
	});

	route("PATCH", "/payouts/:id", { permission: "payout.create", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!payouts.findById(id)) {
			throw new NotFoundError(`payout ${id} not found`);
		}
		const body = context.jsonBody();
		const minutes = optionalNumber(body, "minutes");
		if (minutes !== null && (!Number.isInteger(minutes) || minutes === 0)) {
			throw new ValidationError("minutes must be a non-zero whole number");
		}

		const updated = payouts.update({
			id,
			patch: {
				...(minutes !== null ? { minutes } : {}),
				...(Object.prototype.hasOwnProperty.call(body, "amount")
					? { amount: optionalNumber(body, "amount") }
					: {}),
				...(Object.prototype.hasOwnProperty.call(body, "note") ? { note: optionalString(body, "note") } : {}),
			},
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, { payout: updated });
	});

	route("DELETE", "/payouts/:id", { permission: "payout.create", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const removed = payouts.remove({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`payout ${context.params.id} not found`);
		}
		return noContent();
	});

	// bulk import of punches (administration and migration)

	route("POST", "/entries/bulk", { permission: "time.import", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		if (!Array.isArray(body.entries)) {
			throw new ValidationError("entries must be an array");
		}

		const actor = context.auth;
		const timestamp = now();
		const touched = new Map<string, number>();
		const results: { index: number; entryId?: number; error?: string }[] = [];

		(body.entries as unknown[]).forEach((raw, index) => {
			try {
				const item = (raw ?? {}) as Record<string, unknown>;
				const target = Number(item.userId ?? actor.user.id);
				if (!Number.isInteger(target)) {
					throw new ValidationError("userId must be a whole number");
				}
				// writing punches for somebody else needs the matching permission
				if (target !== actor.user.id && !actor.permissions.includes("time.edit_other")) {
					throw problem(403, "permission_denied", "request rejected (permission_denied: time.edit_other)");
				}
				const user = users.findById(target);
				if (!user) {
					throw new NotFoundError(`user ${target} not found`);
				}
				const tsUtc = optionalNumber(item, "tsUtc");
				if (tsUtc === null) {
					throw new ValidationError("tsUtc is required");
				}

				const stored = entries.insert({
					userId: target,
					tsUtc,
					clientTsUtc: optionalNumber(item, "clientTsUtc"),
					timeZone: user.timezone,
					source: "import",
					direction: optionalDirection(item),
					idempotencyKey: optionalString(item, "idempotencyKey"),
					note: optionalString(item, "note"),
					actorId: actor.user.id,
					actorIp: context.request.remoteAddress ?? null,
					now: timestamp,
				});

				touched.set(`${target}|${stored.entry.localDate}`, target);
				results.push({ index, entryId: stored.entry.id });
			} catch (error) {
				// a faulty row does not discard the rest of the import
				const details = toProblem(error).problem;
				results.push({ index, error: details.code });
			}
		});

		// the aggregates of the imported days are refreshed once, not per row
		for (const key of touched.keys()) {
			const [userId, localDate] = key.split("|");
			aggregation.recalculateDay(Number(userId), localDate, { now: timestamp });
		}

		const imported = results.filter(result => result.entryId !== undefined).length;
		return json(200, {
			imported,
			failed: results.length - imported,
			recalculatedDays: touched.size,
			results,
		});
	});

	// statistics

	route("GET", "/reports/statistics", { permission: "report.statistics" }, context => {
		const from = context.query("from");
		const to = context.query("to") ?? from;
		if (!from || !to) {
			throw new ValidationError("from and to are required");
		}
		if (from > to) {
			throw new ValidationError(`from (${from}) must not be after to (${to})`);
		}
		// every day of every employee is recalculated, so the range stays bounded
		const days = dateRange(from, to).length;
		if (days > MAX_STATISTICS_DAYS) {
			throw new ValidationError(`the range may cover at most ${MAX_STATISTICS_DAYS} days (got ${days})`);
		}

		const requested = context.query("userId");
		if (requested) {
			// looking at somebody else is a permission of its own
			if (!context.auth?.permissions.includes("report.view_other")) {
				throw problem(403, "permission_denied", "request rejected (permission_denied: report.view_other)");
			}
		}
		const employees = requested ? [Number(requested)] : users.list({ includeInactive: false }).map(user => user.id);
		if (employees.some(id => !Number.isInteger(id) || !users.findById(id))) {
			throw new ValidationError("userId must reference an existing employee");
		}

		const timestamp = now();
		const rows = employees.map(userId => {
			const user = users.findById(userId);
			const range = aggregation.recalculateRange(userId, from, to, { now: timestamp });
			return {
				userId,
				displayName: user?.displayName ?? "",
				...range,
			};
		});

		return json(200, {
			from,
			to,
			users: rows,
			totals: rows.reduce(
				(sum, row) => ({
					workedMin: sum.workedMin + row.workedMin,
					targetMin: sum.targetMin + row.targetMin,
					balanceMin: sum.balanceMin + row.balanceMin,
					openDays: sum.openDays + row.openDays,
				}),
				{ workedMin: 0, targetMin: 0, balanceMin: 0, openDays: 0 },
			),
		});
	});

	// kiosk terminal (device token -> short lived session, badge/PIN punching)

	/**
	 * Refuses terminal requests when the instance switch is off.
	 */
	const requireKiosk = (): void => {
		if (deps.kioskEnabled !== true) {
			throw problem(403, "kiosk_disabled", "the kiosk terminal is switched off in the adapter settings");
		}
	};

	/**
	 * Resolves the terminal of a request.
	 *
	 * @param context - route context (body or query carries the session)
	 * @returns the terminal
	 */
	const requireTerminal = (context: RouteContext): TerminalRecord => {
		requireKiosk();
		// the session travels in the body of a POST and in the query of a GET
		const body = context.optionalJsonBody<Record<string, unknown>>();
		const fromBody = typeof body.terminalSession === "string" ? body.terminalSession : null;
		const session = fromBody ?? context.query("terminalSession");
		if (!session) {
			throw problem(401, "no_session", "terminal session is missing");
		}
		const terminal = terminals.findBySession(session, now());
		if (!terminal) {
			throw problem(401, "no_session", "terminal session is not valid any more");
		}
		return terminal;
	};

	route("GET", "/terminal/status", { public: true }, () =>
		json(200, {
			enabled: deps.kioskEnabled === true,
			serverTime: now(),
			timezone: settings.get("timezone") ?? "Europe/Zurich",
			version: deps.version ?? "0.0.0",
		}),
	);

	route("POST", "/terminal/session", { public: true, csrf: false }, context => {
		requireKiosk();
		const body = context.jsonBody();
		const deviceToken = requireString(body, "deviceToken");
		const terminal = terminals.findByToken(deviceToken, now());
		if (!terminal) {
			throw problem(401, "invalid_credentials", "the device token is not valid any more");
		}

		const started = terminals.startSession({
			id: terminal.id,
			ttlMinutes: TERMINAL_SESSION_MINUTES,
			now: now(),
		});
		return json(200, {
			terminalSession: started.terminalSession,
			expiresAt: started.expiresAt,
			terminal: {
				name: terminal.name,
				location: terminal.location,
				pinRequired: terminal.pinRequired,
			},
		});
	});

	route("POST", "/terminal/heartbeat", { public: true, csrf: false }, context => {
		const terminal = requireTerminal(context);
		const extended = terminals.touch({
			id: terminal.id,
			ttlMinutes: TERMINAL_SESSION_MINUTES,
			now: now(),
		});
		return json(200, {
			status: "ok",
			serverTime: now(),
			timezone: settings.get("timezone") ?? "Europe/Zurich",
			version: deps.version ?? "0.0.0",
			expiresAt: extended.expiresAt,
		});
	});

	route("GET", "/terminal/users", { public: true }, context => {
		requireTerminal(context);
		// only what a badge/PIN selection needs — no mail address, no profile, no working times
		return json(200, {
			users: users.list({ includeInactive: false }).map(user => ({ id: user.id, displayName: user.displayName })),
		});
	});

	route("POST", "/terminal/punch", { public: true, csrf: false }, context => {
		const terminal = requireTerminal(context);
		const body = context.jsonBody();
		const badge = optionalString(body, "badge");
		const pin = optionalString(body, "pin");
		const targetId = optionalNumber(body, "userId");

		if (badge === null && (pin === null || targetId === null)) {
			throw new ValidationError("a badge or a userId together with the PIN is required");
		}

		const user = badge !== null ? users.findByRfidCard(badge) : users.findById(targetId ?? 0);
		if (!user || !user.isActive) {
			// the same answer for an unknown badge and an unknown user: no enumeration of accounts
			throw problem(401, "invalid_credentials", "badge or PIN is not known");
		}

		const pinMatches = pin !== null && user.pinHash !== null && verifyPassword(pin, user.pinHash);
		if (terminal.pinRequired ? !pinMatches : !pinMatches && badge === null) {
			throw problem(401, "invalid_credentials", "badge or PIN is not known");
		}

		const timestamp = now();
		const stored = entries.insert({
			userId: user.id,
			tsUtc: optionalNumber(body, "tsUtc") ?? timestamp,
			timeZone: user.timezone,
			source: "terminal",
			direction: optionalDirection(body),
			note: optionalString(body, "note"),
			actorId: user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: timestamp,
		});
		const day = aggregation.recalculateDay(user.id, stored.entry.localDate, { now: timestamp });
		terminals.touch({ id: terminal.id, ttlMinutes: TERMINAL_SESSION_MINUTES, now: timestamp });

		// the answer stays minimal: the terminal shows a name, a time and the state of the day
		return json(201, {
			user: { id: user.id, displayName: user.displayName },
			entry: {
				id: stored.entry.id,
				tsUtc: stored.entry.tsUtc,
				direction: stored.entry.direction,
				localDate: stored.entry.localDate,
			},
			day: {
				workedMin: day.workedMin,
				targetMin: day.targetMin,
				balanceMin: day.balanceMin,
				hasOpenEntry: day.hasOpenEntry,
			},
		});
	});

	// terminals and PINs (administration)

	route("GET", "/terminals", { permission: "terminal.manage" }, () =>
		json(200, { terminals: terminals.list({ includeInactive: true }).map(publicTerminal) }),
	);

	route("POST", "/terminals", { permission: "terminal.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const created = terminals.create({
			name: requireString(body, "name"),
			location: optionalString(body, "location"),
			pinRequired: optionalBoolean(body, "pinRequired") ?? undefined,
			ttlDays: optionalNumber(body, "ttlDays"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});

		// the device token is returned exactly once — the server only keeps its hash
		return json(
			201,
			{ terminal: publicTerminal(created.terminal), deviceToken: created.deviceToken },
			{ location: `/terminals/${created.terminal.id}` },
		);
	});

	route("DELETE", "/terminals/:id", { permission: "terminal.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const revoked = terminals.revoke({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!revoked) {
			throw new NotFoundError(`terminal ${context.params.id} not found or already revoked`);
		}
		return noContent();
	});

	route("POST", "/users/:id/pin", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		const body = context.jsonBody();
		const pin = optionalString(body, "pin");

		if (pin !== null && !/^\d{4,8}$/.test(pin)) {
			throw new ValidationError("pin must be 4 to 8 digits");
		}
		users.setPin({
			userId: id,
			// a PIN is a secret of the same weight as a password, so it is hashed the same way
			pinHash: pin === null ? null : hashPassword(pin),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return noContent();
	});

	// system

	route("GET", "/health", { public: true }, () =>
		json(200, {
			status: "ok",
			holidayCountry: settings.get("holiday_country") ?? "CH",
			time: now(),
		}),
	);

	route("GET", "/routes", { public: true }, () => json(200, { routes: registered }));

	return { router, routes: () => registered.slice() };
}
