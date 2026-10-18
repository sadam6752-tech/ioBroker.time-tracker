/**
 * What every route module of the API works with: the data sources, the router with its `route` helper, the
 * event bus and the helpers that several modules share (scope of a request, the punch itself).
 */

import { NotFoundError, ValidationError } from "../../errors";
import { roundToStep } from "../../domain/punch";
import { clearCookie, SESSION_COOKIE, serializeCookie } from "../cookies";
import { createEventBus, type ApiEvent, type EventBus } from "../events";
import { createPinGuard, type PinGuard } from "../pin-guard";
import { problem } from "../problem";
import { createRouter, json, type HttpMethod, type RouteContext, type RouteResponse, type Router } from "../router";

import { type ApiDeps, type ApiRoute, optionalString, optionalNumber, optionalDirection, resolveScope } from "./shared";

/**
 * Builds the context the route modules register their endpoints with.
 *
 * @param deps - data sources of the API
 * @returns router, helpers and data sources
 */
export function createApiContext(deps: ApiDeps): ApiContext {
	const {
		auth,
		users,
		entries,
		absences,
		holidays,
		rules,
		payouts,
		terminals,
		rfid,
		triggers,
		automations,
		aggregation,
		sync,
		settings,
	} = deps;
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const events = deps.events ?? createEventBus();
	const registered: ApiRoute[] = [];
	const router = createRouter({
		auth,
		trustProxy: deps.trustProxy === true,
		secureTransport: deps.secureTransport === true,
		now,
	});
	// wrong PINs at the terminal are counted per account (specification 4.10); the counters are short lived
	const pinGuard = createPinGuard();

	/**
	 * Publishes a live event about a change.
	 *
	 * @param event - kind of the change, affected employee and a short summary
	 */
	const emit = (event: Omit<ApiEvent, "atUtc">): void => {
		events.publish({ ...event, atUtc: now() });
	};

	/**
	 * Refuses a change that would leave the installation without an active administrator.
	 *
	 * The installation creates exactly one administrator; if the last active one is deactivated or loses the role,
	 * nobody can administer any more — only the `admin` role carries `user.edit`, `user.manage_roles`, `settings.edit`
	 * and the rest. The way back would be an instance restart with a free `adminLogin`, so the change is refused
	 * instead. Only active accounts count: a deactivated administrator helps nobody.
	 *
	 * @param userId - account that is changed
	 * @param next - state the account would have afterwards
	 * @param next.isActive - activity after the change
	 * @param next.roleKeys - roles after the change
	 */
	function requireActiveAdministrator(userId: number, next: { isActive: boolean; roleKeys: string[] }): void {
		if (next.isActive && next.roleKeys.includes("admin")) {
			return;
		}
		const remaining = users.list().some(user => user.id !== userId && users.roles(user.id).includes("admin"));
		if (!remaining) {
			throw problem(
				409,
				"last_administrator",
				"the last active administrator cannot be deactivated or lose the admin role",
			);
		}
	}

	/**
	 * Registers a route and remembers it for the documentation.
	 *
	 * @param method - HTTP method(s)
	 * @param path - path pattern
	 * @param routeSettings - permission and visibility of the route
	 * @param routeSettings.permission - permission required
	 * @param routeSettings.public - true when no session is needed
	 * @param routeSettings.csrf - false when the route must never ask for a CSRF token (it runs without a session,
	 *   for example the login); otherwise the router decides from the credential: a browser session cookie needs the
	 *   token, an integration client with a bearer token does not
	 * @param routeSettings.rateLimit - rate limit of the route class
	 * @param routeSettings.rateLimit.name - name of the counted class
	 * @param routeSettings.rateLimit.limit - allowed requests inside the window
	 * @param routeSettings.rateLimit.windowSeconds - length of the window
	 * @param routeSettings.maxBodyBytes - body limit of this route in bytes (a backup upload); the router-wide
	 *   limit applies when it is missing
	 * @param handler - handler of the route
	 */
	const route = (
		method: HttpMethod | HttpMethod[],
		path: string,
		routeSettings: {
			/** Permission the caller needs; without one the route only requires a session */
			permission?: string;
			/** True for a route that runs without a session (health, login, branding) */
			public?: boolean;
			/** `false` switches the CSRF check off (public routes); otherwise the router decides */
			csrf?: boolean;
			/** Requests allowed inside a window, e.g. `{ name: "export", limit: 20, windowSeconds: 60 }` */
			rateLimit?: {
				/** Name the limit is counted under */
				name: string;
				/** Allowed requests inside the window */
				limit: number;
				/** Length of the window in seconds */
				windowSeconds: number;
			};
			/** Raises the body limit of this one route (a backup upload) */
			maxBodyBytes?: number;
		},
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
			// `undefined` hands the decision to the router: a session cookie needs the CSRF token, a bearer
			// client (integration, `x-session-token`) does not, because no foreign page can set that header.
			// `false` switches the check off completely — that is for the public routes, which run without a
			// session, so a CSRF token could not exist yet.
			requiresCsrf: routeSettings.csrf === false ? false : undefined,
			rateLimit: routeSettings.rateLimit,
			maxBodyBytes: routeSettings.maxBodyBytes,
			handler,
		});
	};

	/**
	 * Writes the session cookie of a fresh login.
	 *
	 * The cookie is `httpOnly` (a script inside the page cannot read it), `SameSite=Lax` and carries `Secure`
	 * as soon as the client reaches the adapter over HTTPS — directly or through a trusted proxy (specification
	 * 4.x). The browser sends it with every request by itself, which is exactly why state changing requests
	 * additionally need the CSRF token from `x-csrf-token`; a bearer client has no such ambient credential.
	 *
	 * @param context - route context of the request (for the `Secure` flag)
	 * @param token - session token
	 * @param expiresAt - instant the session ends, UTC epoch seconds
	 * @returns value of the `set-cookie` header
	 */
	const sessionCookie = (context: RouteContext, token: string, expiresAt: number): string =>
		serializeCookie(SESSION_COOKIE, token, {
			maxAgeSeconds: Math.max(0, expiresAt - now()),
			secure: context.secure,
		});

	/**
	 * Removes the session cookie, so the browser session really ends.
	 *
	 * @param context - route context of the request (the flags have to match the ones it was set with)
	 * @returns value of the `set-cookie` header
	 */
	const removeSessionCookie = (context: RouteContext): string =>
		clearCookie(SESSION_COOKIE, { secure: context.secure });

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
	 * Resolves the employee a day note belongs to from `?userId=`.
	 *
	 * A note for somebody else is an administrative step and needs `time.edit_other`; without that right only the
	 * own day can be commented. The target has to exist, like everywhere else.
	 *
	 * @param context - route context with the authenticated caller
	 * @param actorId - id of the caller
	 * @returns the target user id
	 */
	const dayNoteTarget = (context: RouteContext, actorId: number): number => {
		const raw = context.query("userId");
		const target = raw === null || raw.trim() === "" ? actorId : Number(raw);
		if (!Number.isInteger(target)) {
			throw new ValidationError("userId must be a whole number");
		}
		if (target !== actorId && !(context.auth?.permissions.includes("time.edit_other") ?? false)) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: time.edit_other)");
		}
		if (!users.findById(target)) {
			throw new NotFoundError(`user ${target} not found`);
		}
		return target;
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
	const punch = (
		context: RouteContext,
		options: {
			/** True for a quick punch: the instant is rounded to the configured step */
			quick: boolean;
		},
	): RouteResponse => {
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
		emit({
			type: "punch",
			userId: user.id,
			data: { entryId: stored.entry.id, created: stored.created, localDate: stored.entry.localDate },
		});
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

	return {
		deps,
		auth,
		users,
		entries,
		absences,
		holidays,
		rules,
		payouts,
		terminals,
		rfid,
		triggers,
		automations,
		aggregation,
		sync,
		settings,
		now,
		events,
		registered,
		router,
		pinGuard,
		emit,
		requireActiveAdministrator,
		route,
		sessionCookie,
		removeSessionCookie,
		scopeUser,
		dayNoteTarget,
		numberQuery,
		punch,
	};
}

