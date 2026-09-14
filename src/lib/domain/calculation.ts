/**
 * Calculation service: day balance, monthly sums, overtime models and vacation.
 *
 * The formulas follow the internal specification (section 3.3–3.6) and were verified against the legacy
 * system: balance = worked − break − target, overtime is carried per month (or yearly), the annual
 * “Vorholzeit” is credited monthly, payouts reduce the overtime balance.
 */

import { applyPauses, type BreakResult, type PauseRule } from "./breaks";
import { buildDayPunches, type PairingOptions, type PunchEntry, type PunchPair } from "./punch";
import { isWorkdayOn, targetForDay, type AbsenceImpact, type WorkProfile } from "./target";
import { dateRange, dayOfWeek, localDate } from "../util/time";

/** Supported overtime models (`work_profiles.overtime_model`). */
export type OvertimeModel = "cumulative" | "yearly" | "monthly";

/** Input for the calculation of one day. */
export interface DayCalculationInput {
	/** Employment parameters */
	profile: WorkProfile;
	/** Punches of that day */
	entries: PunchEntry[];
	/** Graduated break rules */
	pauseRules?: PauseRule[];
	/** Time zone of the employee */
	timeZone: string;
	/** Local date to calculate */
	localDate: string;
	/** True when the day is a public holiday */
	isHoliday?: boolean;
	/** Absence covering the day, if any */
	absence?: AbsenceImpact | null;
	/** Pairing options (duplicate protection) */
	pairing?: PairingOptions;
}

/** Result of the calculation of one day. */
export interface DayCalculation {
	/** Local date the calculation belongs to */
	localDate: string;
	/** Weekday, 0 = Sunday */
	weekday: number;
	/** Pairs of the day in chronological order */
	pairs: PunchPair[];
	/** True when the last punch has no counterpart yet */
	hasOpenEntry: boolean;
	/** Instant of the first punch of the day */
	firstInUtc: number | null;
	/** Instant of the last completed clock-out, `null` while a punch is open */
	lastOutUtc: number | null;
	/** Pair durations before break deduction */
	grossMinutes: number;
	/** Deducted breaks */
	breakMinutes: number;
	/** Net working time */
	workedMinutes: number;
	/** Target time of the day */
	targetMinutes: number;
	/** workedMinutes − targetMinutes */
	balanceMinutes: number;
	/** Detailed break calculation */
	breaks: BreakResult;
}

/** Aggregated values of a period (month or year). */
export interface PeriodTotals {
	/** Net working time of the period */
	workedMinutes: number;
	/** Target time of the period */
	targetMinutes: number;
	/** workedMinutes − targetMinutes */
	balanceMinutes: number;
	/** Number of days in the period */
	days: number;
	/** Number of days with an open punch */
	openDays: number;
}

/**
 * Calculates the balance of one day.
 *
 * @param input - day calculation input
 * @returns day calculation result
 */
export function calculateDay(input: DayCalculationInput): DayCalculation {
	const day = buildDayPunches(input.entries, input.pairing);
	const breaks = applyPauses(day.pairs, input.pauseRules ?? []);
	const weekday = dayOfWeek(input.localDate, input.timeZone);

	const startDate = input.profile.startDate == null ? null : localDate(input.profile.startDate, input.timeZone);
	const endDate = input.profile.endDate == null ? null : localDate(input.profile.endDate, input.timeZone);

	const targetMinutes = targetForDay({
		profile: input.profile,
		weekday,
		isHoliday: input.isHoliday,
		absence: input.absence,
		isBeforeStart: startDate !== null && input.localDate < startDate,
		isAfterEnd: endDate !== null && input.localDate > endDate,
	});

	return {
		localDate: input.localDate,
		weekday,
		pairs: day.pairs,
		hasOpenEntry: day.hasOpenEntry,
		firstInUtc: day.firstInUtc,
		lastOutUtc: day.lastOutUtc,
		grossMinutes: breaks.grossMinutes,
		breakMinutes: breaks.breakMinutes,
		workedMinutes: breaks.workedMinutes,
		targetMinutes,
		balanceMinutes: breaks.workedMinutes - targetMinutes,
		breaks,
	};
}

/**
 * Sums up the days of a period.
 *
 * @param days - calculated days
 * @returns totals of the period
 */
export function sumPeriod(days: DayCalculation[]): PeriodTotals {
	return days.reduce<PeriodTotals>(
		(totals, day) => ({
			workedMinutes: totals.workedMinutes + day.workedMinutes,
			targetMinutes: totals.targetMinutes + day.targetMinutes,
			balanceMinutes: totals.balanceMinutes + day.balanceMinutes,
			days: totals.days + 1,
			openDays: totals.openDays + (day.hasOpenEntry ? 1 : 0),
		}),
		{ workedMinutes: 0, targetMinutes: 0, balanceMinutes: 0, days: 0, openDays: 0 },
	);
}

/**
 * Sums the monthly balances to the overtime of the period.
 *
 * @param monthBalances - balance per month in minutes
 * @returns overtime of the period in minutes
 */
export function overtimeOfPeriod(monthBalances: number[]): number {
	return monthBalances.reduce((sum, balance) => sum + balance, 0);
}

/**
 * Annual “Vorholzeit” credited for the active months.
 *
 * @param vorholzeitPerYearMinutes - annual Vorholzeit in minutes
 * @param activeMonths - number of active months in the period
 * @returns credited minutes (rounded)
 */
