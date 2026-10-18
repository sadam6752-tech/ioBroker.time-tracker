/**
 * Punching, offline synchronisation, conflicts, aggregates and punches written by the administration.
 */

import { NotFoundError, ValidationError } from "../../errors";
import { localDate } from "../../util/time";
import { problem } from "../problem";
import { json } from "../router";

import type { ApiContext } from "./context";
import { requireString, optionalString, optionalNumber, numberParam, optionalDirection } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerTimeRoutes(ctx: ApiContext): void {
	const { users, entries, aggregation, sync, settings, now, emit, route, scopeUser, numberQuery, punch } = ctx;

	// punching

	route(
		"POST",
		"/punch",
		{ permission: "time.punch", csrf: true, rateLimit: { name: "punch", limit: 60, windowSeconds: 60 } },
		context => punch(context, { quick: false }),
	);

	route(
		"POST",
		"/punch/quick",
		{ permission: "time.punch", csrf: true, rateLimit: { name: "punch", limit: 60, windowSeconds: 60 } },
		context => punch(context, { quick: true }),
	);

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

	route(
		"POST",
		"/entries/sync",
		{ permission: "time.punch", csrf: true, rateLimit: { name: "sync", limit: 30, windowSeconds: 60 } },
		context => {
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
				// the offline queue is the only way an employee still writes a punch of his own, so the window of the
				// instance applies to it as well (`0` switches the bound off)
				maxPastSeconds: Math.max(0, settings.getNumber("edit_window_days", 0)) * 86_400,
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
			// the batch belongs to one employee: their day changed, so their clients refresh it
			emit({
				type: "punch",
				userId: user.id,
				data: {
					synced: result.accepted.filter(entry => entry.created).length,
					duplicates: result.accepted.filter(entry => !entry.created).length,
					conflicts: result.conflicts.length,
					rejected: result.rejected.length,
					days: result.recalculated.length,
				},
			});
			return json(200, result);
		},
	);

	route("GET", "/entries/conflicts", { permission: "time.resolve_conflict" }, context =>
		// without `?userId=` the own queue; the administration reads the queue of an employee with it, because a
		// conflict of an employee waits for a decision of the office
		json(200, {
			conflicts: sync.conflicts(scopeUser(context, "time.resolve_conflict", "time.resolve_conflict")),
		}),
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
		if (result.entry) {
			emit({
				type: "entry.update",
				userId: result.entry.userId,
				data: { entryId: result.entry.id, localDate: result.entry.localDate, resolved: action },
			});
		}
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

	// A punch written by hand is an administrative correction: an employee does not edit his own times, he leaves a
	// day note for the administration (`time.edit_own` is that right) and the administration books the day.
	route("POST", "/entries", { permission: "time.edit_other", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const target = Number(context.query("userId") ?? context.auth.user.id);
		if (!Number.isInteger(target)) {
			throw new ValidationError("userId must be a whole number");
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
			// a hand-written punch is always a correction; the normal punch comes through `POST /punch` (`web`)
			source: "admin",
			direction: optionalDirection(body),
			idempotencyKey: optionalString(body, "idempotencyKey"),
			note: optionalString(body, "note"),
			reason: optionalString(body, "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: timestamp,
		});

		const day = aggregation.recalculateDay(target, stored.entry.localDate, { now: timestamp });
		emit({
			type: "punch",
			userId: target,
			data: {
				entryId: stored.entry.id,
				created: stored.created,
				localDate: stored.entry.localDate,
				source: "admin",
			},
		});
		return json(
			201,
			{ entry: stored.entry, created: stored.created, day },
			{ location: `/entries/${stored.entry.id}` },
		);
	});
}
