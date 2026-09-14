/// <reference types="mocha" />
import { expect } from "chai";
import { DateTime } from "luxon";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository, type AbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository, type HolidaysRepository } from "../db/repositories/holidays";
import { createRulesRepository, type RulesRepository } from "../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService, type AggregationService } from "./aggregation";

const zurich = "Europe/Zurich";

describe("aggregation service", () => {
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let absences: AbsencesRepository;
	let holidays: HolidaysRepository;
	let rules: RulesRepository;
	let settings: SettingsRepository;
	let service: AggregationService;
	let annaId: number;

	/**
	 * Inserts a punch at a local wall clock time.
	 *
	 * @param userId - owner of the punch
	 * @param iso - local date and time, `YYYY-MM-DDTHH:mm`
	 * @param timeZone - time zone of the punch
	 * @returns id of the created punch
	 */
	function punch(userId: number, iso: string, timeZone: string = zurich): number {
		return entries.insert({
			userId,
			tsUtc: Math.floor(DateTime.fromISO(iso, { zone: timeZone }).toSeconds()),
			timeZone,
		}).entry.id;
	}

	/**
	 * Inserts a pair of punches for a day.
	 *
	 * @param date - local date
	 * @param from - start time, `HH:mm`
	 * @param to - end time, `HH:mm`
	 * @param userId - owner of the punches
	 */
	function punchPair(date: string, from: string, to: string, userId: number = annaId): void {
		punch(userId, `${date}T${from}`);
		punch(userId, `${date}T${to}`);
	}

	/**
	 * Sums the stored monthly balances of a year.
	 *
	 * @param userId - owner
	 * @param year - four digit year
	 * @returns sum of the monthly balances in minutes
	 */
	function storedYearBalance(userId: number, year: number): number {
		const row = db
			.prepare(
				"SELECT COALESCE(SUM(balance_min), 0) AS total FROM month_aggregates WHERE user_id = ? AND year = ?",
			)
			.get(userId, year) as { total: number };
		return row.total;
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2025, 2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		absences = createAbsencesRepository(db);
		holidays = createHolidaysRepository(db);
		rules = createRulesRepository(db);
		settings = createSettingsRepository(db);
		service = createAggregationService({ db, users, entries, absences, holidays, rules, settings });

		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		users.saveWorkProfile({
			userId: annaId,
			profile: { percent: 100, weeklyHours: 40, workdays: "0;1;1;1;1;1;0" },
			actorId: annaId,
		});
	});

	afterEach(() => {
		db.close();
	});

	describe("day", () => {
		it("stores worked time, target time and balance", () => {
			punchPair("2026-01-07", "08:00", "17:00");

			const day = service.recalculateDay(annaId, "2026-01-07", { now: 1000 });

			expect(day).to.deep.include({
				userId: annaId,
				localDate: "2026-01-07",
				workedMin: 540,
				breakMin: 0,
				targetMin: 480,
				balanceMin: 60,
				absenceCode: null,
				isHoliday: false,
				hasOpenEntry: false,
				updatedAt: 1000,
			});
			expect(day.firstInUtc).to.be.a("number");
			expect(day.lastOutUtc).to.be.a("number");
			expect(service.day(annaId, "2026-01-07")).to.deep.equal(day);
		});

		it("updates the existing row instead of adding a second one", () => {
			punchPair("2026-01-07", "08:00", "17:00");
			service.recalculateDay(annaId, "2026-01-07", { now: 1000 });

			punch(annaId, "2026-01-07T18:00");
			punch(annaId, "2026-01-07T19:00");
			const updated = service.recalculateDay(annaId, "2026-01-07", { now: 2000 });

			expect(updated.workedMin).to.equal(600);
			expect(updated.updatedAt).to.equal(2000);
			const count = db.prepare("SELECT COUNT(*) AS count FROM day_aggregates").get() as { count: number };
			expect(count.count).to.equal(1);
		});

		it("deducts the breaks of the company rules", () => {
			rules.savePauseRule({ fromMin: 360, pauseMin: 30, actorId: annaId });
			punchPair("2026-01-07", "08:00", "17:30");

			const day = service.recalculateDay(annaId, "2026-01-07");

			expect(day.workedMin).to.equal(540);
			expect(day.breakMin).to.equal(30);
			expect(day.balanceMin).to.equal(60);
		});

		it("marks holidays and cancels the target", () => {
			punchPair("2026-01-01", "08:00", "12:00");

			const day = service.recalculateDay(annaId, "2026-01-01");

			expect(day.isHoliday).to.equal(true);
			expect(day.targetMin).to.equal(0);
			expect(day.balanceMin).to.equal(240);
		});

		it("credits absences and stores the code of the strongest one", () => {
			absences.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-01-07",
				dayPortion: 0.5,
				status: "taken",
				actorId: annaId,
			});
			punchPair("2026-01-07", "08:00", "12:00");

			const halfDay = service.recalculateDay(annaId, "2026-01-07");
			expect(halfDay.absenceCode).to.equal("F");
			expect(halfDay.targetMin).to.equal(240);
			expect(halfDay.balanceMin).to.equal(0);

			// a full day absence credits more than the half day and wins
			absences.create({
				userId: annaId,
				typeCode: "K",
				dateFrom: "2026-01-07",
				status: "taken",
				actorId: annaId,
			});
			expect(service.recalculateDay(annaId, "2026-01-07").absenceCode).to.equal("K");
		});

		it("counts only completed pairs while a punch is open", () => {
			punch(annaId, "2026-01-07T08:00");
			punch(annaId, "2026-01-07T12:00");
			punch(annaId, "2026-01-07T13:00");

			const day = service.recalculateDay(annaId, "2026-01-07");

			expect(day.hasOpenEntry).to.equal(true);
			expect(day.lastOutUtc).to.equal(null);
			expect(day.workedMin).to.equal(240);
			expect(day.balanceMin).to.equal(-240);
		});

		it("has no target without a stored profile", () => {
			db.prepare("DELETE FROM work_profiles WHERE user_id = ?").run(annaId);
			punchPair("2026-01-07", "08:00", "12:00");

			const day = service.recalculateDay(annaId, "2026-01-07");

			expect(day.targetMin).to.equal(0);
			expect(day.balanceMin).to.equal(240);
		});
	});

	describe("range and month", () => {
		it("sums a week", () => {
			for (const date of ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]) {
				punchPair(date, "08:00", "16:00");
			}

			const totals = service.recalculateRange(annaId, "2026-01-05", "2026-01-09");

			expect(totals).to.deep.equal({
				days: 5,
				openDays: 0,
				workedMin: 2400,
				targetMin: 2400,
				balanceMin: 0,
			});
			expect(service.days(annaId, "2026-01-05", "2026-01-09")).to.have.lengthOf(5);
		});

		it("writes the month aggregate with vacation usage and overtime", () => {
			punchPair("2026-01-02", "08:00", "17:00");
			absences.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-01-05",
				dateTo: "2026-01-06",
				status: "taken",
				actorId: annaId,
			});

			const month = service.recalculateMonth(annaId, 2026, 1, { upToDate: "2026-01-02", now: 1000 });

			// 2026-01-01 is a holiday (target 0), 2026-01-02 is a regular Friday
			expect(month.workedMin).to.equal(540);
			expect(month.targetMin).to.equal(480);
			expect(month.balanceMin).to.equal(60);
			// vacation is counted for the whole month, independent of the cutoff date
			expect(month.vacationUsed).to.equal(2);
			expect(month.overtimeMin).to.equal(60);
			expect(month.updatedAt).to.equal(1000);
			expect(service.month(annaId, 2026, 1)).to.deep.equal(month);
		});

		it("does not aggregate days after the cutoff date", () => {
			service.recalculateMonth(annaId, 2026, 1, { upToDate: "2026-01-02" });

			expect(service.days(annaId, "2026-01-03", "2026-01-31")).to.deep.equal([]);
			expect(service.days(annaId, "2026-01-01", "2026-01-02")).to.have.lengthOf(2);

			service.recalculateMonth(annaId, 2026, 1, { upToDate: "2026-01-02", includeFuture: true });
			expect(service.days(annaId, "2026-01-03", "2026-01-31")).to.have.lengthOf(29);
		});

		it("rejects an invalid month", () => {
			expect(() => service.recalculateMonth(annaId, 2026, 13)).to.throw("month must be between 1 and 12");
			expect(() => service.recalculateMonth(annaId, 2026, 0)).to.throw("month must be between 1 and 12");
		});
	});

	describe("overtime", () => {
		it("carries the balance from month to month", () => {
			punchPair("2026-01-02", "08:00", "17:00"); // +60
			punchPair("2026-02-02", "08:00", "16:30"); // +30

			const january = service.recalculateMonth(annaId, 2026, 1, { upToDate: "2026-01-31" });
			const february = service.recalculateMonth(annaId, 2026, 2, { upToDate: "2026-02-02" });

			// January is aggregated completely: 21 workdays (New Year is a holiday) at 480 minutes
			expect(january.targetMin).to.equal(21 * 480);
			expect(january.balanceMin).to.equal(540 - 21 * 480);
			expect(january.overtimeMin).to.equal(january.balanceMin);
			// February is aggregated up to the 2nd: 510 worked, 480 target
			expect(february.balanceMin).to.equal(30);
			// the balance is carried month by month
			expect(february.overtimeMin).to.equal(january.overtimeMin + february.balanceMin);
		});

		it("keeps the carryover with the yearly model until the year is finished", () => {
			users.saveWorkProfile({
				userId: annaId,
				profile: { overtimeModel: "yearly", overtimeCarryover: 100, vorholzeitPerYear: 120 },
				actorId: annaId,
			});
			punchPair("2026-01-02", "08:00", "17:00");

			const january = service.recalculateMonth(annaId, 2026, 1, { upToDate: "2026-01-31" });
			expect(january.balanceMin).to.equal(540 - 21 * 480);
			// not December yet: the carryover stays untouched
			expect(january.overtimeMin).to.equal(100);

			// 2025 is finished, so the full Vorholzeit of 120 minutes is credited
			const finished = service.recalculateYear(annaId, 2025, { upToDate: "2026-01-02" });
			expect(finished.settled).to.equal(true);
			expect(finished.overtimeStart).to.equal(100);
			expect(finished.overtimeMin).to.equal(100 + storedYearBalance(annaId, 2025) - 120);
		});

		it("subtracts payouts", () => {
			punchPair("2026-01-02", "08:00", "17:00");
			db.prepare("INSERT INTO payouts (user_id, year, minutes, created_at) VALUES (?, 2026, 200, 1)").run(annaId);

			const january = service.recalculateMonth(annaId, 2026, 1, { upToDate: "2026-01-31" });

			// the payout reduces the carried overtime
			expect(january.overtimeMin).to.equal(january.balanceMin - 200);
		});
	});

	describe("year", () => {
		it("computes the vacation balance", () => {
			users.saveWorkProfile({
				userId: annaId,
				profile: { vacationCarryover: 5, vacationPerYear: 25 },
				actorId: annaId,
			});
			absences.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-07-06",
				dateTo: "2026-07-10",
				status: "taken",
				actorId: annaId,
			});
			absences.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-08-03",
				dateTo: "2026-08-04",
				status: "planned",
				actorId: annaId,
			});
			// sickness does not reduce the vacation balance
			absences.create({
				userId: annaId,
				typeCode: "K",
				dateFrom: "2026-09-07",
				dateTo: "2026-09-08",
				status: "taken",
				actorId: annaId,
			});

			const year = service.recalculateYear(annaId, 2026, { upToDate: "2026-12-31" });

			expect(year.vacationDays).to.equal(30);
			expect(year.vacationUsed).to.equal(5);
			expect(year.vacationLeft).to.equal(25);
			expect(year.vacationPlannedDays).to.equal(2);
			expect(year.workedMin).to.equal(0);
			expect(year.settled).to.equal(false);
			expect(service.year(annaId, 2026)).to.deep.equal(year);
		});

		it("uses the previous year as carryover", () => {
			punchPair("2025-01-02", "08:00", "17:00"); // +60 in 2025
			const previous = service.recalculateYear(annaId, 2025, { upToDate: "2026-01-02" });
			expect(previous.overtimeMin).to.equal(storedYearBalance(annaId, 2025));
			expect(previous.overtimeMin).to.not.equal(0);

			// 2026-01-01 is a holiday, so the new year starts with the carryover
			const current = service.recalculateYear(annaId, 2026, { upToDate: "2026-01-01" });
			expect(current.overtimeStart).to.equal(previous.overtimeMin);
			expect(current.overtimeMin).to.equal(current.overtimeStart);
		});
	});

	describe("time zone cache", () => {
		it("recomputes the local dates after a time zone change", () => {
			punchPair("2026-01-07", "00:30", "04:30");
			expect(service.recalculateDay(annaId, "2026-01-07").workedMin).to.equal(240);

			users.update({ id: annaId, patch: { timezone: "America/New_York" }, actorId: annaId });
			const changed = service.recalculateLocalCaches(annaId);

			expect(changed).to.equal(2);
			expect(entries.listByDate(annaId, "2026-01-06")).to.have.lengthOf(2);
			expect(entries.listByDate(annaId, "2026-01-07")).to.deep.equal([]);

			// the aggregates follow the new local date
			expect(service.recalculateDay(annaId, "2026-01-06").workedMin).to.equal(240);
			expect(service.recalculateDay(annaId, "2026-01-07").workedMin).to.equal(0);
		});

		it("reports no change when the cache is already correct", () => {
			punchPair("2026-01-07", "08:00", "12:00");
			expect(service.recalculateLocalCaches(annaId)).to.equal(0);
		});
	});
});