/** Permission, visibility and limits of one route. */
export interface RouteSettings {
	/** Permission the caller needs; without one the route only requires a session */
	permission?: string;
	/** True for a route that runs without a session (health, login, branding) */
	public?: boolean;
	/** `false` switches the CSRF check off (public routes); otherwise the router decides */
	csrf?: boolean;
	/** Requests allowed inside a window, e.g. `{ name: "export", limit: 20, windowSeconds: 60 }` */
	rateLimit?: {
		/** Name the limit is counted under */
		name: string;
		/** Allowed requests inside the window */
		limit: number;
		/** Length of the window in seconds */
		windowSeconds: number;
	};
	/** Raises the body limit of this one route (a backup upload) */
	maxBodyBytes?: number;
}

/** Handler of a route. */
export type RouteHandler = (context: RouteContext) => ReturnType<Parameters<Router["add"]>[0]["handler"]>;

/** The context of the route modules: data sources, router and the helpers several modules share. */
export interface ApiContext extends Pick<
	ApiDeps,
	| "auth"
	| "users"
	| "entries"
	| "absences"
	| "holidays"
	| "rules"
	| "payouts"
	| "terminals"
	| "rfid"
	| "triggers"
	| "automations"
	| "aggregation"
	| "sync"
	| "settings"
> {
	/** Data sources as handed to `createApi`, also the optional ones (backup, secrets, version) */
	deps: ApiDeps;
	/** Instant source, UTC epoch seconds */
	now: () => number;
	/** Bus every change is published on */
	events: EventBus;
	/** Route table for `GET /routes` */
	registered: ApiRoute[];
	/** Router the routes are registered on */
	router: Router;
	/** Counts wrong PINs at the terminal per account */
	pinGuard: PinGuard;
	/** Publishes a live event about a change */
	emit: (event: Omit<ApiEvent, "atUtc">) => void;
	/** Refuses a change that would leave the installation without an active administrator */
	requireActiveAdministrator: (userId: number, next: { isActive: boolean; roleKeys: string[] }) => void;
	/** Registers a route and remembers it for the route table */
	route: (
		method: HttpMethod | HttpMethod[],
		path: string,
		routeSettings: RouteSettings,
		handler: RouteHandler,
	) => void;
	/** `Set-Cookie` value of a fresh session */
	sessionCookie: (context: RouteContext, token: string, expiresAt: number) => string;
	/** `Set-Cookie` value that removes the session cookie */
	removeSessionCookie: (context: RouteContext) => string;
	/** Employee a read request refers to (`?userId=`), checked against the permissions */
	scopeUser: (context: RouteContext, ownPermission?: string, otherPermission?: string) => number;
	/** Employee a day note refers to */
	dayNoteTarget: (context: RouteContext, actorId: number) => number;
	/** Required numeric query parameter */
	numberQuery: (context: RouteContext, name: string) => number;
	/** Punches the caller in or out */
	punch: (
		context: RouteContext,
		options: {
			/** True for a quick punch: the instant is rounded to the configured step */
			quick: boolean;
		},
	) => RouteResponse;
}
