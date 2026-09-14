/**
 * Closing service: the administrative workflow around the aggregates.
 *
 * Closing a month recalculates it (and its year) and optionally records an overtime payout — the payout is
 * written first, so the overtime of the closing already accounts for it. Settling a year recalculates it
 * with `settled = true`, which finishes the `yearly` overtime model and freezes the result.
 *
 * Both operations are audited (`month.close`, `year.settle`), so a closing can always be traced back to the
 * person who did it.
 */

import type { Db } from "../db/database";
import type { PayoutRecord, PayoutsRepository } from "../db/repositories/payouts";
import type { AggregationService, MonthAggregateRecord, YearAggregateRecord } from "./aggregation";
import { ValidationError } from "../errors";
import { writeAuditLog } from "../db/repositories/audit";

/** Data sources of the closing service. */
export interface ClosingDeps {
	/** Open database handle */
	db: Db;
	/** Aggregation service used for the recalculation */
	aggregation: AggregationService;
	/** Payout storage */
	payouts: PayoutsRepository;
}

/** Input for closing a month. */
export interface CloseMonthInput {
	/** Employee whose month is closed */
	userId: number;
	/** Four digit year */
	year: number;
	/** Month, 1 to 12 */
	month: number;
	/** Overtime to pay out with this closing, in minutes */
	payoutMinutes?: number;
	/** Amount paid with this closing, informational only */
	payoutAmount?: number | null;
	/** Note stored with the payout */
	note?: string | null;
	/** Who closes the month */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Local date up to which days are aggregated (default: today in the user's time zone) */
	upToDate?: string;
	/** Instant of the closing, defaults to now */
	now?: number;
}

/** Result of closing a month. */
export interface CloseMonthResult {
	/** Monthly aggregate after the closing */
	month: MonthAggregateRecord;
	/** Yearly aggregate after the closing */
	year: YearAggregateRecord;
	/** Payout recorded with the closing, `null` when no overtime was paid out */
	payout: PayoutRecord | null;
	/** Instant of the closing */
	closedAt: number;
}

/** Input for settling a year. */
export interface SettleYearInput {
	/** Employee whose year is settled */
	userId: number;
	/** Four digit year */
	year: number;
	/** Who settles the year */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Local date up to which days are aggregated (default: today in the user's time zone) */
	upToDate?: string;
	/** Instant of the closing, defaults to now */
	now?: number;
}

/** Result of settling a year. */
export interface SettleYearResult {
	/** Yearly aggregate after the closing */
	year: YearAggregateRecord;
	/** Instant of the closing */
	closedAt: number;
}

/** Closing operations. */
export interface ClosingService {
	/** Recalculates a month and its year, optionally paying out overtime */
	closeMonth(input: CloseMonthInput): CloseMonthResult;
	/** Recalculates a year and marks it as settled */
	settleYear(input: SettleYearInput): SettleYearResult;
}

/**
 * Creates the closing service.
 *
 * @param deps - data sources
 * @returns service instance
 */
export function createClosingService(deps: ClosingDeps): ClosingService {
	const { db, aggregation, payouts } = deps;

	return {
		closeMonth(input: CloseMonthInput): CloseMonthResult {
			if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
				throw new ValidationError(`month must be between 1 and 12 (got ${input.month})`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const payoutMinutes = input.payoutMinutes ?? 0;

			// the payout is recorded first so the recalculation already includes it
			const payout =
				payoutMinutes === 0
					? null
					: payouts.create({
							userId: input.userId,
							year: input.year,
							month: input.month,
							minutes: payoutMinutes,
							amount: input.payoutAmount ?? null,
							note: input.note ?? `Monatsabschluss ${input.year}-${String(input.month).padStart(2, "0")}`,
							actorId: input.actorId,
							actorIp: input.actorIp ?? null,
							now,
						});

			const month = aggregation.recalculateMonth(input.userId, input.year, input.month, {
				now,
				upToDate: input.upToDate,
			});
			const year = aggregation.recalculateYear(input.userId, input.year, { now, upToDate: input.upToDate });

			writeAuditLog(db, {
				atUtc: now,
				actorId: input.actorId,
				action: "month.close",
				entity: "month_aggregate",
				entityId: `${input.userId}:${input.year}-${String(input.month).padStart(2, "0")}`,
				detail: {
					year: input.year,
					month: input.month,
					workedMin: month.workedMin,
					targetMin: month.targetMin,
					balanceMin: month.balanceMin,
					overtimeMin: month.overtimeMin,
					vacationUsed: month.vacationUsed,
					payoutMinutes: payout ? payout.minutes : 0,
					note: input.note ?? null,
				},
				ip: input.actorIp ?? null,
			});

			return { month, year, payout, closedAt: now };
		},

		settleYear(input: SettleYearInput): SettleYearResult {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const year = aggregation.recalculateYear(input.userId, input.year, {
				settled: true,
				now,
				upToDate: input.upToDate,
			});

			writeAuditLog(db, {
				atUtc: now,
				actorId: input.actorId,
				action: "year.settle",
				entity: "year_aggregate",
				entityId: `${input.userId}:${input.year}`,
				detail: {
					year: input.year,
					workedMin: year.workedMin,
					targetMin: year.targetMin,
					overtimeMin: year.overtimeMin,
					vacationUsed: year.vacationUsed,
					vacationLeft: year.vacationLeft,
					settled: year.settled,
				},
				ip: input.actorIp ?? null,
			});

			return { year, closedAt: now };
		},
	};
}
