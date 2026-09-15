/**
 * Generates the synthetic SMALL-Time fixture used by the legacy import tests.
 *
 * The real sample data of SMALL-Time contains no punch files and no absences, and there is no productive
 * `Data` directory for this project, so the import is developed and tested against a fixture that follows
 * the formats documented in `PROJECT_PROMPT.md` 2.9 and appendix 11:
 *
 *   node tools/make-legacy-fixture.mjs
 *
 * All values are derived from the scenario in this file (calendar + known punches), not from the adapter's
 * calculation — that is what makes the fixture usable as a golden reference: the monthly target hours are
 * "working days of the month × daily target", the balance is "worked minutes − target minutes".
 *
 * The files are written with **CRLF** line endings on purpose, because the legacy system wrote them that way
 * and the parsers have to cope with it. They are checked in, so the tests run without this script.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "fixtures", "smalltime");

/** Scenario: part time employee, 60 %, 25.5 h per week on five working days. */
const DAILY_TARGET_MIN = Math.round((25.5 * 60) / 5); // 306 min = 5.1 h
/** Punch pairs of the fixture: 08:00–12:30 and 13:30–14:30 local (Europe/Zurich in February is UTC+1). */
const PUNCH_PAIRS = [
	[8, 0, 12, 30],
	[13, 30, 14, 30],
];
/** Worked minutes per day according to the pairs above. */
const WORKED_PER_DAY_MIN = PUNCH_PAIRS.reduce(
	(sum, [fromH, fromM, toH, toM]) => sum + (toH * 60 + toM - (fromH * 60 + fromM)),
	0,
);
/** Days of the fixture month (February 2026) that have punches. */
const PUNCHED_DAYS = [2, 3, 4, 5];
const FIXTURE_YEAR = 2026;
const FIXTURE_MONTH = 2;

/**
 * Counts the working days (Monday to Friday) of a month.
 *
 * @param year - calendar year
 * @param month - month, 1 based
 * @returns number of weekdays
 */
function weekdays(year, month) {
	const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
	let count = 0;
	for (let day = 1; day <= days; day++) {
		const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
		if (weekday >= 1 && weekday <= 5) {
			count++;
		}
	}
	return count;
}

/**
 * Writes a file of the fixture (creating directories, CRLF line endings).
 *
 * @param relativePath - path below the fixture root
 * @param content - file content (LF is converted to CRLF)
 * @returns {void}
 */
