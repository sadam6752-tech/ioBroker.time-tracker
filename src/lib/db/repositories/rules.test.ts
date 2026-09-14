/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository } from "./users";
import { createRulesRepository, type RulesRepository } from "./rules";

describe("rules repository", () => {
	let db: Db;
	let repo: RulesRepository;
	let annaId: number;
	let adminId: number;

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
		seed(db, { holidayYears: [2026] });
		const users = createUsersRepository(db);
		repo = createRulesRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	describe("pause rules", () => {
		it("stores company defaults and returns them sorted", () => {
			repo.savePauseRule({ fromMin: 360, toMin: 540, pauseMin: 30, actorId: adminId, now: 1000 });
			repo.savePauseRule({ fromMin: 540, pauseMin: 60, actorId: adminId });

			const rules = repo.pauseRules();
			expect(rules.map(rule => rule.fromMin)).to.deep.equal([360, 540]);
			expect(rules[0]).to.deep.include({ userId: null, toMin: 540, pauseMin: 30, isActive: true });
			// the rule without an upper bound is open ended
			expect(rules[1].toMin).to.equal(null);
			expect(countAudit("pause_rule.create")).to.equal(2);
			expect(lastDetail("pause_rule.create")).to.deep.equal({
				userId: null,
				fromMin: 540,
				toMin: null,
				pauseMin: 60,
			});
		});

		it("lets a user specific rule replace the company default with the same start", () => {
			repo.savePauseRule({ fromMin: 360, pauseMin: 30, actorId: adminId });
			repo.savePauseRule({ fromMin: 540, pauseMin: 60, actorId: adminId });
			repo.savePauseRule({ fromMin: 360, pauseMin: 15, userId: annaId, actorId: adminId });

			expect(repo.pauseRules().map(rule => rule.pauseMin)).to.deep.equal([30, 60]);
			expect(repo.pauseRules(annaId).map(rule => rule.pauseMin)).to.deep.equal([15, 60]);
			expect(repo.pauseRules(annaId)[0].userId).to.equal(annaId);
			expect(repo.pauseRules(annaId)[1].userId).to.equal(null);
		});

		it("hides disabled rules unless they are requested", () => {
			repo.savePauseRule({ fromMin: 300, pauseMin: 20, isActive: false, actorId: adminId });

			expect(repo.pauseRules()).to.deep.equal([]);
			expect(repo.pauseRules(null, { includeInactive: true })).to.have.lengthOf(1);
			// the unmerged list view of one scope filters inactive rules as well
			expect(repo.listPauseRules()).to.deep.equal([]);
			expect(repo.listPauseRules({ includeInactive: true }).map(rule => rule.isActive)).to.deep.equal([false]);
		});

		it("updates a rule, audits the changes and skips unchanged writes", () => {
			const rule = repo.savePauseRule({ fromMin: 360, pauseMin: 30, actorId: adminId, now: 1000 });

			const updated = repo.savePauseRule({
				id: rule.id,
				fromMin: 360,
				pauseMin: 45,
				isActive: false,
				actorId: adminId,
				now: 2000,
			});

			expect(updated.pauseMin).to.equal(45);
			expect(updated.isActive).to.equal(false);
			expect(countAudit("pause_rule.update")).to.equal(1);
			expect(lastDetail("pause_rule.update").changes).to.deep.equal({
				pauseMin: { old: 30, new: 45 },
				isActive: { old: true, new: false },
			});

			const unchanged = repo.savePauseRule({
				id: rule.id,
				fromMin: 360,
				pauseMin: 45,
				isActive: false,
				actorId: adminId,
			});
			expect(unchanged.pauseMin).to.equal(45);
			expect(countAudit("pause_rule.update")).to.equal(1);
		});

		it("validates the rule and rejects unknown ids", () => {
			expect(() => repo.savePauseRule({ fromMin: 360, pauseMin: 0, actorId: adminId })).to.throw("pauseMin");
			expect(() => repo.savePauseRule({ fromMin: -1, pauseMin: 30, actorId: adminId })).to.throw("fromMin");
			expect(() => repo.savePauseRule({ fromMin: 360, toMin: 360, pauseMin: 30, actorId: adminId })).to.throw(
				"toMin must be greater than fromMin",
			);
			expect(() => repo.savePauseRule({ id: 999, fromMin: 360, pauseMin: 30, actorId: adminId })).to.throw(
				"pause rule 999 not found",
			);
			expect(countAudit("pause_rule.create")).to.equal(0);
		});

		it("deletes a rule and audits it", () => {
			const rule = repo.savePauseRule({ fromMin: 360, pauseMin: 30, actorId: adminId });

			expect(repo.removePauseRule({ id: rule.id, actorId: adminId, now: 3000 })).to.equal(true);
			expect(repo.pauseRules(null, { includeInactive: true })).to.deep.equal([]);
			expect(lastDetail("pause_rule.delete")).to.deep.equal({ userId: null, fromMin: 360, pauseMin: 30 });
			expect(repo.removePauseRule({ id: rule.id, actorId: adminId })).to.equal(false);
		});
	});

	describe("shift rules", () => {
		it("stores a surcharge rule for every day", () => {
			const rule = repo.saveShiftRule({ fromMin: 1200, toMin: 1440, surcharge: 25, actorId: adminId, now: 1000 });

			expect(rule.dayOfWeek).to.equal(null);
			expect(rule.surcharge).to.equal(25);
			expect(repo.shiftRules()).to.have.lengthOf(1);
			expect(lastDetail("shift_rule.create")).to.deep.equal({
				userId: null,
				dayOfWeek: null,
				fromMin: 1200,
				toMin: 1440,
				surcharge: 25,
			});
		});

		it("merges company and user rules, user specific ones win", () => {
			repo.saveShiftRule({ dayOfWeek: 0, fromMin: 600, toMin: 1200, surcharge: 50, actorId: adminId });
			repo.saveShiftRule({ dayOfWeek: 5, fromMin: 1200, surcharge: 25, actorId: adminId });
			repo.saveShiftRule({
				dayOfWeek: 0,
				fromMin: 600,
				toMin: 1200,
				surcharge: 30,
				userId: annaId,
				actorId: adminId,
			});

			expect(repo.shiftRules().map(rule => rule.surcharge)).to.deep.equal([50, 25]);
			const forAnna = repo.shiftRules(annaId);
			expect(forAnna.map(rule => rule.surcharge)).to.deep.equal([30, 25]);
			// sorted by weekday, the open rule (dayOfWeek null) comes last
			expect(forAnna.map(rule => rule.dayOfWeek)).to.deep.equal([0, 5]);
			repo.saveShiftRule({ surcharge: 10, actorId: adminId });
			expect(repo.shiftRules(annaId).map(rule => rule.dayOfWeek)).to.deep.equal([0, 5, null]);
		});

		it("updates a rule and audits the changed fields", () => {
			const rule = repo.saveShiftRule({ dayOfWeek: 6, fromMin: 0, toMin: 1380, surcharge: 25, actorId: adminId });

			const updated = repo.saveShiftRule({
				id: rule.id,
				dayOfWeek: 6,
				fromMin: 0,
				toMin: 1380,
				surcharge: 40,
				isActive: false,
				actorId: adminId,
				now: 2000,
			});

			expect(updated.surcharge).to.equal(40);
			expect(countAudit("shift_rule.update")).to.equal(1);
			expect(lastDetail("shift_rule.update").changes).to.deep.equal({
				surcharge: { old: 25, new: 40 },
				isActive: { old: true, new: false },
			});
			expect(repo.shiftRules()).to.deep.equal([]);
			expect(repo.shiftRules(null, { includeInactive: true })).to.have.lengthOf(1);
		});

		it("validates weekday, window and surcharge", () => {
			expect(() => repo.saveShiftRule({ dayOfWeek: 7, surcharge: 25, actorId: adminId })).to.throw("dayOfWeek");
			expect(() => repo.saveShiftRule({ surcharge: -1, actorId: adminId })).to.throw("surcharge");
			expect(() => repo.saveShiftRule({ fromMin: 1500, surcharge: 25, actorId: adminId })).to.throw("fromMin");
			expect(() => repo.saveShiftRule({ fromMin: 600, toMin: 600, surcharge: 25, actorId: adminId })).to.throw(
				"toMin must be greater than fromMin",
			);
			expect(() => repo.saveShiftRule({ id: 999, surcharge: 25, actorId: adminId })).to.throw(
				"shift rule 999 not found",
			);
			expect(countAudit("shift_rule.create")).to.equal(0);
		});

		it("deletes a rule and audits it", () => {
			const rule = repo.saveShiftRule({ dayOfWeek: 6, surcharge: 50, actorId: adminId });

			expect(repo.removeShiftRule({ id: rule.id, actorId: adminId, now: 4000 })).to.equal(true);
			expect(repo.shiftRules(null, { includeInactive: true })).to.deep.equal([]);
			expect(lastDetail("shift_rule.delete")).to.deep.equal({ userId: null, dayOfWeek: 6, surcharge: 50 });
			expect(repo.removeShiftRule({ id: rule.id, actorId: adminId })).to.equal(false);
		});
	});
});
