/**
 * Time zone helpers.
 *
 * All timestamps in the database are UTC epoch seconds; local dates and times are derived with these
 * helpers (never with manual offsets), so daylight saving transitions are handled correctly.
 */

import { DateTime } from "luxon";

const UTC = "utc";

/**
 * Checks whether a string is a valid IANA time zone name.
 *
 * @param timeZone - IANA time zone name to validate
 */
export function isValidTimeZone(timeZone: string): boolean {
	return DateTime.local().setZone(timeZone).isValid;
}

/**
 * Converts an instant to the local calendar date (`YYYY-MM-DD`) of a time zone.
 *
 * @param tsUtc - UTC epoch seconds
 * @param timeZone - IANA time zone
 * @returns local date string
 */
export function localDate(tsUtc: number, timeZone: string): string {
	return localDateTime(tsUtc, timeZone).date;
}

/**
 * Converts an instant to the wall clock time of a time zone.
 *
 * @param tsUtc - UTC epoch seconds
 * @param timeZone - IANA time zone
 * @returns local date and minutes since local midnight
 */
export function localDateTime(tsUtc: number, timeZone: string): { date: string; minutes: number } {
	const local = DateTime.fromSeconds(tsUtc, { zone: UTC }).setZone(timeZone);
	return {
		date: local.toISODate() ?? "",
		minutes: local.hour * 60 + local.minute,
	};
}

/**
 * Weekday of a local calendar date, 0 = Sunday … 6 = Saturday (same base as `workdays`).
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param timeZone - IANA time zone used to resolve the date
 * @returns weekday number
 */
export function dayOfWeek(date: string, timeZone: string): number {
	return DateTime.fromISO(date, { zone: timeZone }).weekday % 7;
}

/**
 * Adds whole days to a calendar date (calendar arithmetic, no time zone involved).
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param days - days to add, may be negative
 * @returns resulting local date
 */
export function addDays(date: string, days: number): string {
	return DateTime.fromISO(date, { zone: UTC }).plus({ days }).toISODate() ?? date;
}

/**
 * Returns the inclusive range of local dates between two dates.
 *
 * @param from - first local date, `YYYY-MM-DD`
 * @param to - last local date, `YYYY-MM-DD`
 * @returns array of local dates (empty when `to` is before `from`)
 */
export function dateRange(from: string, to: string): string[] {
	const dates: string[] = [];
	let current = from;
	while (current <= to) {
		dates.push(current);
		current = addDays(current, 1);
	}
	return dates;
}

/**
 * Checks whether a string is a local calendar date in `YYYY-MM-DD` form.
 *
 * @param value - value to check
 * @returns true when the value is a valid date without time
 */
export function isDateString(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	return DateTime.fromISO(value, { zone: UTC }).isValid;
}

/**
 * UTC epoch seconds of local midnight of a given date.
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param timeZone - IANA time zone
 * @returns UTC epoch seconds
 */
export function startOfLocalDayUtc(date: string, timeZone: string): number {
	return Math.floor(DateTime.fromISO(date, { zone: timeZone }).toSeconds());
}

/**
 * Number of days in a month.
 *
 * @param year - four digit year
 * @param month - month, 1 to 12
 * @returns day count of that month
 */
export function daysInMonth(year: number, month: number): number {
	return DateTime.fromObject({ year, month }, { zone: UTC }).daysInMonth ?? 30;
}

/** Result of converting a legacy local wall-clock timestamp. */
export interface WallTimeConversion {
	/** UTC epoch seconds */
	tsUtc: number;
	/** True when the wall time exists twice (switch back to standard time) */
	ambiguous: boolean;
	/** True when the wall time does not exist (switch to daylight saving time) */
	nonexistent: boolean;
}

/**
 * Converts a legacy local wall-clock timestamp (seconds since epoch *interpreted as local time*,
 * the format used by the old system) to UTC epoch seconds.
 *
 * During daylight saving transitions wall times can be ambiguous or non-existent; the caller has to
 * report those cases as warnings instead of guessing (see the import specification).
 *
 * @param localSeconds - seconds since epoch in the local frame
 * @param timeZone - IANA time zone of the legacy system
 * @returns UTC instant plus ambiguity flags
 */
export function wallTimeToUtc(localSeconds: number, timeZone: string): WallTimeConversion {
	const wall = DateTime.fromSeconds(localSeconds, { zone: UTC });
	const fields = {
		year: wall.year,
		month: wall.month,
		day: wall.day,
		hour: wall.hour,
		minute: wall.minute,
		second: wall.second,
	};
	const wallSeconds = Math.floor(
		Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) / 1000,
	);

	const offsetAt = (tsUtc: number): number => DateTime.fromSeconds(tsUtc, { zone: UTC }).setZone(timeZone).offset;
	const wallTimeOf = (tsUtc: number): number => {
		const local = DateTime.fromSeconds(tsUtc, { zone: UTC }).setZone(timeZone);
		return Math.floor(
			Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) / 1000,
		);
	};

	// Candidate instants are built from the offsets one day before and one day after the wall time:
	// during a switch back both produce a valid instant (ambiguous), during a switch forward none does
	// (non-existent).
	const offsetBefore = offsetAt(wallSeconds - 86400);
	const offsetAfter = offsetAt(wallSeconds + 86400);
	const candidates = Array.from(new Set([wallSeconds - offsetBefore * 60, wallSeconds - offsetAfter * 60]))
		.filter(tsUtc => wallTimeOf(tsUtc) === wallSeconds)
		.sort((a, b) => a - b);

	if (candidates.length === 0) {
		// Non-existent wall time: shift it forward by the gap, which equals the instant computed with
		// the offset from before the transition.
		return { tsUtc: wallSeconds - offsetBefore * 60, ambiguous: false, nonexistent: true };
	}
	return { tsUtc: candidates[0], ambiguous: candidates.length > 1, nonexistent: false };
}

/**
 * Converts an instant into the legacy local wall-clock timestamp (inverse of `wallTimeToUtc`).
 *
 * @param tsUtc - UTC epoch seconds
 * @param timeZone - IANA time zone of the legacy system
 * @returns seconds since epoch in the local frame
 */
export function utcToWallTime(tsUtc: number, timeZone: string): number {
	const local = DateTime.fromSeconds(tsUtc, { zone: UTC }).setZone(timeZone);
	return Math.floor(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) / 1000);
}
