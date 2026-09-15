/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	lines,
	parseAbsenceTypes,
	parseAbsences,
	parseGroups,
	parseMonthPunches,
	parsePauseRules,
	parsePayouts,
	parseSettings,
	parseTotals,
	parseUserData,
	parseUsers,
	parseYearTargets,
	rawLines,
} from "./parsers";

/** The synthetic fixture of `fixtures/smalltime` (see `tools/make-legacy-fixture.mjs`). */
const fixture = path.resolve(__dirname, "..", "..", "..", "fixtures", "smalltime");

/**
 * Reads a file of the fixture as text.
 *
 * @param relativePath - path below the fixture root
 * @returns the file content
 */
function read(relativePath: string): string {
	return fs.readFileSync(path.join(fixture, relativePath), "utf8");
}

describe("legacy file parsers", () => {
	it("splits lines with and without dropping empty ones", () => {
		expect(lines("a\r\n\r\n b \n")).to.deep.equal(["a", "b"]);
		expect(rawLines("a\r\n\r\nb")).to.deep.equal(["a", "", "b"]);
	});

	it("reads users and reports a missing password hash", () => {
		const { users, warnings } = parseUsers(read("Data/users.txt"));
		expect(users).to.deep.equal([
			{
				login: "administrator",
				displayName: "Administrator",
				legacySha1: "7110eda4d09e062aa5e4a390b0a572ac0d2c0220",
				rfidCard: "1234",
			},
			{
				login: "TeilZeit1",
				displayName: "Teilzeit Muster",
				legacySha1: "f0f4d6d5e0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
				rfidCard: null,
			},
		]);
		expect(warnings).to.deep.equal([]);

		const broken = parseUsers("neu;Neuer Nutzer;;\nkaputt;Ohne Login\nneu;Doppelt;x;");
		// two rows are usable, the duplicate login is skipped and two hashes are unusable
		expect(broken.users).to.have.length(2);
		expect(broken.warnings).to.have.length(3);
	});

	it("reads the groups", () => {
		expect(parseGroups(read("Data/group.txt"))).to.deep.equal([
			{ id: 1, name: "Administratoren", active: true },
			{ id: 2, name: "Mitarbeiter", active: true },
		]);
	});

	it("reads the work profile of the fixture", () => {
		const profile = parseUserData(read("Data/TeilZeit1/userdaten.txt"), "Europe/Zurich");

		expect(profile.displayName).to.equal("Teilzeit Muster");
		// 1767222000 is 1.1.2026 00:00 local as a UTC instant (mktime) — it is stored unchanged
		expect(profile.startDateUtc).to.equal(1767222000);
		expect(profile.percent).to.equal(60);
		expect(profile.weeklyHours).to.equal(25.5);
		expect(profile.vorholzeitPerYearMinutes).to.equal(0);
		expect(profile.vacationPerYearDays).to.equal(20);
		expect(profile.overtimeCarryoverMinutes).to.equal(720);
		expect(profile.vacationCarryoverDays).to.equal(3);
		// index 0 = Sunday — the order must not be changed
		expect(profile.workdays).to.deep.equal([false, true, true, true, true, false, false]);
		expect(profile.holidayFlags).to.have.length(24);
		expect(profile.shiftRules).to.have.length(7);
		expect(profile.shiftRules[0]).to.deep.equal({
			dayOfWeek: 0,
			fromMinutes: null,
			toMinutes: null,
			surchargePercent: 0,
			active: false,
		});
		expect(profile.overtimeModel).to.equal("monthly");
		// 31.12.2026 23:59:59 local (UTC+1 in December)
		expect(profile.endDateUtc).to.equal(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000 - 3600);
		expect(profile.warnings).to.deep.equal([]);
	});

	it("converts decimal hours and surcharges of the work profile", () => {
		const profile = parseUserData(
			[
				"Kurz",
				"1767222000",
				"80",
				"40",
				"2.5",
				"25",
				"-7.5;1.5",
				"0;1;1;1;1;1;0",
				"1;0;1",
				"20;22;125",
				"-1;-1;100",
				"-1;-1;100",
				"-1;-1;100",
				"-1;-1;100",
				"-1;-1;100",
				"-1;-1;100",
				"1",
			].join("\n"),
			"Europe/Zurich",
		);

		expect(profile.vorholzeitPerYearMinutes).to.equal(150);
		expect(profile.overtimeCarryoverMinutes).to.equal(-450);
		expect(profile.vacationCarryoverDays).to.equal(1.5);
		expect(profile.holidayFlags).to.deep.equal([1, 0, 1]);
		expect(profile.shiftRules[0]).to.deep.equal({
			dayOfWeek: 0,
			fromMinutes: 1200,
			toMinutes: 1320,
			surchargePercent: 25,
			active: true,
		});
		expect(profile.overtimeModel).to.equal("yearly");
		// the end date line is missing in this file
		expect(profile.endDateUtc).to.equal(null);
	});

	it("reads the absence types of the fixture", () => {
		const types = parseAbsenceTypes(read("Data/TeilZeit1/absenz.txt"));
		expect(types).to.have.length(7);
		expect(types[0]).to.deep.equal({ name: "Ferien", code: "F", factor: 100 });
		expect(types[5]).to.deep.equal({ name: "Weiterbildung", code: "W", factor: 50 });
	});

	it("reads and sorts the punches of one month", () => {
		const punches = parseMonthPunches(read("Data/TeilZeit1/Timetable/2026.2"));
		expect(punches).to.have.length(16);
		// 08:00 local (Europe/Zurich, UTC+1 in February) is 07:00 UTC and is stored as such
		expect(punches[0]).to.equal(Date.UTC(2026, 1, 2, 7, 0, 0) / 1000);
		expect([...punches].sort((a, b) => a - b)).to.deep.equal(punches);

		// duplicates and empty lines are dropped, unsorted input is sorted
		expect(parseMonthPunches("300\n100\n\n100\n200\n")).to.deep.equal([100, 200, 300]);
	});

	it("reads the monthly target hours of the fixture (golden values)", () => {
		const targets = parseYearTargets(read("Data/TeilZeit1/Timetable/2026"));
		expect(targets).to.have.length(12);
		// February is the month with punches: 22 h worked against 102 h target
		expect(targets[1]).to.deep.equal({ month: 2, balanceHours: -80, targetHours: 102 });
		expect(targets[0].targetHours).to.equal(112.2);
	});

	it("reads absences and warns about the ambiguous day field", () => {
		const { absences, warnings } = parseAbsences(read("Data/TeilZeit1/Timetable/A2026"));
		expect(absences).to.deep.equal([
			{ day: 14, code: "F", days: 1 },
			{ day: 16, code: "K", days: 0.5 },
		]);
		expect(warnings).to.have.length(1);
		expect(warnings[0]).to.contain("not documented");

		const broken = parseAbsences("x;F;1\n7;F;1");
		expect(broken.absences).to.have.length(1);
		expect(broken.warnings).to.have.length(2);
	});

	it("reads payouts and the control file", () => {
		expect(parsePayouts(read("Data/TeilZeit1/Timetable/auszahlungen"))).to.deep.equal([
			{ month: 1, year: 2026, hours: 3 },
		]);
		expect(parseTotals(read("Data/TeilZeit1/Timetable/total.txt"))).to.deep.equal({
			totalBalanceHours: -412.2,
			secondValue: 20,
		});
	});

	it("reads the pause rules and turns an open end into null", () => {
		expect(parsePauseRules(read("include/Settings/pausen.txt"))).to.deep.equal([
			{ fromMinutes: 0, toMinutes: 360, pauseMinutes: 0 },
			{ fromMinutes: 360, toMinutes: null, pauseMinutes: 30 },
		]);
	});

	it("reads only the settings that are carried over", () => {
		const settings = parseSettings(read("include/Settings/settings.txt"));
		expect(settings).to.deep.equal({
			holidayCountry: "CH",
			printLimitDays: 30,
			editWindowDays: 7,
			quickRoundMinutes: 15,
			absenceCalcUntilToday: true,
			absenceDeductWorktime: true,
			warnings: [],
		});

		const short = parseSettings(
			`${Array.from({ length: 12 }, (_value, index) => `Feld ${index + 1}#0#Platzhalter`).join("\n")}\nFeld 13#DE#Land`,
		);
		expect(short.holidayCountry).to.equal("DE");
		// line 24 is missing in that file, so nothing is carried over for it
		expect(short.editWindowDays).to.equal(null);
		expect(short.warnings).to.have.length(1);
	});
});
