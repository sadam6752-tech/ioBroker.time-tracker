/**
 * Public holidays for the supported countries.
 *
 * Date strings use the format `YYYY-MM-DD` (local calendar date), matching `holidays.date`
 * and `absences.date_from` in the database.
 *
 * Movable feasts are derived from Easter Sunday (Meeus/Jones/Butcher algorithm); fixed dates are
 * defined per country. Country-specific deviations (cantonal holidays in Switzerland, for example)
 * are configured later per user via `work_profiles.holiday_flags`.
 */

export type HolidayCountry = "CH" | "DE" | "AT";

/**
 * A public holiday with its local calendar date.
 */
export interface Holiday {
	/** Local date, `YYYY-MM-DD` */
	date: string;
	/** Display name (translated in the UI) */
	name: string;
}

/**
 * A calendar date without time and without time zone.
 */
export interface CalendarDate {
	/** Four digit year */
	year: number;
	/** Month, 1 to 12 */
	month: number;
	/** Day of month, 1 to 31 */
	day: number;
}

/**
 * Calculates Easter Sunday for a Gregorian year.
 *
 * @param year - four digit year
 * @returns date of Easter Sunday
 */
export function easterSunday(year: number): CalendarDate {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return { year, month, day };
}

/**
 * Formats a calendar date as `YYYY-MM-DD`.
 *
 * @param date - calendar date to format
 * @returns date string in `YYYY-MM-DD`
 */
export function formatDate(date: CalendarDate): string {
	const month = String(date.month).padStart(2, "0");
	const day = String(date.day).padStart(2, "0");
	return `${date.year}-${month}-${day}`;
}

/**
 * Adds a number of days to a calendar date (UTC based, so no daylight saving surprises).
 *
 * @param date - starting date
 * @param days - number of days to add (may be negative)
 * @returns resulting date
 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
	const base = new Date(Date.UTC(date.year, date.month - 1, date.day));
	base.setUTCDate(base.getUTCDate() + days);
	return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

/**
 * Returns all public holidays of a year for the given country, sorted by date.
 *
 * @param year - four digit year
 * @param country - supported country code
 */
export function holidaysForYear(year: number, country: HolidayCountry): Holiday[] {
	const easter = easterSunday(year);
	const movable = (offset: number, name: string): Holiday => ({
		date: formatDate(addDays(easter, offset)),
		name,
	});

	const fixed: Holiday[] = [{ date: `${year}-01-01`, name: "New Year" }];
	const easterBased: Holiday[] = [];

	switch (country) {
		case "CH":
			easterBased.push(movable(-2, "Good Friday"), movable(39, "Ascension Day"));
			fixed.push(
				{ date: `${year}-08-01`, name: "National Day" },
				{ date: `${year}-12-25`, name: "Christmas Day" },
			);
			break;
		case "DE":
			easterBased.push(
				movable(-2, "Good Friday"),
				movable(1, "Easter Monday"),
				movable(39, "Ascension Day"),
				movable(50, "Whit Monday"),
			);
			fixed.push(
				{ date: `${year}-05-01`, name: "Labour Day" },
				{ date: `${year}-10-03`, name: "German Unity Day" },
				{ date: `${year}-12-25`, name: "Christmas Day" },
				{ date: `${year}-12-26`, name: "Boxing Day" },
			);
			break;
		case "AT":
			easterBased.push(
				movable(1, "Easter Monday"),
				movable(39, "Ascension Day"),
				movable(50, "Whit Monday"),
				movable(60, "Corpus Christi"),
			);
			fixed.push(
				{ date: `${year}-01-06`, name: "Epiphany" },
				{ date: `${year}-05-01`, name: "Labour Day" },
				{ date: `${year}-08-15`, name: "Assumption Day" },
				{ date: `${year}-10-26`, name: "National Day" },
				{ date: `${year}-11-01`, name: "All Saints' Day" },
				{ date: `${year}-12-08`, name: "Immaculate Conception" },
				{ date: `${year}-12-25`, name: "Christmas Day" },
				{ date: `${year}-12-26`, name: "Boxing Day" },
			);
			break;
	}

	return [...fixed, ...easterBased].sort((a, b) => a.date.localeCompare(b.date));
}
