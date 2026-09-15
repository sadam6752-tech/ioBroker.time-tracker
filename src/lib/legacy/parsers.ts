/**
 * Readers for the file formats of SMALL-Time (v0.9.205).
 *
 * Every function takes the **text** of one legacy file and returns plain data — no database, no adapter, no
 * side effects. That keeps the formats testable and the mapping rules from `PROJECT_PROMPT.md` 2.9 in one
 * place. The parsers are deliberately tolerant: the legacy files may have CRLF endings, a missing final
 * newline, empty lines or fewer lines than expected, and none of that may throw.
 */

import { daysInMonth, wallTimeToUtc } from "../util/time";

/** A row of `Data/users.txt` (`path;name;sha1;rfid`). */
export interface LegacyUser {
	/** Technical login (the data folder name) */
	login: string;
	/** Display name from the file (the work profile may win) */
	displayName: string;
	/** Unsalted SHA-1 of the old password, lower case; empty when the login is new */
	legacySha1: string;
	/** Plain text badge code of the old system, `null` when empty */
	rfidCard: string | null;
}

/** A row of `Data/group.txt` (`id;name;active`). */
export interface LegacyGroup {
	/** Group number used by `users.txt`'s order */
	id: number;
	/** Name as written in the file */
	name: string;
	/** False when the group is switched off */
	active: boolean;
}

/** A shift rule of the work profile (`von;bis;prozent`, decimal hours). */
export interface LegacyShiftRule {
	/** 0 = Sunday … 6 = Saturday (same base as the work days) */
	dayOfWeek: number;
	/** From (decimal hours → minutes), `null` when the legacy value was `-1` */
	fromMinutes: number | null;
	/** To (decimal hours → minutes), `null` when the legacy value was `-1` */
	toMinutes: number | null;
	/** Surcharge in percent: `100` means "no surcharge" and becomes 0 */
	surchargePercent: number;
	/** False when the rule is switched off (`0` or `from = -1`) */
	active: boolean;
}

/** Everything `Data/<user>/userdaten.txt` carries. */
export interface LegacyWorkProfile {
	/** Name from line 0 (`null` when the line is empty) */
	displayName: string | null;
	/** Line 1: start of the time calculation, UTC epoch seconds */
	startDateUtc: number | null;
	/** Line 2: employment level in percent */
	percent: number | null;
	/** Line 3: weekly working hours */
	weeklyHours: number | null;
	/** Line 4: carry-over holiday time per year, minutes */
	vorholzeitPerYearMinutes: number | null;
	/** Line 5: vacation days per year */
	vacationPerYearDays: number | null;
	/** Line 6: overtime carry-over, minutes (may be negative) */
	overtimeCarryoverMinutes: number | null;
	/** Line 6: vacation carry-over, days */
	vacationCarryoverDays: number | null;
	/** Line 7: work days, index 0 = Sunday */
	workdays: boolean[] | null;
	/** Line 8: holiday switch list (variable length) */
	holidayFlags: number[] | null;
	/** Lines 9-15: one rule per weekday, index 0 = Sunday */
	shiftRules: LegacyShiftRule[];
	/** Line 16: `0` cumulative, `1` yearly, `2` monthly */
	overtimeModel: "cumulative" | "yearly" | "monthly" | null;
	/** Line 17: end of the time calculation, UTC epoch seconds */
	endDateUtc: number | null;
	/** Remarks for `import_runs.warnings` */
	warnings: string[];
}

/** A row of `Data/<user>/absenz.txt` (`name;code;factor`). */
export interface LegacyAbsenceType {
	/** Display name, e.g. `Ferien` */
	name: string;
	/** One letter code used by the Timetable files, e.g. `F` */
	code: string;
	/** Factor in percent (100 = full, 50 = half) */
	factor: number;
}

/** A row of `Timetable/A<year>` (`day;code;days`). */
export interface LegacyAbsence {
	/** Day number as written in the file — the meaning is ambiguous (see `parseAbsences`) */
	day: number;
	/** Absence type code from `absenz.txt` */
	code: string;
	/** Day portion, default 1 */
	days: number;
}

