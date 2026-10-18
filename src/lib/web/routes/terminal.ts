/**
 * Kiosk terminal (device token, badge and PIN punching), terminals and PINs.
 */

import type { TerminalRecord } from "../../db/repositories/terminals";
import { hashPassword, verifyPassword } from "../../services/auth";
import { NotFoundError, ValidationError } from "../../errors";
import { localDate } from "../../util/time";
import { problem } from "../problem";
import { json, noContent, type RouteContext } from "../router";

import type { ApiContext } from "./context";
import {
	bodySchema,
	check,
	optionalFlag,
	optionalIdList,
	optionalNumber,
	optionalText,
	parseBody,
	punchDirection,
	requiredText,
} from "./validate";
import {
	MAX_CODE_LENGTH,
	MAX_PUBLIC_NOTE_LENGTH,
	TERMINAL_SESSION_MINUTES_DEFAULT,
	publicTerminal,
	numberParam,
} from "./shared";

/** Body that opens a session of a kiosk device. */
const SESSION_BODY = bodySchema({ deviceToken: requiredText(MAX_CODE_LENGTH) });

/** Body of a punch at the kiosk: a badge, or an employee with (or without) the PIN. */
const TERMINAL_PUNCH_BODY = bodySchema({
	badge: optionalText(MAX_CODE_LENGTH),
	pin: optionalText(MAX_CODE_LENGTH),
	userId: optionalNumber(),
	tsUtc: optionalNumber(),
	direction: punchDirection(),
	note: optionalText(MAX_PUBLIC_NOTE_LENGTH),
});

/** Body of a new terminal. */
const TERMINAL_BODY = bodySchema({
	name: requiredText(),
	location: optionalText(),
	pinRequired: optionalFlag(),
	userIds: optionalIdList(),
	ttlDays: optionalNumber(),
});

/** Body of the employees of a terminal. */
const TERMINAL_USERS_BODY = bodySchema({ userIds: optionalIdList() });

