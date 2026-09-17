/**
 * Aggregation service: keeps the day, month and year aggregates in sync with the punches.
 *
 * The daily figures come from the calculation service (a pure function); this service only supplies the
 * data (punches, employment profile, break rules, holidays, absences) and stores the result. Months and
 * years are always derived from the day rows, so a single day can be recalculated without leaving the
 * reports inconsistent.
 *
 * Days after "today" are not aggregated by default: future weekdays would otherwise add target time and
 * produce a phantom negative balance. Callers can pass `upToDate` (tests, imports) or `includeFuture`.
 */

import type { Db } from "../db/database";
import type { AbsencesRepository, AbsenceWithType } from "../db/repositories/absences";
import type { EntriesRepository } from "../db/repositories/entries";
import type { HolidaysRepository } from "../db/repositories/holidays";
import type { RulesRepository } from "../db/repositories/rules";
import type { SettingsRepository } from "../db/repositories/settings";
import type { UsersRepository, WorkProfileRecord } from "../db/repositories/users";
import type { WorkProfile } from "../domain/target";
import { ValidationError } from "../errors";
import { absenceDaysInRange, calculateDay, overtimeAfterPeriod } from "../domain/calculation";
import type { PauseMode } from "../domain/breaks";
import { toPunchEntries } from "../db/repositories/entries";
import { dateRange, daysInMonth, localDate as resolveLocalDate, utcToWallTime } from "../util/time";

/** Daily aggregate as stored in `day_aggregates`. */
export interface DayAggregateRecord {
	/** Owner of the day */
	userId: number;
	/** Local date, `YYYY-MM-DD` */
	localDate: string;
	/** Net working time in minutes */
	workedMin: number;
	/** Deducted breaks in minutes */
	breakMin: number;
	/** Part of the deducted break that is paid (in minutes) */
	paidBreakMin: number;
	/** Target time in minutes */
	targetMin: number;
	/** `workedMin - targetMin` */
	balanceMin: number;
	/** Code of the absence covering the day, `null` when there is none */
	absenceCode: string | null;
	/** True when the day is a public holiday */
	isHoliday: boolean;
	/** Instant of the first punch of the day */
	firstInUtc: number | null;
	/** Instant of the last completed clock-out */
	lastOutUtc: number | null;
	/** True when the last punch has no counterpart yet */
	hasOpenEntry: boolean;
	/** Instant of the last recalculation */
	updatedAt: number;
}

/** Monthly aggregate as stored in `month_aggregates`. */
export interface MonthAggregateRecord {
	/** Owner of the month */
	userId: number;
	/** Four digit year */
	year: number;
	/** Month, 1 to 12 */
	month: number;
	/** Net working time in minutes */
	workedMin: number;
	/** Target time in minutes */
	targetMin: number;
	/** `workedMin - targetMin` */
	balanceMin: number;
	/** Overtime carried at the end of the month (per model) */
	overtimeMin: number;
	/** Vacation days taken in the month */
	vacationUsed: number;
	/** Instant of the last recalculation */
	updatedAt: number;
}

/** Yearly aggregate as stored in `year_aggregates`. */
export interface YearAggregateRecord {
	/** Owner of the year */
	userId: number;
	/** Four digit year */
	year: number;
	/** Net working time in minutes */
	workedMin: number;
	/** Target time in minutes */
	targetMin: number;
	/** Overtime carried at the end of the year */
	overtimeMin: number;
	/** Overtime taken over from the previous year */
	overtimeStart: number;
	/** Vacation entitlement including the carryover */
	vacationDays: number;
	/** Vacation days taken */
	vacationUsed: number;
	/** Remaining vacation days */
	vacationLeft: number;
	/** Vacation days approved but not yet taken */
	vacationPlannedDays: number;
	/** True when the year is closed */
	settled: boolean;
	/** Instant of the last recalculation */
	updatedAt: number;
}

/** Result of a range recalculation. */
export interface RangeResult {
	/** Number of recalculated days */
	days: number;
	/** Number of days with an open punch */
	openDays: number;
	/** Net working time of the range in minutes */
	workedMin: number;
	/** Pause of the range in minutes */
	breakMin: number;
	/** Part of the pause that is paid (in minutes) */
	paidBreakMin: number;
	/** Target time of the range in minutes */
	targetMin: number;
	/** Balance of the range in minutes */
	balanceMin: number;
}

