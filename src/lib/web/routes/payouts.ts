/**
 * Paid out overtime and the bulk import of punches.
 */

import { NotFoundError, ValidationError } from "../../errors";
import { problem, toProblem } from "../problem";
import { json, noContent } from "../router";

import type { ApiContext } from "./context";
import { optionalString, optionalNumber, readPeriod, numberParam, optionalDirection } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerPayoutRoutes(ctx: ApiContext): void {
	const { users, entries, payouts, aggregation, now, emit, route } = ctx;

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

	route(
		"POST",
		"/entries/bulk",
		{ permission: "time.import", csrf: true, rateLimit: { name: "import", limit: 10, windowSeconds: 60 } },
		context => {
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
			const results: {
				/** Position of the punch in the request */
				index: number;
				/** Id of the stored punch, missing when it was rejected */
				entryId?: number;
				/** Reason of the rejection, missing when the punch was stored */
				error?: string;
			}[] = [];

			(body.entries as unknown[]).forEach((raw, index) => {
				try {
					const item = (raw ?? {}) as Record<string, unknown>;
					const target = Number(item.userId ?? actor.user.id);
					if (!Number.isInteger(target)) {
						throw new ValidationError("userId must be a whole number");
					}
					// writing punches for somebody else needs the matching permission
					if (target !== actor.user.id && !actor.permissions.includes("time.edit_other")) {
						throw problem(
							403,
							"permission_denied",
							"request rejected (permission_denied: time.edit_other)",
						);
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
			// one event per touched employee: the import may mix several of them
			for (const [key, userId] of touched) {
				emit({
					type: "punch",
					userId,
					data: { imported: true, localDate: key.split("|")[1], source: "import" },
				});
			}
			return json(200, {
				imported,
				failed: results.length - imported,
				recalculatedDays: touched.size,
				results,
			});
		},
	);
}
