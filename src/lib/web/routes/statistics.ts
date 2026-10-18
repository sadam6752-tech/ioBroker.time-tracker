/**
 * Statistics of the administration.
 */

import { ValidationError } from "../../errors";
import { dateRange } from "../../util/time";
import { problem } from "../problem";
import { json } from "../router";

import type { ApiContext } from "./context";
import { MAX_STATISTICS_DAYS } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerStatisticsRoutes(ctx: ApiContext): void {
	const { users, aggregation, now, route } = ctx;

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
}