/** A row of `Timetable/auszahlungen` (`month;year;hours`). */
export interface LegacyPayout {
	/** Month, 1 based */
	month: number;
	/** Calendar year */
	year: number;
	/** Paid out hours (the legacy value is an amount of hours) */
	hours: number;
}

/** A row of `Timetable/<year>` (`balance;?;target;?`), in hours. */
export interface LegacyMonthTarget {
	/** Month, 1 based (the file has one row per month, in order) */
	month: number;
	/** Balance of that month in hours (golden value) */
	balanceHours: number;
	/** Target of that month in hours (golden value) */
	targetHours: number;
}

/** A row of `include/Settings/pausen.txt` (`from;to;minutes`, decimal hours). */
export interface LegacyPauseRule {
	/** Lower bound of the rule in minutes */
	fromMinutes: number;
	/** Upper bound in minutes, `null` means open end */
	toMinutes: number | null;
	/** Pause to subtract within that window in minutes */
	pauseMinutes: number;
}

/** The legacy settings that are carried over (all other lines are layout and are dropped). */
export interface LegacySettings {
	/** Line 13: country for the public holidays */
	holidayCountry: string | null;
	/** Line 21: how many days back employees may print */
	printLimitDays: number | null;
	/** Line 24: how many days back entries may be edited */
	editWindowDays: number | null;
	/** Line 26: rounding of the quick punch in minutes */
	quickRoundMinutes: number | null;
	/** Line 22: hours from which the automatic pause applies (decimal hours) */
	autoPauseFromHours: number | null;
	/** Line 23: length of the automatic pause in minutes */
	autoPauseDurationMinutes: number | null;
	/** Line 28: only calculate absences until today */
	absenceCalcUntilToday: boolean | null;
	/** Line 29: subtract working time for absences */
	absenceDeductWorktime: boolean | null;
	/** Remarks for `import_runs.warnings` */
	warnings: string[];
}

/**
 * Splits a legacy file into non-empty, trimmed lines.
 *
 * @param text - file content
 * @returns the lines
 */
export function lines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

/**
 * Splits a legacy file into **all** lines, empty ones included.
 *
 * Index based formats (`userdaten.txt`, `settings.txt`) address their fields by line number, so dropping
 * empty lines would shift every field. A trailing newline produces a final empty entry, which is harmless
 * because only the documented indices are read.
 *
 * @param text - file content
 * @returns the lines
 */
export function rawLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.trim());
}

/**
 * Reads a number, tolerating a comma as decimal separator and an empty field.
 *
 * @param value - raw field
 * @returns the number or `null`
 */
