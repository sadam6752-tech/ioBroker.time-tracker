/**
 * REST API of the adapter.
 *
 * The endpoints are registered on the server agnostic router, so the same table can later be mounted on an own
 * HTTP server (`native.port`) or handed to the web extension of a `web` instance.
 *
 * Conventions:
 *  - the session token travels in the `x-session-token` header, the CSRF token in `x-csrf-token`;
 *  - `?userId=` selects another employee and requires the matching `…_other` permission (otherwise the caller
 *    only sees their own data);
 *  - every write answers with the stored record and, where it matters, with the refreshed aggregates;
 *  - reads recalculate the requested period, so a report is always up to date.
 */

import type { Db } from "../db/database";
import type { AbsencesRepository } from "../db/repositories/absences";
import type { EntriesRepository, EntryDirection } from "../db/repositories/entries";
import type { SettingsRepository } from "../db/repositories/settings";
import type { UsersRepository } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import type { AuthService } from "../services/auth";
import type { SyncService } from "../services/sync";
import { NotFoundError, ValidationError } from "../errors";
import { problem } from "./problem";
import { createRouter, json, noContent, type HttpMethod, type RouteContext, type Router } from "./router";

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
	/** Aggregation service (reports and refreshes) */
	aggregation: AggregationService;
	/** Offline synchronisation */
	sync: SyncService;
	/** Instance settings */
	settings: SettingsRepository;
	/** Instant source, defaults to the system clock */
	now?: () => number;
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
	const { auth, users, entries, absences, aggregation, sync, settings } = deps;
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

	// punching

	route("POST", "/time/punch", { permission: "time.punch", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const timestamp = now();
		const user = users.findById(context.auth.user.id);
		if (!user) {
			throw new NotFoundError(`user ${context.auth.user.id} not found`);
		}

		const stored = entries.insert({
			userId: user.id,
			tsUtc: optionalNumber(body, "tsUtc") ?? timestamp,
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
			{ entry: stored.entry, created: stored.created, day },
			{ location: `/time/entries/${stored.entry.id}` },
		);
	});

	route("POST", "/sync", { permission: "time.punch", csrf: true }, context => {
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

	route("GET", "/sync/conflicts", { permission: "time.resolve_conflict" }, context =>
		json(200, { conflicts: sync.conflicts(context.auth?.user.id ?? 0) }),
	);

	route("POST", "/sync/conflicts/:id", { permission: "time.resolve_conflict", csrf: true }, context => {
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

	// reports

	route("GET", "/reports/day/:date", { permission: "report.view_own" }, context => {
		const requested = context.query("userId") ? Number(context.query("userId")) : null;
		const userId = resolveScope(context, requested, "report.view_own", "report.view_other");
		const day = aggregation.recalculateDay(userId, context.params.date, { now: now() });
		return json(200, { day });
	});

	route("GET", "/reports/month/:year/:month", { permission: "report.view_own" }, context => {
		const requested = context.query("userId") ? Number(context.query("userId")) : null;
		const userId = resolveScope(context, requested, "report.view_own", "report.view_other");
		const year = numberParam(context, "year");

		const month = aggregation.recalculateMonth(userId, year, numberParam(context, "month"), { now: now() });
		const yearly = aggregation.recalculateYear(userId, year, { now: now() });
		return json(200, { month, year: yearly });
	});

	route("GET", "/reports/year/:year", { permission: "report.view_own" }, context => {
		const requested = context.query("userId") ? Number(context.query("userId")) : null;
		const userId = resolveScope(context, requested, "report.view_own", "report.view_other");
		const yearly = aggregation.recalculateYear(userId, numberParam(context, "year"), { now: now() });
		return json(200, { year: yearly });
	});

	route("GET", "/time/entries", { permission: "report.view_own" }, context => {
		const requested = context.query("userId") ? Number(context.query("userId")) : null;
		const userId = resolveScope(context, requested, "report.view_own", "report.view_other");
		const from = context.query("from");
		const to = context.query("to") ?? from;
		if (!from || !to) {
			throw new ValidationError("from and to are required");
		}
		return json(200, { entries: entries.listByRange(userId, from, to) });
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

	// corrections

	route("POST", "/time/entries/:id", { permission: "time.edit_own", csrf: true }, context => {
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

	route("DELETE", "/time/entries/:id", { permission: "time.delete", csrf: true }, context => {
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
			reason: optionalString(context.jsonBody(), "reason"),
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		aggregation.recalculateDay(existing.userId, existing.localDate, { now: now() });
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
