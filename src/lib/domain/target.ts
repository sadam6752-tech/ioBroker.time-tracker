/**
 * Target working time (daily target).
 *
 * Legacy formula (verified against the old system):
 *   weekly target = weekly_hours * percent / 100
 *   daily target  = round(weekly target / number of active working days, 2)   (in hours)
 *
 * The value is stored in minutes; the two-decimal rounding of the legacy system is kept so migrated
 * balances match (rounding to whole minutes afterwards).
 */

/** Employment parameters relevant for the target time. */
export interface WorkProfile {
	/** Employment level in percent */
	percent: number;
	/** Contracted hours per week at 100 % */
	weeklyHours: number;
	/** Active working days, `0;1;…` for Sunday…Saturday */
	workdays: string;
	/** First day of the employment (UTC epoch seconds) */
	startDate?: number | null;
	/** Last day of the employment (UTC epoch seconds) */
	endDate?: number | null;
}

/** Impact of an absence on the target of one day. */
export interface AbsenceImpact {
	/** Percentage of the working time credited (100 = fully credited) */
	factor: number;
	/** Portion of the day (1 = whole day, 0.5 = half day) */
	dayPortion: number;
}

/**
 * Parses the `workdays` field into seven booleans, index 0 = Sunday.
 *
 * @param value - `0;1;…` with seven entries
 * @returns flags for Sunday to Saturday
 */
export function parseWorkdays(value: string): boolean[] {
	const parts = value.split(";");
	const days: boolean[] = [];
	for (let index = 0; index < 7; index++) {
		days.push(parts[index]?.trim() === "1");
	}
	return days;
}

/**
 * Counts the active working days.
 *
 * @param value - `workdays` field
 * @returns number of active days (0 to 7)
 */
export function activeWorkdayCount(value: string): number {
	return parseWorkdays(value).filter(Boolean).length;
}

/**
 * Checks whether a weekday is an active working day.
 *
 * @param value - `workdays` field
 * @param weekday - 0 = Sunday … 6 = Saturday
 * @returns true when the day is an active working day
 */
export function isWorkdayOn(value: string, weekday: number): boolean {
	return parseWorkdays(value)[weekday] === true;
}

/**
 * Weekly target in minutes.
 *
 * @param profile - employment parameters
 * @returns weekly target in minutes, rounded
 */
export function weeklyTargetMinutes(profile: WorkProfile): number {
	const weeklyHours = (profile.weeklyHours * profile.percent) / 100;
	return Math.round(weeklyHours * 60);
}

/**
 * Daily target in minutes for a full working day (independent of holidays and absences).
 *
 * @param profile - employment parameters
 * @returns daily target in minutes, 0 when no working day is configured
 */
export function dailyTargetMinutes(profile: WorkProfile): number {
	const activeDays = activeWorkdayCount(profile.workdays);
	if (activeDays === 0) {
		return 0;
	}

	const weeklyHours = (profile.weeklyHours * profile.percent) / 100;
	const dailyHours = Math.round((weeklyHours / activeDays) * 100) / 100;
	return Math.round(dailyHours * 60);
}

/**
 * Target minutes of a single day, considering holidays, absences and the employment window.
 *
 * @param args - target calculation input
 * @param args.profile - employment parameters
 * @param args.weekday - weekday of the day, 0 = Sunday
 * @param args.isHoliday - true when the day is a public holiday
 * @param args.absence - absence covering the day, if any
 * @param args.isBeforeStart - true when the day lies before the employment start
 * @param args.isAfterEnd - true when the day lies after the employment end
 * @returns target minutes for that day
 */
export function targetForDay(args: {
	profile: WorkProfile;
	weekday: number;
	isHoliday?: boolean;
	absence?: AbsenceImpact | null;
	isBeforeStart?: boolean;
	isAfterEnd?: boolean;
}): number {
	if (args.isBeforeStart || args.isAfterEnd) {
		return 0;
	}
	if (!isWorkdayOn(args.profile.workdays, args.weekday)) {
		return 0;
	}
	if (args.isHoliday) {
		return 0;
	}

	const base = dailyTargetMinutes(args.profile);
	if (!args.absence) {
		return base;
	}

	const credited = (Math.max(0, Math.min(100, args.absence.factor)) / 100) * clampPortion(args.absence.dayPortion);
	return Math.round(base * (1 - credited));
}

/**
 * Clamps a day portion into (0, 1].
 *
 * @param portion - raw portion
 * @returns clamped portion
 */
function clampPortion(portion: number): number {
	if (!Number.isFinite(portion) || portion <= 0) {
		return 0;
	}
	return Math.min(1, portion);
}