function number(value: string | undefined): number | null {
	const text = (value ?? "").trim().replace(",", ".");
	if (text === "") {
		return null;
	}
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads `Data/users.txt`.
 *
 * @param text - file content
 * @returns the users and warnings for the import report
 */
export function parseUsers(text: string): { users: LegacyUser[]; warnings: string[] } {
	const users: LegacyUser[] = [];
	const warnings: string[] = [];

	for (const line of lines(text)) {
		const [login, displayName, sha1, rfid] = line.split(";").map(field => field.trim());
		if (!login) {
			warnings.push(`users.txt: line without a login was skipped (${line.slice(0, 40)})`);
			continue;
		}
		if (users.some(user => user.login.toLowerCase() === login.toLowerCase())) {
			warnings.push(`users.txt: duplicate login "${login}" was skipped`);
			continue;
		}
		const hash = /^[0-9a-f]{40}$/.test(sha1 ?? "") ? (sha1 ?? "").toLowerCase() : "";
		if (hash === "") {
			warnings.push(`users.txt: "${login}" has no usable SHA-1 hash — the password has to be reset`);
		}
		users.push({
			login,
			displayName: displayName || login,
			legacySha1: hash,
			rfidCard: rfid ? rfid : null,
		});
	}

	return { users, warnings };
}

/**
 * Reads `Data/group.txt`.
 *
 * @param text - file content
 * @returns the groups
 */
export function parseGroups(text: string): LegacyGroup[] {
	const groups: LegacyGroup[] = [];
	for (const line of lines(text)) {
		const [id, name, active] = line.split(";").map(field => field.trim());
		const parsedId = number(id);
		if (parsedId === null || !name) {
			continue;
		}
		groups.push({ id: parsedId, name, active: active !== "0" });
	}
	return groups;
}

/** Mapping of the legacy overtime models (documented in 2.9.2). */
const OVERTIME_MODELS: Record<string, LegacyWorkProfile["overtimeModel"]> = {
	0: "cumulative",
	1: "yearly",
	2: "monthly",
};

/**
 * Reads `Data/<user>/userdaten.txt` (18 lines, 0 based, the last one may be missing).
 *
 * @param text - file content
 * @param timeZone - assumed time zone of the legacy server, used for the epoch values
 * @returns the work profile
 */
export function parseUserData(text: string, timeZone: string): LegacyWorkProfile {
	const fields = rawLines(text);
	const warnings: string[] = [];
	const profile: LegacyWorkProfile = {
		displayName: fields[0] || null,
		startDateUtc: null,
		percent: number(fields[2]),
		weeklyHours: number(fields[3]),
		vorholzeitPerYearMinutes: null,
		vacationPerYearDays: number(fields[5]),
		overtimeCarryoverMinutes: null,
		vacationCarryoverDays: null,
		workdays: null,
		holidayFlags: null,
		shiftRules: [],
		overtimeModel: null,
		endDateUtc: null,
		warnings,
	};

	// line 1: start of the time calculation. The value is a UTC instant (`mktime`), **not** a wall clock:
	// the example value 1767222000 in the specification is exactly 1.1.2026 00:00 Europe/Berlin. The assumed
	// time zone is therefore only used to derive local dates from it, never to shift it.
	const start = number(fields[1]);
	if (start === null) {
		warnings.push("userdaten.txt: no start date — the entry itself is used as the employment start");
	} else {
		profile.startDateUtc = start;
	}

	// line 4: carry-over holiday time per year (decimal hours)
	const vorholzeit = number(fields[4]);
	profile.vorholzeitPerYearMinutes = vorholzeit === null ? null : Math.round(vorholzeit * 60);

	// line 6: overtime carry-over and vacation carry-over (`hours;days`)
	const carryover = (fields[6] ?? "").split(";");
	const overtime = number(carryover[0]);
	profile.overtimeCarryoverMinutes = overtime === null ? null : Math.round(overtime * 60);
	profile.vacationCarryoverDays = number(carryover[1]);

	// line 7: work days, index 0 = Sunday — never re-index
	const workdays = (fields[7] ?? "").split(";");
	if (fields[7] !== undefined && workdays.length >= 7) {
		profile.workdays = workdays.slice(0, 7).map(value => value.trim() === "1");
	} else if (fields[7] !== undefined) {
		warnings.push(`userdaten.txt: work days malformed ("${fields[7]}") — kept empty`);
	}

	// line 8: holiday switch list (variable length, deliberately not a vacation scale)
	const flags = (fields[8] ?? "").split(";");
	if (fields[8] !== undefined && flags.some(value => number(value) !== null)) {
		profile.holidayFlags = flags.map(value => number(value) ?? 0);
	}

	// lines 9-15: one surcharge rule per weekday, index 9 = Sunday
	for (let index = 9; index <= 15; index++) {
		if (fields[index] === undefined) {
			warnings.push(`userdaten.txt: surcharge rule for weekday ${index - 9} is missing`);
			continue;
		}
		const [from, to, percent] = fields[index].split(";");
		const fromHours = number(from);
		const toHours = number(to);
		const rawPercent = number(percent) ?? 100;
		profile.shiftRules.push({
			dayOfWeek: index - 9,
			fromMinutes: fromHours === null || fromHours < 0 ? null : Math.round(fromHours * 60),
			toMinutes: toHours === null || toHours < 0 ? null : Math.round(toHours * 60),
			// 100 means "no surcharge"; values above 100 are the surcharge itself
			surchargePercent: rawPercent > 100 ? rawPercent - 100 : 0,
			active: rawPercent > 0 && fromHours !== null && fromHours >= 0,
		});
	}

	// line 16: overtime model
	const model = number(fields[16]);
	profile.overtimeModel = model === null ? null : (OVERTIME_MODELS[String(model)] ?? null);
	if (fields[16] !== undefined && profile.overtimeModel === null) {
		warnings.push(`userdaten.txt: unknown overtime model "${fields[16]}" — the default is used`);
	}

	// line 17: end of the time calculation, `MM.YEAR` → end of that month, 23:59:59 local
	const end = /^(\d{1,2})\.(\d{4})$/.exec((fields[17] ?? "").trim());
	if (end) {
		const month = Number(end[1]);
		const year = Number(end[2]);
		if (month >= 1 && month <= 12) {
			const wallSeconds = Date.UTC(year, month - 1, daysInMonth(year, month), 23, 59, 59) / 1000;
			const converted = wallTimeToUtc(wallSeconds, timeZone);
			profile.endDateUtc = converted.tsUtc;
			if (converted.ambiguous || converted.nonexistent) {
				warnings.push(`userdaten.txt: end date ${end[0]} falls into the DST change — verify the time`);
			}
		} else {
			warnings.push(`userdaten.txt: end date "${end[0]}" has no valid month — ignored`);
		}
	}

	return profile;
}

/**
 * Reads `Data/<user>/absenz.txt` (`name;code;factor`).
 *
 * @param text - file content
 * @returns the absence types
 */
export function parseAbsenceTypes(text: string): LegacyAbsenceType[] {
	const types: LegacyAbsenceType[] = [];
	for (const line of lines(text)) {
		const [name, code, factor] = line.split(";").map(field => field.trim());
		if (!name || !code) {
			continue;
		}
		types.push({ name, code, factor: number(factor) ?? 100 });
	}
	return types;
}

/**
 * Reads one `Timetable/<year>.<month>` file: one local wall-clock epoch per line.
 *
 * Repeated values are dropped — the import key is the epoch per user, so a repeated line would be skipped
 * later anyway and a duplicate would only produce an odd punch pair.
 *
 * @param text - file content
 * @returns sorted epoch seconds
 */
export function parseMonthPunches(text: string): number[] {
	const values = new Set<number>();
	for (const line of lines(text)) {
		const value = number(line);
		if (value !== null && value > 0) {
			values.add(Math.floor(value));
		}
	}
	return [...values].sort((a, b) => a - b);
}

/**
 * Reads `Timetable/<year>`: twelve rows `balance;?;target;?` in hours.
 *
 * The second and fourth fields are not documented in the old system, so only balance and target are used.
 *
 * @param text - file content
 * @returns one entry per month, in file order
 */
export function parseYearTargets(text: string): LegacyMonthTarget[] {
	const targets: LegacyMonthTarget[] = [];
	for (const line of lines(text)) {
		const fields = line.split(";");
		const month = targets.length + 1;
		if (month > 12) {
			break;
		}
		targets.push({
			month,
			balanceHours: number(fields[0]) ?? 0,
			targetHours: number(fields[2]) ?? 0,
		});
	}
	return targets;
}

/**
 * Reads `Timetable/A<year>` (`day;code;days`).
 *
 * The meaning of the first field is **not** documented in the old code (day of the month or day of the
 * year), so the parser returns it unchanged and always reports a warning; the importer turns it into a date
 * with the configured interpretation.
 *
 * @param text - file content
 * @returns absences and the warning about the ambiguous first field
 */
export function parseAbsences(text: string): { absences: LegacyAbsence[]; warnings: string[] } {
	const absences: LegacyAbsence[] = [];
	const warnings: string[] = [];
	for (const line of lines(text)) {
		const [day, code, days] = line.split(";").map(field => field.trim());
		const parsedDay = number(day);
		if (parsedDay === null || !code) {
			warnings.push(`A<year>: line without day or code was skipped (${line.slice(0, 30)})`);
			continue;
		}
		absences.push({ day: parsedDay, code, days: number(days) ?? 1 });
	}
	if (absences.length > 0) {
		warnings.push(
			"A<year>: field 1 is not documented in the old system (day of the month or day of the year) — " +
				"the import uses the configured interpretation, please verify one entry against the old system",
		);
	}
	return { absences, warnings };
}

/**
 * Reads `Timetable/auszahlungen` (`month;year;hours`).
 *
 * @param text - file content
 * @returns the payouts
 */
export function parsePayouts(text: string): LegacyPayout[] {
	const payouts: LegacyPayout[] = [];
	for (const line of lines(text)) {
		const [month, year, hours] = line.split(";").map(field => field.trim());
		const parsedMonth = number(month);
		const parsedYear = number(year);
		const parsedHours = number(hours);
		if (parsedMonth === null || parsedYear === null || parsedHours === null) {
			continue;
		}
		payouts.push({ month: parsedMonth, year: parsedYear, hours: parsedHours });
	}
	return payouts;
}

/**
 * Reads `Timetable/total.txt` (two lines, control values only).
 *
 * @param text - file content
 * @returns the total balance in hours and the undocumented second value
 */
export function parseTotals(text: string): { totalBalanceHours: number | null; secondValue: number | null } {
	const fields = lines(text);
	return { totalBalanceHours: number(fields[0]), secondValue: number(fields[1]) };
}

/**
 * Reads `include/Settings/pausen.txt` (`from;to;minutes`, decimal hours → minutes).
 *
 * A `to` of 24 hours or more means "open end" and becomes `null`, like the pause rules of the new schema.
 *
 * @param text - file content
 * @returns the pause rules
 */
export function parsePauseRules(text: string): LegacyPauseRule[] {
	const rules: LegacyPauseRule[] = [];
	for (const line of lines(text)) {
		const [from, to, minutes] = line.split(";").map(field => field.trim());
		const fromHours = number(from);
		const toHours = number(to);
		const pauseMinutes = number(minutes);
		if (fromHours === null || pauseMinutes === null) {
			continue;
		}
		rules.push({
			fromMinutes: Math.round(fromHours * 60),
			toMinutes: toHours === null || toHours >= 24 ? null : Math.round(toHours * 60),
			pauseMinutes: Math.round(pauseMinutes),
		});
	}
	return rules;
}

/**
 * Reads `include/Settings/settings.txt` (`name#value#description`, line number = index).
 *
 * Only the lines that are carried over are used, layout lines are dropped (documented in 2.9.9).
 *
 * @param text - file content
 * @returns the settings
 */
export function parseSettings(text: string): LegacySettings {
	const fields = rawLines(text);
	const value = (lineNumber: number): string | null => {
		const parts = (fields[lineNumber - 1] ?? "").split("#");
		return parts.length >= 2 && parts[1].trim() !== "" ? parts[1].trim() : null;
	};
	const flag = (lineNumber: number): boolean | null => {
		const raw = value(lineNumber);
		return raw === null ? null : raw !== "0";
	};
	const warnings: string[] = [];
	if (fields.length < 26) {
		warnings.push(`settings.txt: only ${fields.length} lines — missing lines count as "not set"`);
	}

	return {
		holidayCountry: value(13),
		printLimitDays: number(value(21) ?? undefined),
		editWindowDays: number(value(24) ?? undefined),
		quickRoundMinutes: number(value(26) ?? undefined),
		autoPauseFromHours: number(value(22) ?? undefined),
		autoPauseDurationMinutes: number(value(23) ?? undefined),
		absenceCalcUntilToday: flag(28),
		absenceDeductWorktime: flag(29),
		warnings,
	};
}
