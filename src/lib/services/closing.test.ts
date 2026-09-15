/// <reference types="mocha" />
import { expect } from "chai";
import { DateTime } from "luxon";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createPayoutsRepository, type PayoutsRepository } from "../db/repositories/payouts";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService } from "./aggregation";
import { createClosingService, type ClosingService } from "./closing";

const berlin = "Europe/Berlin";

describe("closing service", () => {
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let payouts: PayoutsRepository;
	let service: ClosingService;
	let annaId: number;
	let adminId: number;

	/**
	 * Inserts a pair of punches for a day.
	 *
	 * @param date - local date
	 * @param from - start time, `HH:mm`
	 * @param to - end time, `HH:mm`
	 */
	function punchPair(date: string, from: string, to: string): void {
		for (const time of [from, to]) {
			entries.insert({
				userId: annaId,
				tsUtc: Math.floor(DateTime.fromISO(`${date}T${time}`, { zone: berlin }).toSeconds()),
				timeZone: berlin,
			});
		}
	}

	/**
	 * Reads the newest audit row of one action.
	 *
	 * @param action - action key
	 * @returns detail object of the row
	 */
	function lastDetail(action: string): Record<string, unknown> {
		const row = db.prepare("SELECT detail FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1").get(action) as
			{ detail: string } | undefined;
		if (!row) {
			throw new Error(`no audit row for ${action}`);
		}
		return JSON.parse(row.detail) as Record<string, unknown>;
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2025, 2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		payouts = createPayoutsRepository(db);
		const aggregation = createAggregationService({
			db,
			users,
			entries,
			absences: createAbsencesRepository(db),
			holidays: createHolidaysRepository(db),
			rules: createRulesRepository(db),
			settings: createSettingsRepository(db),
		});
		service = createClosingService({ db, aggregation, payouts });

		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		users.saveWorkProfile({
			userId: annaId,
			profile: { percent: 100, weeklyHours: 40, workdays: "0;1;1;1;1;1;0" },
			actorId: adminId,
		});
	});

	afterEach(() => {
		db.close();
	});

	describe("closeMonth", () => {
		it("recalculates the month and the year and audits the closing", () => {
			punchPair("2026-01-02", "08:00", "17:00");

			const result = service.closeMonth({
				userId: annaId,
				year: 2026,
				month: 1,
				actorId: adminId,
				actorIp: "10.0.0.3",
				upToDate: "2026-01-31",
				now: 1000,
			});

			expect(result.closedAt).to.equal(1000);
			expect(result.payout).to.equal(null);
			// 21 workdays in January (New Year is a holiday), one of them worked
			expect(result.month.targetMin).to.equal(21 * 480);
			expect(result.month.balanceMin).to.equal(540 - 21 * 480);
			expect(result.year.year).to.equal(2026);
			expect(result.year.workedMin).to.equal(540);
			const detail = lastDetail("month.close");
			expect(detail).to.deep.include({
				year: 2026,
				month: 1,
				workedMin: 540,
				balanceMin: 540 - 21 * 480,
				payoutMinutes: 0,
			});
			const days = db.prepare("SELECT COUNT(*) AS count FROM day_aggregates").get() as { count: number };
			expect(days.count).to.equal(31);
		});

		it("records the payout of the closing before the recalculation", () => {
			punchPair("2026-01-02", "08:00", "17:00");

			const result = service.closeMonth({
				userId: annaId,
				year: 2026,
				month: 1,
				payoutMinutes: 200,
				payoutAmount: 100,
				actorId: adminId,
				upToDate: "2026-01-31",
				now: 2000,
			});

			expect(result.payout).to.deep.include({
				userId: annaId,
				year: 2026,
				month: 1,
				minutes: 200,
				amount: 100,
				note: "Monatsabschluss 2026-01",
				createdBy: adminId,
			});
			// the payout is already included in the overtime of the closing
			expect(result.month.overtimeMin).to.equal(result.month.balanceMin - 200);
			expect(lastDetail("month.close").payoutMinutes).to.equal(200);
			expect(payouts.sumMinutes(annaId, 2026, 1)).to.equal(200);
		});

		it("keeps a single month row when closing twice", () => {
			service.closeMonth({ userId: annaId, year: 2026, month: 1, actorId: adminId, upToDate: "2026-01-31" });
			service.closeMonth({ userId: annaId, year: 2026, month: 1, actorId: adminId, upToDate: "2026-01-31" });

			const rows = db
				.prepare(
					"SELECT COUNT(*) AS count FROM month_aggregates WHERE user_id = ? AND year = 2026 AND month = 1",
				)
				.get(annaId) as { count: number };
			expect(rows.count).to.equal(1);
			// without a payout nothing is paid out twice
			expect(payouts.list(annaId)).to.deep.equal([]);
			const audits = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'month.close'").get() as {
				count: number;
			};
			expect(audits.count).to.equal(2);
		});

		it("rejects an invalid month", () => {
			expect(() => service.closeMonth({ userId: annaId, year: 2026, month: 13, actorId: adminId })).to.throw(
				"month must be between 1 and 12",
			);
		});
	});

	describe("settleYear", () => {
		it("marks the year as settled and audits it", () => {
			const result = service.settleYear({
				userId: annaId,
				year: 2025,
				actorId: adminId,
				upToDate: "2026-01-02",
				now: 3000,
			});

			expect(result.year.settled).to.equal(true);
			expect(result.closedAt).to.equal(3000);
			expect(lastDetail("year.settle")).to.deep.include({ year: 2025, settled: true });
		});

		it("finishes the yearly overtime model", () => {
			users.saveWorkProfile({
				userId: annaId,
				profile: { overtimeModel: "yearly", overtimeCarryover: 100, vorholzeitPerYear: 120 },
				actorId: adminId,
			});
			punchPair("2026-01-02", "08:00", "17:00");

			// not settled: the carryover stays untouched
			const openMonth = service.closeMonth({
				userId: annaId,
				year: 2026,
				month: 1,
				actorId: adminId,
				upToDate: "2026-01-31",
			});
			expect(openMonth.month.overtimeMin).to.equal(100);

			// settled: the balance of the year and the full Vorholzeit are applied
			const settled = service.settleYear({
				userId: annaId,
				year: 2025,
				actorId: adminId,
				upToDate: "2026-01-02",
			});
			const sum = db
				.prepare(
					"SELECT COALESCE(SUM(balance_min), 0) AS total FROM month_aggregates WHERE user_id = ? AND year = 2025",
				)
				.get(annaId) as { total: number };
			expect(settled.year.overtimeStart).to.equal(100);
			expect(settled.year.overtimeMin).to.equal(100 + sum.total - 120);
		});
	});
});