function write(relativePath, content) {
	const path = join(root, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${content.replace(/\n/g, "\r\n")}`, "utf8");
	console.log(`wrote ${relativePath}`);
}

// --- Data/users.txt and group.txt -------------------------------------------------
write(
	"Data/users.txt",
	[
		"administrator;Administrator;7110eda4d09e062aa5e4a390b0a572ac0d2c0220;1234",
		"TeilZeit1;Teilzeit Muster;f0f4d6d5e0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5;",
	].join("\n"),
);
write("Data/group.txt", ["1;Administratoren;1", "2;Mitarbeiter;1"].join("\n"));

// --- per user data ----------------------------------------------------------------
write(
	"Data/administrator/userdaten.txt",
	[
		"Administrator",
		"1767222000",
		"100",
		"42.5",
		"0",
		"20",
		"0;0",
		"0;1;1;1;1;1;0",
		Array.from({ length: 24 }, () => "0").join(";"),
		...Array.from({ length: 7 }, () => "-1;-1;100"),
		"0",
	].join("\n"),
);
write("Data/administrator/personaldaten.txt", "");
write("Data/administrator/Timetable/total.txt", "-412.2\n20");

write(
	"Data/TeilZeit1/userdaten.txt",
	[
		"Teilzeit Muster",
		"1767222000",
		"60",
		"25.5",
		"0",
		"20",
		"12;3",
		"0;1;1;1;1;0;0",
		Array.from({ length: 24 }, () => "0").join(";"),
		...Array.from({ length: 7 }, () => "-1;-1;100"),
		"2",
		"12.2026",
	].join("\n"),
);
write(
	"Data/TeilZeit1/absenz.txt",
	[
		"Ferien;F;100",
		"Krankheit;K;100",
		"Unfall;U;100",
		"Militär;M;100",
		"Intern;I;100",
		"Weiterbildung;W;50",
		"Extern;E;50",
	].join("\n"),
);

// --- Timetable --------------------------------------------------------------------
const targetMinutes = weekdays(FIXTURE_YEAR, FIXTURE_MONTH) * DAILY_TARGET_MIN;
const workedMinutes = PUNCHED_DAYS.length * WORKED_PER_DAY_MIN;
const monthLines = [];
for (let month = 1; month <= 12; month++) {
	const target = weekdays(FIXTURE_YEAR, month) * DAILY_TARGET_MIN;
	const worked = month === FIXTURE_MONTH ? workedMinutes : 0;
	const hours = value => Number((value / 60).toFixed(2));
	monthLines.push(`${hours(worked - target)};0;${hours(target)};0`);
}
write(`Data/TeilZeit1/Timetable/${FIXTURE_YEAR}`, monthLines.join("\n"));

const punches = [];
for (const day of PUNCHED_DAYS) {
	for (const [fromH, fromM, toH, toM] of PUNCH_PAIRS) {
		// The stored value is a UTC instant (`time()` in PHP): local 08:00 in Europe/Zurich (UTC+1 in
		// February) is 07:00 UTC.
		punches.push(Math.floor(Date.UTC(FIXTURE_YEAR, FIXTURE_MONTH - 1, day, fromH - 1, fromM) / 1000));
		punches.push(Math.floor(Date.UTC(FIXTURE_YEAR, FIXTURE_MONTH - 1, day, toH - 1, toM) / 1000));
	}
}
punches.sort((a, b) => a - b);
write(`Data/TeilZeit1/Timetable/${FIXTURE_YEAR}.${FIXTURE_MONTH}`, punches.join("\n"));

write(
	`Data/TeilZeit1/Timetable/A${FIXTURE_YEAR}`,
	[
		// field 1 is ambiguous in the legacy code (day of the month or day of the year) — the importer warns
		"14;F;1",
		"16;K;0.5",
	].join("\n"),
);
write(`Data/TeilZeit1/Timetable/auszahlungen`, "1;2026;3");
write(`Data/TeilZeit1/Timetable/total.txt`, "-412.2\n20");

// --- include/Settings -------------------------------------------------------------
write("include/Settings/pausen.txt", ["0;6;0", "6;24;30"].join("\n"));
const settings = [];
for (let line = 1; line <= 30; line++) {
	settings.push(`Feld ${line}#0#Platzhalter`);
}
settings[12] = "Landeseinstellung#CH#Nationalfeiertag";
settings[20] = "MA duerfen Drucken bis Tag X#30#Tage";
settings[21] = "Pause ab Stunden#6#automatische Pause";
settings[22] = "Laenge der automatischen Pause#30#Minuten";
settings[23] = "Editierfenster rueckwaerts#7#Tage";
settings[25] = "Runden der Quicktime#15#Minuten";
settings[27] = "Absenzen nur bis heute berechnen#1#Schalter";
settings[28] = "Arbeitszeit von Absenz abziehen#1#Schalter";
write("include/Settings/settings.txt", settings.join("\n"));

write(
	"README.md",
	[
		"# Synthetic SMALL-Time fixture",
		"",
		"**Synthetic data — not a real installation.** It follows the formats documented in `PROJECT_PROMPT.md`",
		"(2.9 and appendix 11) so the legacy import can be developed and tested without a productive `Data`",
		"directory. Regenerate with `node tools/make-legacy-fixture.mjs`.",
		"",
		"| Item | Value |",
		"| --- | --- |",
		"| Admin | `administrator` (group 1), legacy password hash of `admin` |",
		`| Employee | \`TeilZeit1\` — 60 %, 25.5 h/week, workdays Monday to Friday, ends 12/${FIXTURE_YEAR} |`,
		`| Punches | ${PUNCHED_DAYS.length} days in ${FIXTURE_MONTH}/${FIXTURE_YEAR}, 08:00–12:30 and 13:30–14:30 local |`,
		`| Worked | ${(workedMinutes / 60).toFixed(2)} h in that month |`,
		`| Daily target | ${(DAILY_TARGET_MIN / 60).toFixed(2)} h (25.5 h / 5 days) |`,
		`| Monthly target | ${(targetMinutes / 60).toFixed(2)} h (${weekdays(FIXTURE_YEAR, FIXTURE_MONTH)} working days) |`,
		"| Absences | `A2026` with two rows, `absenz.txt` with seven types |",
		"| Payout | one row in `auszahlungen` (3 h) |",
		"",
		"The target hours in `Timetable/2026` come from the calendar (working days × daily target), the balance from",
		"the punch durations — computed independently of the adapter, so they can serve as a golden reference.",
		"",
	].join("\n"),
);

console.log(
	`\nTeam: ${PUNCHED_DAYS.length} punched days with ${WORKED_PER_DAY_MIN} min, daily target ${DAILY_TARGET_MIN} min, ` +
		`monthly target ${(targetMinutes / 60).toFixed(2)} h`,
);