export function vorholzeitForActiveMonths(vorholzeitPerYearMinutes: number, activeMonths: number): number {
	const months = Math.max(0, Math.min(12, activeMonths));
	return Math.round((vorholzeitPerYearMinutes / 12) * months);
}

/** Input of the overtime calculation. */
export interface OvertimeInput {
	/** Overtime model of the employee */
	model: OvertimeModel;
	/** Balance per month in minutes (index 0 = January, gaps are `0`) */
	monthBalances: number[];
	/** Carryover at the beginning of the period (from the previous year) */
	overtimeStartMinutes: number;
	/** Annual “Vorholzeit” in minutes (`work_profiles.vorholzeit_per_year`) */
	vorholzeitPerYearMinutes?: number;
	/** Active months inside the period (defaults to the number of given months) */
	activeMonths?: number;
	/** Overtime paid out in the period (reduces the balance) */
	payoutMinutes?: number;
	/** True when the period is a complete calendar year (January to December) */
	completeYear?: boolean;
}

/** Result of the overtime calculation. */
export interface OvertimeResult {
	/** Sum of the monthly balances of the period */
	monthOvertimeMinutes: number;
	/** Credited “Vorholzeit” of the period */
	vorholzeitMinutes: number;
	/** Carried overtime after the period */
	overtimeMinutes: number;
	/** True when the yearly model has not reached its calculation point yet */
	pending: boolean;
}

/**
 * Carried overtime after a period.
 *
 * - `monthly`: balance is carried month by month.
 * - `cumulative`: identical to `monthly`, but the caller passes the running value as `overtimeStartMinutes`
 *   so the balance survives the year boundary.
 * - `yearly`: the balance is only computed at the end of the calendar year; until then the carryover is
 *   reported unchanged (`pending = true`), matching the legacy behaviour.
 *
 * @param input - overtime calculation input
 * @returns carried overtime plus the intermediate values
 */
export function overtimeAfterPeriod(input: OvertimeInput): OvertimeResult {
	const monthOvertimeMinutes = overtimeOfPeriod(input.monthBalances);
	const vorholzeitMinutes = vorholzeitForActiveMonths(
		input.vorholzeitPerYearMinutes ?? 0,
		input.activeMonths ?? input.monthBalances.length,
	);

	if (input.model === "yearly" && input.completeYear !== true) {
		return {
			monthOvertimeMinutes,
			vorholzeitMinutes: 0,
			overtimeMinutes: input.overtimeStartMinutes,
			pending: true,
		};
	}

	const overtimeMinutes =
		input.overtimeStartMinutes + monthOvertimeMinutes - vorholzeitMinutes - (input.payoutMinutes ?? 0);

	return { monthOvertimeMinutes, vorholzeitMinutes, overtimeMinutes, pending: false };
}

/** Input of the vacation (holiday) balance. */
export interface VacationInput {
	/** Days carried over from the previous year */
	carryoverDays: number;
	/** Annual entitlement in days */
	perYearDays: number;
	/** Days already taken */
	usedDays: number;
	/** Days approved but not taken yet (reported separately) */
	plannedDays?: number;
}

/** Vacation balance of a year. */
export interface VacationResult {
	/** Entitlement including the carryover */
	entitlementDays: number;
	/** Remaining days after the taken days */
	leftDays: number;
	/** Remaining days after the taken **and** planned days */
	availableDays: number;
	/** Approved but not yet taken days */
	plannedDays: number;
}

/**
 * Vacation balance of a year (`carryover + entitlement − used`).
 *
 * Planned but not yet taken days are reported separately so the UI can show “left” and “after planned”.
 *
 * @param input - vacation input
 * @returns vacation balance
 */
export function vacationBalance(input: VacationInput): VacationResult {
	const entitlementDays = roundDays(input.carryoverDays + input.perYearDays);
	const leftDays = roundDays(entitlementDays - input.usedDays);
	const plannedDays = roundDays(input.plannedDays ?? 0);
	return { entitlementDays, leftDays, availableDays: roundDays(leftDays - plannedDays), plannedDays };
}

/**
 * Vacation/absence days inside a date range.
 *
 * Only active working days are counted (weekends and holidays are free), weighted by the day portion
 * (0.5 for a half day).
 *
 * @param input - range, portion and calendar data
 * @param input.from - first local date, `YYYY-MM-DD`
 * @param input.to - last local date, `YYYY-MM-DD`
 * @param input.workdays - `workdays` field of the employee
 * @param input.timeZone - time zone used to resolve the weekdays
 * @param input.holidays - local dates of the public holidays of the period
 * @param input.dayPortion - portion of each day (1 = whole day)
 * @returns counted days, rounded to two decimals
 */
export function absenceDaysInRange(input: {
	from: string;
	to: string;
	workdays: string;
	timeZone: string;
	holidays?: ReadonlySet<string>;
	dayPortion?: number;
}): number {
	const portion = input.dayPortion ?? 1;
	if (!(portion > 0)) {
		return 0;
	}

	let days = 0;
	for (const date of dateRange(input.from, input.to)) {
		if (!isWorkdayOn(input.workdays, dayOfWeek(date, input.timeZone))) {
			continue;
		}
		if (input.holidays?.has(date)) {
			continue;
		}
		days += portion;
	}
	return roundDays(days);
}

/**
 * Rounds a day value to two decimals (avoids float noise like 24.999999).
 *
 * @param value - raw day value
 * @returns rounded value
 */
function roundDays(value: number): number {
	return Math.round(value * 100) / 100;
}