/** Body of a PIN: 4 to 8 digits, missing or empty removes the PIN. */
const PIN_BODY = bodySchema({
	pin: check(
		optionalText(),
		value => value === null || /^\d{4,8}$/.test(value),
		() => "pin must be 4 to 8 digits",
	),
});

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerTerminalRoutes(ctx: ApiContext): void {
	const { deps, users, entries, terminals, aggregation, settings, now, pinGuard, emit, route } = ctx;

	// kiosk terminal (device token -> short lived session, badge/PIN punching)

	/**
	 * Refuses terminal requests when the instance switch is off.
	 */
	const requireKiosk = (): void => {
		if (deps.kioskEnabled !== true) {
			throw problem(403, "kiosk_disabled", "the kiosk terminal is switched off in the adapter settings");
		}
	};

	// how long a session of a kiosk device lives; the heartbeat of the device extends it. A test may shorten it,
	// and an instance may raise it for a tablet that is never touched.
	const TERMINAL_SESSION_MINUTES = deps.terminalSessionMinutes ?? TERMINAL_SESSION_MINUTES_DEFAULT;

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
			timezone: settings.get("timezone") ?? "Europe/Berlin",
			version: deps.version ?? "0.0.0",
		}),
	);

	route(
		"POST",
		"/terminal/session",
		{ public: true, csrf: false, rateLimit: { name: "terminal-session", limit: 30, windowSeconds: 60 } },
		context => {
			requireKiosk();
			const { deviceToken } = parseBody(SESSION_BODY, context.jsonBody());
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
		},
	);

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
			timezone: settings.get("timezone") ?? "Europe/Berlin",
			version: deps.version ?? "0.0.0",
			expiresAt: extended.expiresAt,
		});
	});

	route(
		"GET",
		"/terminal/users",
		{ public: true, rateLimit: { name: "terminal-users", limit: 60, windowSeconds: 60 } },
		context => {
			const terminal = requireTerminal(context);
			// A terminal stands at one place: it shows the employees that were assigned to it. No assignment means
			// every employee — that is how terminals worked before the assignment existed.
			//
			// Only what a badge/PIN selection needs — no mail address, no profile, no working times. Whether the
			// employee is at the workplace right now is the one exception: the presence screen highlights it.
			const timestamp = now();
			const terminalSession = context.query("terminalSession") ?? "";
			const candidates = users.list({ includeInactive: false });
			const visible =
				terminal.userIds.length === 0
					? candidates
					: candidates.filter(user => terminal.userIds.includes(user.id));
			return json(200, {
				users: visible.map(user => {
					// The aggregate counts finished punches only. While a punch is open, the time that passed since
					// it started is added here, so the board shows the time that really passed. (A break that the
					// pause rules deduct later is not part of this - the next punch brings the exact value.)
					const date = localDate(timestamp, user.timezone);
					const day = aggregation.recalculateDay(user.id, date, { now: timestamp });
					const open = day?.hasOpenEntry ? entries.listByDate(user.id, date).at(-1) : undefined;
					const runningMin = open ? Math.max(0, Math.floor((timestamp - open.tsUtc) / 60)) : 0;
					// The worked time of the day travels only for employees whose work profile allows it: the
					// presence screen is visible before the PIN is entered, so the decision stays with the
					// administration - and it is made here, not in the browser.
					const showWorkedTime = users.getWorkProfile(user.id)?.showWorkedTime === true;
					return {
						id: user.id,
						displayName: user.displayName,
						present: day?.hasOpenEntry === true,
						workedMin: showWorkedTime ? (day?.workedMin ?? 0) + runningMin : undefined,
						// the picture is fetched by the browser from its own route; the session of this device travels
						// in the query, so a plain `<img>` can load it
						avatarUrl: user.avatar
							? `/api/users/${user.id}/avatar?terminalSession=${encodeURIComponent(terminalSession)}&v=${user.updatedAt}`
							: null,
					};
				}),
			});
		},
	);

	route(
		"POST",
		"/terminal/punch",
		{ public: true, csrf: false, rateLimit: { name: "terminal-punch", limit: 60, windowSeconds: 60 } },
		context => {
			const terminal = requireTerminal(context);
			const body = parseBody(TERMINAL_PUNCH_BODY, context.jsonBody());
			const { badge, pin } = body;
			const targetId = body.userId;

			if (badge === null && targetId === null) {
				throw new ValidationError("a badge or a userId is required");
			}
			// a device that demands the PIN authenticates with it; a device without that duty may punch for a
			// selected employee right away (the administrator decided that this place is trusted)
			if (badge === null && terminal.pinRequired && pin === null) {
				throw new ValidationError("a userId together with the PIN is required");
			}

			const user = badge !== null ? users.findByRfidCard(badge) : users.findById(targetId ?? 0);
			if (!user || !user.isActive) {
				// the same answer for an unknown badge and an unknown user: no enumeration of accounts.
				// There is no account to count here — the rate limit of the route covers this case.
				throw problem(401, "invalid_credentials", "badge or PIN is not known");
			}

			// a shared device plus a four digit PIN: too many wrong tries block the account for a while (4.10)
			const blocked = pinGuard.state({ userId: user.id, now: now() });
			if (blocked.locked) {
				throw problem(423, "locked_out", `too many wrong PINs, try again in ${blocked.retryAfterSeconds} s`);
			}

			const pinMatches = pin !== null && user.pinHash !== null && verifyPassword(pin, user.pinHash);
			// a wrong PIN is refused on every device; a missing one only where the PIN is demanded
			if (terminal.pinRequired ? !pinMatches : pin !== null && !pinMatches) {
				pinGuard.fail({ userId: user.id, now: now() });
				throw problem(401, "invalid_credentials", "badge or PIN is not known");
			}
			// the correct PIN clears the counter of that account
			pinGuard.reset(user.id);

			const timestamp = now();
			const stored = entries.insert({
				userId: user.id,
				tsUtc: body.tsUtc ?? timestamp,
				timeZone: user.timezone,
				source: "terminal",
				direction: body.direction,
				note: body.note,
				actorId: user.id,
				actorIp: context.request.remoteAddress ?? null,
				now: timestamp,
			});
			const day = aggregation.recalculateDay(user.id, stored.entry.localDate, { now: timestamp });
			terminals.touch({ id: terminal.id, ttlMinutes: TERMINAL_SESSION_MINUTES, now: timestamp });
			emit({
				type: "terminal.punch",
				userId: user.id,
				data: {
					entryId: stored.entry.id,
					localDate: stored.entry.localDate,
					terminalId: terminal.id,
					terminalName: terminal.name,
				},
			});

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
					// the worked time of the day only when the work profile of the employee allows it: the
					// presence card is public, so the same rule as in `/terminal/users` applies here
					workedMin: users.getWorkProfile(user.id)?.showWorkedTime === true ? day.workedMin : undefined,
					targetMin: day.targetMin,
					balanceMin: day.balanceMin,
					hasOpenEntry: day.hasOpenEntry,
				},
			});
		},
	);

	// terminals and PINs (administration)

	route("GET", "/terminals", { permission: "terminal.manage" }, () =>
		json(200, { terminals: terminals.list({ includeInactive: true }).map(publicTerminal) }),
	);

	route("POST", "/terminals", { permission: "terminal.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = parseBody(TERMINAL_BODY, context.jsonBody());
		const created = terminals.create({
			name: body.name,
			location: body.location,
			pinRequired: body.pinRequired ?? undefined,
			userIds: body.userIds ?? undefined,
			ttlDays: body.ttlDays,
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

	route("PUT", "/terminals/:id/users", { permission: "terminal.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		// an empty list means “all employees”, which is also how a terminal starts its life
		const userIds = parseBody(TERMINAL_USERS_BODY, context.jsonBody()).userIds ?? [];
		for (const userId of userIds) {
			if (!users.findById(userId)) {
				throw new ValidationError(`user ${userId} does not exist`);
			}
		}

		const terminal = terminals.setUsers({
			id,
			userIds,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, { terminal: publicTerminal(terminal) });
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
		const { pin } = parseBody(PIN_BODY, context.jsonBody());
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
}
