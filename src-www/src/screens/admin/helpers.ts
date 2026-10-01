/**
 * Administration: weekdayOptions, toggleWeekday, formatSize, formatStamp (split out of `Admin.tsx`).
 */

/**
 * Short weekday names of the display language.
 *
 * The names come from `Intl`, so a translation of “Mo”, “Tue”, … is not needed and every language gets its own
 * spelling. The 1st of January 2024 was a Monday, so the year starts exactly with the day the mask starts with.
 *
 * @param language - language of the display
 * @returns the seven days, ISO numbered 1..7
 */
export function weekdayOptions(language: string): { value: number; label: string }[] {
	const format = new Intl.DateTimeFormat(language, { weekday: "short" });
	return [1, 2, 3, 4, 5, 6, 7].map(value => ({
		value,
		label: format.format(new Date(Date.UTC(2024, 0, value))),
	}));
}

/**
 * Turns one weekday of a rule on or off.
 *
 * @param weekdays - current selection
 * @param day - ISO weekday to change
 * @param checked - new state
 * @returns the new selection, sorted
 */
export function toggleWeekday(weekdays: number[], day: number, checked: boolean): number[] {
	const next = checked ? [...weekdays, day] : weekdays.filter(value => value !== day);
	return [...new Set(next)].sort((left, right) => left - right);
}

/**
 * Formats a byte count for the backup list.
 *
 * @param bytes - size in bytes
 * @param language - language of the display
 * @returns formatted size, e.g. `201 kB`
 */
export function formatSize(bytes: number, language: string): string {
	return new Intl.NumberFormat(language, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }).format(
		Math.max(1, Math.round(bytes / 1024)),
	);
}

/**
 * Formats an instant of a backup.
 *
 * @param tsUtc - UTC epoch seconds
 * @param language - language of the display
 * @returns formatted date and time
 */
export function formatStamp(tsUtc: number, language: string): string {
	return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(tsUtc * 1000));
}

/**
 * Employees: list, create, activate/deactivate, badge PIN.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the users tab
 */
