/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { holidaysForYear } from "../../domain/holidays";
import { createHolidaysRepository, type HolidaysRepository } from "./holidays";

describe("holidays repository", () => {
	let db: Db;
	let repo: HolidaysRepository;

	/**
	 * Counts the audit rows of one action.
	 *
	 * @param action - action key
	 * @returns number of rows
	 */
	function countAudit(action: string): number {
		return (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?").get(action) as { count: number })
			.count;
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
		repo = createHolidaysRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("ensureYear", () => {
		it("generates the holidays of a year once", () => {
			const expected = holidaysForYear(2026, "CH").length;
			const first = repo.ensureYear({ year: 2026, country: "CH", now: 1000 });

			expect(first).to.deep.equal({ year: 2026, inserted: expected });
			expect(repo.listByYear(2026, "CH")).to.have.lengthOf(expected);
			expect(repo.years()).to.deep.equal([2026]);
			expect(countAudit("holiday.ensure")).to.equal(1);
			expect(lastDetail("holiday.ensure")).to.deep.equal({ year: 2026, country: "CH", inserted: expected });
		});

		it("is idempotent and keeps edited holidays", () => {
			repo.ensureYear({ year: 2026, country: "CH" });
			const newYear = repo.listByYear(2026, "CH").find(holiday => holiday.date === "2026-01-01");
			if (!newYear) {
				throw new Error("New Year was not generated");
			}
			repo.add({ date: "2026-01-01", name: "Neujahr", region: "CH", actorId: 1 });

			const second = repo.ensureYear({ year: 2026, country: "CH" });

			expect(second.inserted).to.equal(0);
			// the renamed day is not overwritten
			expect(repo.listByYear(2026, "CH").find(holiday => holiday.date === "2026-01-01")?.name).to.equal(
				"Neujahr",
			);
			// only the first run is audited
			expect(countAudit("holiday.ensure")).to.equal(1);
			expect(db.prepare("SELECT COUNT(*) AS count FROM holidays WHERE date = '2026-01-01'").get()).to.deep.equal({
				count: 1,
			});
		});

		it("stores different countries in different regions", () => {
			repo.ensureYear({ year: 2026, country: "CH" });
			const de = repo.ensureYear({ year: 2026, country: "DE" });

			expect(de.inserted).to.equal(holidaysForYear(2026, "DE").length);
			expect(repo.listByYear(2026, "DE")).to.have.lengthOf(holidaysForYear(2026, "DE").length);
			// German Unity Day is a German holiday only
			expect(repo.isHoliday("2026-10-03", "DE")).to.equal(true);
			expect(repo.isHoliday("2026-10-03", "CH")).to.equal(false);
			expect(repo.isHoliday("2026-08-01", "CH")).to.equal(true);
			expect(repo.isHoliday("2026-08-01", "DE")).to.equal(false);
		});
	});

	describe("lookups", () => {
		beforeEach(() => {
			repo.ensureYear({ year: 2026, country: "CH" });
		});

		it("sorts by date and reports the known years", () => {
			const holidays = repo.listByYear(2026, "CH");

			expect(holidays.map(holiday => holiday.date)).to.deep.equal(
				holidaysForYear(2026, "CH").map(holiday => holiday.date),
			);
			expect(repo.listByYear(2027)).to.deep.equal([]);
		});

		it("answers single date lookups", () => {
			expect(repo.isHoliday("2026-01-01", "CH")).to.equal(true);
			expect(repo.isHoliday("2026-01-02", "CH")).to.equal(false);
			expect(repo.dateSet(2026, "CH").has("2026-12-25")).to.equal(true);
			expect(repo.dateSet(2026, "CH").size).to.equal(holidaysForYear(2026, "CH").length);
			expect(repo.dateSet(2027).size).to.equal(0);
		});
	});

	describe("add and remove", () => {
		it("adds a holiday and derives its year from the date", () => {
			const holiday = repo.add({ date: "2027-01-02", name: "Betriebsferien", actorId: 7, now: 2000 });

			expect(holiday.date).to.equal("2027-01-02");
			expect(holiday.year).to.equal(2027);
			expect(holiday.region).to.equal("DE");
			expect(repo.years()).to.deep.equal([2027]);
			expect(repo.isHoliday("2027-01-02")).to.equal(true);
			expect(countAudit("holiday.create")).to.equal(1);
			expect(lastDetail("holiday.create")).to.deep.equal({
				date: "2027-01-02",
				name: "Betriebsferien",
				region: "DE",
			});
		});

		it("renames an existing day of the region", () => {
			repo.ensureYear({ year: 2026, country: "CH" });
			const renamed = repo.add({ date: "2026-08-01", name: "Bundesfeier", region: "CH", actorId: 7, now: 3000 });

			expect(renamed.name).to.equal("Bundesfeier");
			expect(countAudit("holiday.update")).to.equal(1);
			expect(lastDetail("holiday.update")).to.deep.equal({
				changes: { name: { old: "National Day", new: "Bundesfeier" } },
			});
			// the generated day keeps its name
			expect(repo.listByYear(2026, "CH").find(holiday => holiday.date === "2026-08-01")?.name).to.equal(
				"Bundesfeier",
			);
			expect(repo.listByYear(2026, "CH")).to.have.lengthOf(holidaysForYear(2026, "CH").length);
		});

		it("accepts another region", () => {
			repo.add({ date: "2026-05-01", name: "Tag der Arbeit", region: "DE", actorId: 7 });

			expect(repo.isHoliday("2026-05-01", "DE")).to.equal(true);
			expect(repo.isHoliday("2026-05-01", "CH")).to.equal(false);
		});

		it("validates the date and the name", () => {
			expect(() => repo.add({ date: "01.01.2027", name: "Neujahr", actorId: 7 })).to.throw(
				'invalid date "01.01.2027"',
			);
			expect(() => repo.add({ date: "2027-02-30", name: "Neujahr", actorId: 7 })).to.throw("invalid date");
			expect(() => repo.add({ date: "2027-01-01", name: "   ", actorId: 7 })).to.throw("name must not be empty");
			expect(repo.years()).to.deep.equal([]);
			expect(countAudit("holiday.create")).to.equal(0);
		});

		it("deletes a holiday and audits it", () => {
			repo.ensureYear({ year: 2026, country: "CH" });
			const target = repo.listByYear(2026, "CH").find(holiday => holiday.date === "2026-12-25");
			if (!target) {
				throw new Error("Christmas was not generated");
			}

			expect(repo.remove({ id: target.id, actorId: 7, actorIp: "10.0.0.9", now: 4000 })).to.equal(true);
			expect(repo.isHoliday("2026-12-25", "CH")).to.equal(false);
			expect(countAudit("holiday.delete")).to.equal(1);
			expect(lastDetail("holiday.delete")).to.deep.equal({ region: "CH", name: "Christmas Day" });
			expect(repo.remove({ id: target.id, actorId: 7 })).to.equal(false);
		});
	});
});