/** Options shared by the recalculation methods. */
export interface RecalculateOptions {
	/** Local date up to which days are aggregated (default: today in the user's time zone) */
	upToDate?: string;
	/** True to aggregate days after `upToDate` as well */
	includeFuture?: boolean;
	/** True to treat the year as complete for the `yearly` overtime model */
	settled?: boolean;
	/** Instant of the recalculation, defaults to now */
	now?: number;
}

/** Data sources of the aggregation service. */
export interface AggregationDeps {
	/** Open database handle */
	db: Db;
	/** User storage */
	users: UsersRepository;
	/** Punch storage */
	entries: EntriesRepository;
	/** Absence storage */
	absences: AbsencesRepository;
	/** Holiday storage */
	holidays: HolidaysRepository;
	/** Break and surcharge rules */
	rules: RulesRepository;
	/** Instance settings */
	settings: SettingsRepository;
}

/** Aggregation operations. */
export interface AggregationService {
	/** Recalculates one day and stores the aggregate */
	recalculateDay(userId: number, localDate: string, options?: RecalculateOptions): DayAggregateRecord;
	/** Recalculates every day of a range */
	recalculateRange(userId: number, from: string, to: string, options?: RecalculateOptions): RangeResult;
	/** Recalculates a month from its days and stores the monthly aggregate */
	recalculateMonth(userId: number, year: number, month: number, options?: RecalculateOptions): MonthAggregateRecord;
	/** Recalculates a year from its months and stores the yearly aggregate */
	recalculateYear(userId: number, year: number, options?: RecalculateOptions): YearAggregateRecord;
	/** Stored day aggregate */
	day(userId: number, localDate: string): DayAggregateRecord | null;
	/** Stored day aggregates of a range */
	days(userId: number, from: string, to: string): DayAggregateRecord[];
	/** Stored monthly aggregate */
	month(userId: number, year: number, month: number): MonthAggregateRecord | null;
	/** Stored yearly aggregate */
	year(userId: number, year: number): YearAggregateRecord | null;
	/** Recomputes the local date/time cache of all punches of a user (after a time zone change) */
	recalculateLocalCaches(userId: number): number;
}

interface DayRow {
	user_id: number;
	local_date: string;
	worked_min: number;
	break_min: number;
	paid_break_min: number;
	target_min: number;
	balance_min: number;
	absence_code: string | null;
	is_holiday: number;
	first_in_utc: number | null;
	last_out_utc: number | null;
	has_open_entry: number;
	updated_at: number;
}

interface MonthRow {
	user_id: number;
	year: number;
	month: number;
	worked_min: number;
	target_min: number;
	balance_min: number;
	overtime_min: number;
	vacation_used: number;
	updated_at: number;
}

interface YearRow {
	user_id: number;
	year: number;
	worked_min: number;
	target_min: number;
	overtime_min: number;
	overtime_start: number;
	vacation_days: number;
	vacation_used: number;
	vacation_left: number;
	vacation_planned_days: number;
	settled: number;
	updated_at: number;
}

const DAY_COLUMNS = `user_id, local_date, worked_min, break_min, paid_break_min, target_min, balance_min, absence_code,
\tis_holiday, first_in_utc, last_out_utc, has_open_entry, updated_at`;

const MONTH_COLUMNS = `user_id, year, month, worked_min, target_min, balance_min, overtime_min, vacation_used,
\tupdated_at`;

const YEAR_COLUMNS = `user_id, year, worked_min, target_min, overtime_min, overtime_start, vacation_days,
\tvacation_used, vacation_left, vacation_planned_days, settled, updated_at`;

/**
 * Employment defaults for users without stored profile: no target time and no carryovers.
 *
 * @param userId - owner of the profile
 * @returns profile with zero values
 */
function defaultProfile(userId: number): WorkProfileRecord {
	return {
		userId,
		percent: 0,
		weeklyHours: 0,
		workdays: "0;1;1;1;1;1;0",
		startDate: null,
		endDate: null,
		overtimeCarryover: 0,
		vorholzeitPerYear: 0,
		vacationCarryover: 0,
		vacationPerYear: 0,
		overtimeModel: "monthly",
		holidayFlags: null,
		pausePaidMinutes: 0,
	};
}

