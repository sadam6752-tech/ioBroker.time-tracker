/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAndMigrate, type Db } from "../db/database";
import { createAbsencesRepository, type AbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createPayoutsRepository, type PayoutsRepository } from "../db/repositories/payouts";
import { createRulesRepository, type RulesRepository } from "../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService } from "../services/aggregation";
import { seed } from "../db/seed";
import { runLegacyImport, type LegacyImportDeps, type LegacyImportReport } from "./import";
import { detectLegacyLayout } from "./scan";

/** The synthetic fixture of `fixtures/smalltime` (see `tools/make-legacy-fixture.mjs`). */
const fixture = path.resolve(__dirname, "..", "..", "..", "fixtures", "smalltime");

describe("legacy import", () => {
	let db: Db;
	let deps: LegacyImportDeps;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let absences: AbsencesRepository;
	let rules: RulesRepository;
	let settings: SettingsRepository;
	let payouts: PayoutsRepository;
	let actorId: number;

	/**
	 * Counts the rows of a table.
	 *
	 * @param table - table name
	 * @returns number of rows
	 */
	function count(table: string): number {
		return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
	}

	/**
	 * Runs one import against the fixture.
	 *
	 * @param mode - `dry-run` or `commit`
	 * @param baseDir - folder to import, defaults to the fixture
	 * @returns the report
	 */
	function run(mode: "dry-run" | "commit", baseDir: string = fixture): LegacyImportReport {
		return runLegacyImport(deps, { baseDir, mode, actorId, now: 1770000000 });
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		absences = createAbsencesRepository(db);
		rules = createRulesRepository(db);
		settings = createSettingsRepository(db);
		payouts = createPayoutsRepository(db);
		deps = {
			db,
			users,
			entries,
			absences,
			rules,
			settings,
			payouts,
			aggregation: createAggregationService({
				db,
				users,
				entries,
				absences,
				holidays: createHolidaysRepository(db),
				rules,
				settings,
			}),
		};
		// the run is attributed to an administrator, `import_runs.actor_id` references `users`
		actorId = users.create({ login: "import-admin", displayName: "Import Admin", roleKeys: ["admin"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	it("finds both user folders and the settings of the installation", () => {
		const layout = detectLegacyLayout(fixture);

		expect(layout.users.map(user => user.login)).to.deep.equal(["administrator", "TeilZeit1"]);
		expect(layout.users[1].punchFiles.map(file => `${file.year}.${file.month}`)).to.deep.equal(["2026.2"]);
		expect(layout.users[1].goldenFiles.map(file => file.year)).to.deep.equal([2026]);
		expect(layout.users[1].absenceFiles.map(file => file.year)).to.deep.equal([2026]);
		expect(layout.users[0].totalsFile).to.be.a("string");
		expect(layout.settingsFile).to.be.a("string");
		expect(layout.pauseFile).to.be.a("string");
	});

	it("counts a dry-run completely and writes nothing but the report", () => {
		const report = run("dry-run");

		expect(report.mode).to.equal("dry-run");
		// the fixture is internally consistent, so the legacy monthly values are reproduced; the warnings
		// come from the ambiguous day field of `A<year>` and from the absence types that match the built-ins
		expect(report.status).to.equal("warnings");
		expect(report.deviations).to.deep.equal([]);
		expect(report.timezoneAssumed).to.equal("Europe/Zurich");
		expect(report.stats).to.include({
			userFolders: 2,
			usersCreated: 2,
			usersExisting: 0,
			entries: 16,
			entriesSkipped: 0,
			absences: 2,
			payouts: 1,
			settings: 6,
			// the legacy file marks "no deduction" as a rule as well — such a row is not carried over
			pauseRules: 1,
			rfidTags: 1,
			absenceTypes: 0,
			goldenMonths: 12,
			goldenDeviations: 0,
		});
		// control values of `total.txt` are only reported (2.9.7)
		expect(report.stats.totalBalanceHours).to.equal(-412.2);
		expect(report.stats.totalSecondValue).to.equal(20);

		// nothing was written …
		expect(count("time_entries")).to.equal(0);
		expect(count("absences")).to.equal(0);
		expect(count("payouts")).to.equal(0);
		expect(count("rfid_tags")).to.equal(0);
		expect(count("pause_rules")).to.equal(0);
		expect(count("users")).to.equal(1);

		// … but the report row survived the rollback
		expect(count("import_runs")).to.equal(1);
		const stored = db.prepare("SELECT mode, status, timezone_assumed, stats, warnings FROM import_runs").get() as {
			mode: string;
			status: string;
			timezone_assumed: string;
			stats: string;
			warnings: string;
		};
		expect(stored.mode).to.equal("dry-run");
		expect(stored.status).to.equal("warnings");
		expect(stored.timezone_assumed).to.equal("Europe/Zurich");
		expect(JSON.parse(stored.stats)).to.include({ entries: 16 });
		expect(JSON.parse(stored.warnings)).to.be.an("array").that.has.length.greaterThan(0);
	});

	it("imports the data and reproduces the legacy monthly values", () => {
		const report = run("commit");

		expect(report.status).to.equal("warnings");
		expect(report.deviations).to.deep.equal([]);

		expect(count("time_entries")).to.equal(16);
		expect(count("absences")).to.equal(2);
		expect(count("payouts")).to.equal(1);
		expect(count("rfid_tags")).to.equal(1);
		expect(count("pause_rules")).to.equal(1);
		// every legacy surcharge row is switched off, so no shift rule is imported
		expect(count("shift_rules")).to.equal(0);
		// the absence types of the fixture are the built-in ones, so nothing is duplicated (2.9.3)
		expect(count("absence_types")).to.equal(7);

		const employee = users.findByLogin("TeilZeit1");
		expect(employee).to.not.equal(null);
		const employeeId = employee!.id;
		expect(employee!.legacySha1).to.equal("f0f4d6d5e0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5");
		expect(employee!.passwordHash).to.equal("");
		expect(employee!.mustChangePw).to.equal(true);
		// the row number of `users.txt` maps to the group of `group.txt` (2.9.1)
		expect(users.roles(employeeId)).to.deep.equal(["employee"]);
		expect(users.roles(users.findByLogin("administrator")!.id)).to.deep.equal(["admin"]);

		// 60 % employment level and 42.5 h at 100 % → 5.1 h per working day
		const profile = users.getWorkProfile(employeeId);
		expect(profile).to.not.equal(null);
		expect(profile!.percent).to.equal(60);
		expect(profile!.weeklyHours).to.equal(42.5);
		expect(profile!.workdays).to.equal("0;1;1;1;1;1;0");
		expect(profile!.vacationPerYear).to.equal(20);
		expect(profile!.overtimeCarryover).to.equal(720);
		expect(profile!.vacationCarryover).to.equal(3);
		expect(profile!.overtimeModel).to.equal("monthly");
		expect(profile!.legacySource).to.contain("userdaten.txt");

		// the punches of 2.2.2026 (08:00–12:30, 13:30–14:30 local, UTC+1 in February) are stored as UTC instants
		const monday = entries.listByDate(employeeId, "2026-02-02");
		expect(monday).to.have.length(4);
		expect(monday[0].tsUtc).to.equal(Date.UTC(2026, 1, 2, 7, 0, 0) / 1000);
		expect(monday[0].source).to.equal("import");
		expect(monday[0].idempotencyKey).to.equal(`import:${employeeId}:${monday[0].tsUtc}`);

		const tag = db.prepare("SELECT legacy_code, is_active FROM rfid_tags").get() as {
			legacy_code: string;
			is_active: number;
		};
		expect(tag).to.deep.equal({ legacy_code: "1234", is_active: 0 });

		// February: 20 working days × 5.1 h target, 22 h worked
		const month = deps.aggregation.month(employeeId, 2026, 2);
		expect(month?.targetMin).to.equal(6120);
		expect(month?.workedMin).to.equal(1320);
		expect(month?.balanceMin).to.equal(-4800);
	});

	it("adds no rows when it runs a second time", () => {
		run("commit");
		const tables = ["time_entries", "absences", "payouts", "rfid_tags", "users", "pause_rules"];
		const before = tables.map(table => count(table));

		const second = runLegacyImport(deps, { baseDir: fixture, mode: "commit", actorId, resetImport: true });

		expect(second.stats.entries).to.equal(0);
		expect(second.stats.entriesSkipped).to.equal(16);
		expect(second.stats.usersCreated).to.equal(0);
		expect(second.stats.usersExisting).to.equal(2);
		expect(second.stats.absences).to.equal(0);
		expect(second.stats.absencesSkipped).to.equal(2);
		expect(second.stats.payouts).to.equal(0);
		expect(tables.map(table => count(table))).to.deep.equal(before);
	});

	it("ends with mismatch when a monthly value of the legacy file deviates", () => {
		const copy = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legacy-"));
		try {
			fs.cpSync(fixture, copy, { recursive: true });
			const golden = path.join(copy, "Data", "TeilZeit1", "Timetable", "2026");
			const lines = fs.readFileSync(golden, "utf8").split(/\r?\n/);
			// February: the legacy file claims 79 h instead of 80 h of negative balance
			lines[1] = "-79;0;102;0";
			fs.writeFileSync(golden, lines.join("\n"), "utf8");

			const report = run("commit", copy);

			expect(report.status).to.equal("mismatch");
			expect(report.stats.goldenDeviations).to.equal(1);
			expect(report.deviations[0]).to.include({
				login: "TeilZeit1",
				year: 2026,
				month: 2,
				expectedBalanceMin: -4740,
				actualBalanceMin: -4800,
			});
		} finally {
			fs.rmSync(copy, { recursive: true, force: true });
		}
	});

	it("refuses a commit into a database that already holds time data", () => {
		run("commit");

		expect(() => run("commit")).to.throw(/already holds/);

		const stored = db.prepare("SELECT status FROM import_runs ORDER BY id DESC LIMIT 1").get() as {
			status: string;
		};
		expect(stored.status).to.equal("failed");
	});
});
