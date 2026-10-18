/**
 * Paid out overtime and the bulk import of punches.
 */

import { NotFoundError, ValidationError } from "../../errors";
import { problem, toProblem } from "../problem";
import { json, noContent } from "../router";

import type { ApiContext } from "./context";
import { z } from "zod";
import {
	bodySchema,
	check,
	employeeRef,
	keepMissing,
	listOf,
	optionalMonth,
	optionalNumber,
	optionalText,
	parseBody,
	punchDirection,
	requiredNumber,
	year,
} from "./validate";
import { readPeriod, numberParam } from "./shared";

/** Message of a payout without a usable number of minutes. */
const MINUTES_MESSAGE = "minutes must be a non-zero whole number";

/** Body of a payout of overtime. */
const PAYOUT_BODY = bodySchema({
	userId: employeeRef({ nullIsMissing: true }),
	year: year(),
	month: optionalMonth(),
	minutes: check(
		requiredNumber(MINUTES_MESSAGE),
		value => Number.isInteger(value) && value !== 0,
		() => MINUTES_MESSAGE,
	),
	amount: optionalNumber(),
	note: optionalText(),
});

/** Body of a change of a payout; a field that is not sent keeps its value. */
const PAYOUT_PATCH_BODY = bodySchema({
	minutes: check(
		optionalNumber(),
		value => value === null || (Number.isInteger(value) && value !== 0),
		() => MINUTES_MESSAGE,
	),
	amount: keepMissing(optionalNumber()),
	note: keepMissing(optionalText()),
});

/** Body of a bulk import: the rows are checked one by one (`BULK_ITEM`). */
const BULK_BODY = bodySchema({ entries: listOf(z.unknown()) });

/** One row of a bulk import. */
const BULK_ITEM = bodySchema({
	userId: employeeRef({ nullIsMissing: true, message: "userId must be a whole number" }),
	tsUtc: requiredNumber(),
	clientTsUtc: optionalNumber(),
	direction: punchDirection(),
	idempotencyKey: optionalText(),
	note: optionalText(),
});

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
		const body = parseBody(PAYOUT_BODY, context.jsonBody());
		const target = body.userId ?? context.auth.user.id;
		if (!users.findById(target)) {
			throw new ValidationError("userId must reference an existing employee");
		}

		const created = payouts.create({
			userId: target,
			year: body.year,
			month: body.month,
			minutes: body.minutes,
			amount: body.amount,
			note: body.note,
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
		const body = parseBody(PAYOUT_PATCH_BODY, context.jsonBody());

		const updated = payouts.update({
			id,
			patch: {
				...(body.minutes !== null ? { minutes: body.minutes } : {}),
				...(body.amount !== undefined ? { amount: body.amount } : {}),
				...(body.note !== undefined ? { note: body.note } : {}),
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
			const body = parseBody(BULK_BODY, context.jsonBody());

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

			body.entries.forEach((raw, index) => {
				try {
					// every row is checked on its own: a faulty row is reported, the others are imported
					const item = parseBody(BULK_ITEM, raw ?? {});
					const target = item.userId ?? actor.user.id;
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
					const stored = entries.insert({
						userId: target,
						tsUtc: item.tsUtc,
						clientTsUtc: item.clientTsUtc,
						timeZone: user.timezone,
						source: "import",
						direction: item.direction,
						idempotencyKey: item.idempotencyKey,
						note: item.note,
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