/**
 * Maps a database row to a day aggregate record.
 *
 * @param row - raw database row
 * @returns day aggregate
 */
export function mapDayRow(row: DayRow): DayAggregateRecord {
	return {
		userId: row.user_id,
		localDate: row.local_date,
		workedMin: row.worked_min,
		breakMin: row.break_min,
		paidBreakMin: row.paid_break_min,
		targetMin: row.target_min,
		balanceMin: row.balance_min,
		absenceCode: row.absence_code,
		isHoliday: row.is_holiday !== 0,
		firstInUtc: row.first_in_utc,
		lastOutUtc: row.last_out_utc,
		hasOpenEntry: row.has_open_entry !== 0,
		updatedAt: row.updated_at,
	};
}

/**
 * Maps a database row to a monthly aggregate record.
 *
 * @param row - raw database row
 * @returns monthly aggregate
 */
export function mapMonthRow(row: MonthRow): MonthAggregateRecord {
	return {
		userId: row.user_id,
		year: row.year,
		month: row.month,
		workedMin: row.worked_min,
		targetMin: row.target_min,
		balanceMin: row.balance_min,
		overtimeMin: row.overtime_min,
		vacationUsed: row.vacation_used,
		updatedAt: row.updated_at,
	};
}

/**
 * Maps a database row to a yearly aggregate record.
 *
 * @param row - raw database row
 * @returns yearly aggregate
 */
export function mapYearRow(row: YearRow): YearAggregateRecord {
	return {
		userId: row.user_id,
		year: row.year,
		workedMin: row.worked_min,
		targetMin: row.target_min,
		overtimeMin: row.overtime_min,
		overtimeStart: row.overtime_start,
		vacationDays: row.vacation_days,
		vacationUsed: row.vacation_used,
		vacationLeft: row.vacation_left,
		vacationPlannedDays: row.vacation_planned_days,
		settled: row.settled !== 0,
		updatedAt: row.updated_at,
	};
}

/**
 * Creates the aggregation service.
 *
 * @param deps - data sources
 * @returns service instance
 */
export function createAggregationService(deps: AggregationDeps): AggregationService {
	const { db, users, entries, absences, holidays, rules, settings } = deps;

	const selectDay = db.prepare(`SELECT ${DAY_COLUMNS} FROM day_aggregates WHERE user_id = ? AND local_date = ?`);
	const selectDays = db.prepare(
		`SELECT ${DAY_COLUMNS} FROM day_aggregates
		 WHERE user_id = ? AND local_date >= ? AND local_date <= ?
		 ORDER BY local_date`,
	);
	const upsertDay = db.prepare(
		`INSERT INTO day_aggregates (${DAY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, local_date) DO UPDATE SET
		     worked_min = excluded.worked_min,
		     break_min = excluded.break_min,
		     paid_break_min = excluded.paid_break_min,
		     target_min = excluded.target_min,
		     balance_min = excluded.balance_min,
		     absence_code = excluded.absence_code,
		     is_holiday = excluded.is_holiday,
		     first_in_utc = excluded.first_in_utc,
		     last_out_utc = excluded.last_out_utc,
		     has_open_entry = excluded.has_open_entry,
		     updated_at = excluded.updated_at`,
	);
	const selectMonth = db.prepare(
		`SELECT ${MONTH_COLUMNS} FROM month_aggregates WHERE user_id = ? AND year = ? AND month = ?`,
	);
	const upsertMonth = db.prepare(
		`INSERT INTO month_aggregates (${MONTH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, year, month) DO UPDATE SET
		     worked_min = excluded.worked_min,
		     target_min = excluded.target_min,
		     balance_min = excluded.balance_min,
		     overtime_min = excluded.overtime_min,
		     vacation_used = excluded.vacation_used,
		     updated_at = excluded.updated_at`,
	);
	const selectYear = db.prepare(`SELECT ${YEAR_COLUMNS} FROM year_aggregates WHERE user_id = ? AND year = ?`);
	const upsertYear = db.prepare(
		`INSERT INTO year_aggregates (${YEAR_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, year) DO UPDATE SET
		     worked_min = excluded.worked_min,
		     target_min = excluded.target_min,
		     overtime_min = excluded.overtime_min,
		     overtime_start = excluded.overtime_start,
		     vacation_days = excluded.vacation_days,
		     vacation_used = excluded.vacation_used,
		     vacation_left = excluded.vacation_left,
		     vacation_planned_days = excluded.vacation_planned_days,
		     settled = excluded.settled,
		     updated_at = excluded.updated_at`,
	);
	const selectPayouts = db.prepare(
		"SELECT COALESCE(SUM(minutes), 0) AS minutes FROM payouts WHERE user_id = ? AND year = ?",
	);
	const selectEntryCache = db.prepare("SELECT id, ts_utc AS tsUtc FROM time_entries WHERE user_id = ?");
	const updateEntryCache = db.prepare("UPDATE time_entries SET ts_local = ?, local_date = ? WHERE id = ?");

	const timeZoneOf = (userId: number): string => users.findById(userId)?.timezone ?? "UTC";
	const holidayRegion = (): string => settings.get("holiday_country") ?? "DE";

	/**
	 * How the pause of a day is determined.
	 *
	 * A stored value that is not one of the three modes falls back to the default, so a hand edited setting can
	 * never spoil a calculation.
	 *
	 * @returns the configured pause mode
	 */
	const pauseMode = (): PauseMode => {
		const stored = settings.get("pause_mode");
		return stored === "punched" || stored === "staffel" ? stored : "auto";
	};

	/**
	 * Reads the stored profile or the defaults (no target time, no carryovers).
	 *
	 * @param userId - owner of the profile
	 * @returns employment parameters
	 */
	const profileOf = (userId: number): WorkProfileRecord => users.getWorkProfile(userId) ?? defaultProfile(userId);

	/**
	 * Picks the absence of a day: the one crediting the largest part of the day wins, ties are broken by id.
	 *
	 * @param userId - owner of the absence
	 * @param date - local date
	 * @returns the covering absence or `null`
	 */
	const absenceFor = (userId: number, date: string): AbsenceWithType | null => {
		const covering = absences.withTypesInRange(userId, date, date);
		let best: AbsenceWithType | null = null;
		for (const absence of covering) {
			const share = (Math.max(0, Math.min(100, absence.factor)) / 100) * absence.dayPortion;
			const bestShare = best ? (Math.max(0, Math.min(100, best.factor)) / 100) * best.dayPortion : -1;
			if (share > bestShare || (share === bestShare && best !== null && absence.id < best.id)) {
				best = absence;
			}
		}
		return best;
	};

	/**
	 * Sum of the payouts of a year.
	 *
	 * @param userId - owner of the payouts
	 * @param year - four digit year
	 * @returns paid out minutes
	 */
	const payoutsOf = (userId: number, year: number): number =>
		(selectPayouts.get(userId, year) as { minutes: number }).minutes;

	/**
	 * Counts the months of a year that lie inside the employment period.
	 *
	 * @param profile - employment parameters
	 * @param year - four digit year
	 * @param upToMonth - last month to count (1 to 12)
	 * @param timeZone - time zone used to resolve the employment dates
	 * @returns number of active months
	 */
	const activeMonthsInYear = (profile: WorkProfile, year: number, upToMonth: number, timeZone: string): number => {
		const startDate = profile.startDate == null ? null : resolveLocalDate(profile.startDate, timeZone);
		const endDate = profile.endDate == null ? null : resolveLocalDate(profile.endDate, timeZone);
		const limit = Math.max(0, Math.min(12, upToMonth));
		let months = 0;

		for (let month = 1; month <= limit; month++) {
			const key = `${year}-${String(month).padStart(2, "0")}`;
			const first = `${key}-01`;
			const last = `${key}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
			if ((startDate === null || last >= startDate) && (endDate === null || first <= endDate)) {
				months++;
			}
		}
		return months;
	};

	/**
	 * Overtime taken over at the beginning of a year: the previous year's result or the profile carryover.
	 *
	 * @param userId - owner
	 * @param year - four digit year
	 * @param carryover - carryover of the profile (used for the first year)
	 * @returns overtime in minutes
	 */
	const overtimeStartFor = (userId: number, year: number, carryover: number): number => {
		const previous = selectYear.get(userId, year - 1) as YearRow | undefined;
		return previous ? previous.overtime_min : carryover;
	};

	/**
	 * Overtime carried after a month, following the model of the profile.
	 *
	 * @param args - month, balances, profile and flags
	 * @param args.userId - owner
	 * @param args.year - four digit year
	 * @param args.month - month, 1 to 12
	 * @param args.monthBalance - freshly calculated balance of that month (`null` to read it from the database)
	 * @param args.profile - employment parameters
	 * @param args.timeZone - time zone of the employee
	 * @param args.completeYear - true when the calendar year is finished
	 * @returns carried overtime in minutes
	 */
	const overtimeAfterMonth = (args: {
		userId: number;
		year: number;
		month: number;
		monthBalance: number | null;
		profile: WorkProfileRecord;
		timeZone: string;
		completeYear: boolean;
	}): number => {
		const balances: number[] = [];
		for (let index = 1; index <= args.month; index++) {
			if (index === args.month && args.monthBalance !== null) {
				balances.push(args.monthBalance);
				continue;
			}
			const row = selectMonth.get(args.userId, args.year, index) as MonthRow | undefined;
			balances.push(row?.balance_min ?? 0);
		}

		return overtimeAfterPeriod({
			model: args.profile.overtimeModel,
			monthBalances: balances,
			overtimeStartMinutes: overtimeStartFor(args.userId, args.year, args.profile.overtimeCarryover),
			vorholzeitPerYearMinutes: args.profile.vorholzeitPerYear,
			activeMonths: activeMonthsInYear(args.profile, args.year, args.month, args.timeZone),
			payoutMinutes: payoutsOf(args.userId, args.year),
			completeYear: args.completeYear,
		}).overtimeMinutes;
	};

	/**
	 * Vacation days of one kind inside a month or year.
	 *
	 * @param args - user, period and status
	 * @param args.userId - owner
	 * @param args.from - first local date
	 * @param args.to - last local date
	 * @param args.status - `taken` for used days, `planned` for approved days
	 * @param args.profile - employment parameters (working days)
	 * @param args.timeZone - time zone of the employee
	 * @returns vacation days, rounded to two decimals
	 */
	const vacationDaysInRange = (args: {
		userId: number;
		from: string;
		to: string;
		status: "taken" | "planned";
		profile: WorkProfileRecord;
		timeZone: string;
	}): number => {
		const year = Number(args.to.slice(0, 4));
		const holidayDates = holidays.dateSet(year, holidayRegion());
		const overlapping = absences.withTypesInRange(args.userId, args.from, args.to);

		let days = 0;
		for (const absence of overlapping) {
			if (!absence.reduceVacation || absence.status !== args.status) {
				continue;
			}
			const from = absence.dateFrom < args.from ? args.from : absence.dateFrom;
			const to = absence.dateTo > args.to ? args.to : absence.dateTo;
			if (from > to) {
				continue;
			}
			days += absenceDaysInRange({
				from,
				to,
				workdays: args.profile.workdays,
				timeZone: args.timeZone,
				holidays: holidayDates,
				dayPortion: absence.dayPortion,
			});
		}
		return Math.round(days * 100) / 100;
	};

	/**
	 * True when a calendar year is finished (needed by the `yearly` overtime model).
	 *
	 * @param year - four digit year
	 * @param todayDate - local date of the user
	 * @param settled - explicit flag of the caller
	 * @returns true when the year is closed
	 */
	const isCompleteYear = (year: number, todayDate: string, settled?: boolean): boolean =>
		settled === true || Number(todayDate.slice(0, 4)) > year;

	/**
	 * Calculates one day from the stored data (profile, rules, holidays, absences, punches).
	 *
	 * @param userId - owner
	 * @param localDate - local date to calculate
	 * @param now - instant of the recalculation
	 * @returns the calculated day
	 */
	const calculateDayFor = (userId: number, localDate: string, now: number): DayAggregateRecord => {
		const timeZone = timeZoneOf(userId);
		const absence = absenceFor(userId, localDate);
		const isHoliday = holidays.isHoliday(localDate, holidayRegion());
		const profile = profileOf(userId);
		const day = calculateDay({
			profile,
			entries: toPunchEntries(entries.listByDate(userId, localDate)),
			pauseRules: rules.pauseRules(userId),
			pauseMode: pauseMode(),
			pausePaidMinutes: profile.pausePaidMinutes,
			timeZone,
			localDate,
			isHoliday,
			absence: absence ? { factor: absence.factor, dayPortion: absence.dayPortion } : null,
		});

		return {
			userId,
			localDate,
			workedMin: day.workedMinutes,
			breakMin: day.breakMinutes,
			paidBreakMin: day.paidPauseMinutes,
			targetMin: day.targetMinutes,
			balanceMin: day.balanceMinutes,
			absenceCode: absence?.typeCode ?? null,
			isHoliday,
			firstInUtc: day.firstInUtc,
			lastOutUtc: day.lastOutUtc,
			hasOpenEntry: day.hasOpenEntry,
			updatedAt: now,
		};
	};

	return {
		recalculateDay(userId: number, localDate: string, options?: RecalculateOptions): DayAggregateRecord {
			const now = options?.now ?? Math.floor(Date.now() / 1000);
			const record = calculateDayFor(userId, localDate, now);

			const run = db.transaction((): void => {
				upsertDay.run(
					record.userId,
					record.localDate,
					record.workedMin,
					record.breakMin,
					record.paidBreakMin,
					record.targetMin,
					record.balanceMin,
					record.absenceCode,
					record.isHoliday ? 1 : 0,
					record.firstInUtc,
					record.lastOutUtc,
					record.hasOpenEntry ? 1 : 0,
					record.updatedAt,
				);
			});
			run();
			return record;
		},

		recalculateRange(userId: number, from: string, to: string, options?: RecalculateOptions): RangeResult {
			const totals: RangeResult = {
				days: 0,
				openDays: 0,
				workedMin: 0,
				breakMin: 0,
				paidBreakMin: 0,
				targetMin: 0,
				balanceMin: 0,
			};
			const run = db.transaction((): void => {
				for (const date of dateRange(from, to)) {
					const record = this.recalculateDay(userId, date, options);
					totals.days++;
					totals.workedMin += record.workedMin;
					totals.breakMin += record.breakMin;
					totals.paidBreakMin += record.paidBreakMin;
					totals.targetMin += record.targetMin;
					totals.balanceMin += record.balanceMin;
					totals.openDays += record.hasOpenEntry ? 1 : 0;
				}
			});
			run();
			return totals;
		},

		recalculateMonth(
			userId: number,
			year: number,
			month: number,
			options?: RecalculateOptions,
		): MonthAggregateRecord {
			if (!Number.isInteger(month) || month < 1 || month > 12) {
				throw new ValidationError(`month must be between 1 and 12 (got ${month})`);
			}

			const now = options?.now ?? Math.floor(Date.now() / 1000);
			const timeZone = timeZoneOf(userId);
			const profile = profileOf(userId);
			const upToDate = options?.upToDate ?? resolveLocalDate(now, timeZone);
			const key = `${year}-${String(month).padStart(2, "0")}`;
			const firstDay = `${key}-01`;
			const lastDay = `${key}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
			// days after `upToDate` are skipped unless the caller asks for them
			const endDate = options?.includeFuture === true || lastDay <= upToDate ? lastDay : upToDate;

			let workedMin = 0;
			let targetMin = 0;
			let balanceMin = 0;

			const run = db.transaction((): void => {
				for (const date of dateRange(firstDay, endDate)) {
					const record = this.recalculateDay(userId, date, options);
					workedMin += record.workedMin;
					targetMin += record.targetMin;
					balanceMin += record.balanceMin;
				}

				const vacationUsed = vacationDaysInRange({
					userId,
					from: firstDay,
					to: lastDay,
					status: "taken",
					profile,
					timeZone,
				});
				const overtimeMin = overtimeAfterMonth({
					userId,
					year,
					month,
					monthBalance: balanceMin,
					profile,
					timeZone,
					completeYear: isCompleteYear(year, upToDate, options?.settled),
				});

				upsertMonth.run(userId, year, month, workedMin, targetMin, balanceMin, overtimeMin, vacationUsed, now);
			});
			run();

			const saved = selectMonth.get(userId, year, month) as MonthRow | undefined;
			if (!saved) {
				throw new Error(`month aggregate ${key} disappeared right after the write`);
			}
			return mapMonthRow(saved);
		},

		recalculateYear(userId: number, year: number, options?: RecalculateOptions): YearAggregateRecord {
			const now = options?.now ?? Math.floor(Date.now() / 1000);
			const timeZone = timeZoneOf(userId);
			const profile = profileOf(userId);
			const upToDate = options?.upToDate ?? resolveLocalDate(now, timeZone);
			const settled = isCompleteYear(year, upToDate, options?.settled);
			const yearStart = `${year}-01-01`;
			const yearEnd = `${year}-12-31`;

			let workedMin = 0;
			let targetMin = 0;
			let overtimeMin = 0;

			const run = db.transaction((): void => {
				for (let month = 1; month <= 12; month++) {
					const row = this.recalculateMonth(userId, year, month, options);
					workedMin += row.workedMin;
					targetMin += row.targetMin;
				}
				// the carried overtime after December is the result of the year
				overtimeMin = overtimeAfterMonth({
					userId,
					year,
					month: 12,
					monthBalance: null,
					profile,
					timeZone,
					completeYear: settled,
				});

				const vacationDays = profile.vacationCarryover + profile.vacationPerYear;
				const vacationUsed = vacationDaysInRange({
					userId,
					from: yearStart,
					to: yearEnd,
					status: "taken",
					profile,
					timeZone,
				});
				const vacationPlanned = vacationDaysInRange({
					userId,
					from: yearStart,
					to: yearEnd,
					status: "planned",
					profile,
					timeZone,
				});

				upsertYear.run(
					userId,
					year,
					workedMin,
					targetMin,
					overtimeMin,
					overtimeStartFor(userId, year, profile.overtimeCarryover),
					Math.round(vacationDays * 100) / 100,
					vacationUsed,
					Math.round((vacationDays - vacationUsed) * 100) / 100,
					vacationPlanned,
					settled ? 1 : 0,
					now,
				);
			});
			run();

			const saved = selectYear.get(userId, year) as YearRow | undefined;
			if (!saved) {
				throw new Error(`year aggregate ${year} disappeared right after the write`);
			}
			return mapYearRow(saved);
		},

		day(userId: number, localDate: string): DayAggregateRecord | null {
			const row = selectDay.get(userId, localDate) as DayRow | undefined;
			return row ? mapDayRow(row) : null;
		},

		days(userId: number, from: string, to: string): DayAggregateRecord[] {
			return (selectDays.all(userId, from, to) as DayRow[]).map(mapDayRow);
		},

		month(userId: number, year: number, month: number): MonthAggregateRecord | null {
			const row = selectMonth.get(userId, year, month) as MonthRow | undefined;
			return row ? mapMonthRow(row) : null;
		},

		year(userId: number, year: number): YearAggregateRecord | null {
			const row = selectYear.get(userId, year) as YearRow | undefined;
			return row ? mapYearRow(row) : null;
		},

		recalculateLocalCaches(userId: number): number {
			const timeZone = timeZoneOf(userId);
			const rows = selectEntryCache.all(userId) as { id: number; tsUtc: number }[];
			let changed = 0;

			const run = db.transaction((): void => {
				for (const row of rows) {
					const tsLocal = utcToWallTime(row.tsUtc, timeZone);
					const date = resolveLocalDate(row.tsUtc, timeZone);
					if (cacheMatches(db, row.id, tsLocal, date)) {
						continue;
					}
					updateEntryCache.run(tsLocal, date, row.id);
					changed++;
				}
			});
			run();
			return changed;
		},
	};
}

/**
 * Checks whether the local cache fields of a punch already match.
 *
 * @param db - open database handle
 * @param entryId - punch id
 * @param tsLocal - expected wall clock time
 * @param localDate - expected local date
 * @returns true when both values are already stored
 */
function cacheMatches(db: Db, entryId: number, tsLocal: number, localDate: string): boolean {
	const row = db
		.prepare("SELECT ts_local AS tsLocal, local_date AS localDate FROM time_entries WHERE id = ?")
		.get(entryId) as { tsLocal: number; localDate: string } | undefined;
	return row !== undefined && row.tsLocal === tsLocal && row.localDate === localDate;
}
