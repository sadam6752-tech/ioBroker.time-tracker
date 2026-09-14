/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository } from "./users";
import { createPayoutsRepository, type PayoutsRepository } from "./payouts";

describe("payouts repository", () => {
	let db: Db;
	let repo: PayoutsRepository;
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
		repo = createPayoutsRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	describe("create", () => {
		it("records a payout for a month and audits it", () => {
			const payout = repo.create({
				userId: annaId,
				year: 2026,
				month: 1,
				minutes: 480,
				amount: 120.5,
				note: "Überstunden ausbezahlt",
				actorId: adminId,
				actorIp: "10.0.0.7",
				now: 1000,
			});

			expect(payout.id).to.be.greaterThan(0);
			expect(payout).to.deep.include({
				userId: annaId,
				year: 2026,
				month: 1,
				minutes: 480,
				amount: 120.5,
				note: "Überstunden ausbezahlt",
				createdAt: 1000,
				createdBy: adminId,
			});
			expect(repo.findById(payout.id)).to.deep.equal(payout);
			expect(countAudit("payout.create")).to.equal(1);
			expect(lastDetail("payout.create")).to.deep.equal({
				userId: annaId,
				year: 2026,
				month: 1,
				minutes: 480,
				amount: 120.5,
			});
		});

		it("supports a payout for the whole year", () => {
			const payout = repo.create({ userId: annaId, year: 2026, minutes: 120, actorId: adminId });

			expect(payout.month).to.equal(null);
			expect(payout.amount).to.equal(null);
			expect(payout.note).to.equal(null);
		});

		it("validates year, month, minutes and amount", () => {
			const base = { userId: annaId, year: 2026, actorId: adminId };

			expect(() => repo.create({ ...base, year: 1999, minutes: 60 })).to.throw("year must be a four digit year");
			expect(() => repo.create({ ...base, month: 13, minutes: 60 })).to.throw("month must be between 1 and 12");
			expect(() => repo.create({ ...base, minutes: 0 })).to.throw("minutes must be a whole number and not 0");
			expect(() => repo.create({ ...base, minutes: 1.5 })).to.throw("minutes must be a whole number and not 0");
			expect(() => repo.create({ ...base, minutes: 60, amount: Number.NaN })).to.throw("amount must be a number");
			expect(repo.list(annaId)).to.deep.equal([]);
			expect(countAudit("payout.create")).to.equal(0);
		});
	});

	describe("list and sum", () => {
		beforeEach(() => {
			repo.create({ userId: annaId, year: 2026, month: 1, minutes: 480, actorId: adminId });
			repo.create({ userId: annaId, year: 2026, month: 2, minutes: 60, actorId: adminId });
			repo.create({ userId: annaId, year: 2026, minutes: 30, actorId: adminId });
			repo.create({ userId: annaId, year: 2025, month: 12, minutes: 90, actorId: adminId });
			repo.create({ userId: adminId, year: 2026, month: 1, minutes: 15, actorId: adminId });
		});

		it("filters by year and month and orders newest first", () => {
			expect(repo.list(annaId)).to.have.lengthOf(4);
			// inside a year the monthly payouts come first, a payout for the whole year comes last
			expect(repo.list(annaId, { year: 2026 }).map(payout => payout.month)).to.deep.equal([2, 1, null]);
			expect(repo.list(annaId, { year: 2026, month: 1 }).map(payout => payout.minutes)).to.deep.equal([480]);
			// a month can also be filtered without a year
			expect(repo.list(annaId, { month: 12 }).map(payout => payout.year)).to.deep.equal([2025]);
			expect(repo.list(adminId)).to.have.lengthOf(1);
		});

		it("sums the paid out minutes", () => {
			expect(repo.sumMinutes(annaId, 2026)).to.equal(570);
			expect(repo.sumMinutes(annaId, 2026, 1)).to.equal(480);
			expect(repo.sumMinutes(annaId, 2025)).to.equal(90);
			expect(repo.sumMinutes(annaId, 2024)).to.equal(0);
			expect(repo.sumMinutes(adminId, 2026)).to.equal(15);
		});
	});

	describe("update and remove", () => {
		it("audits the changed fields", () => {
			const payout = repo.create({ userId: annaId, year: 2026, month: 1, minutes: 480, actorId: adminId });

			const updated = repo.update({
				id: payout.id,
				patch: { minutes: 500, amount: 130, note: "korrigiert" },
				actorId: adminId,
				now: 2000,
			});

			expect(updated.minutes).to.equal(500);
			expect(updated.amount).to.equal(130);
			expect(countAudit("payout.update")).to.equal(1);
			expect(lastDetail("payout.update").changes).to.deep.equal({
				minutes: { old: 480, new: 500 },
				amount: { old: null, new: 130 },
				note: { old: null, new: "korrigiert" },
			});

			// an unchanged update writes nothing
			repo.update({ id: payout.id, patch: { minutes: 500 }, actorId: adminId });
			expect(countAudit("payout.update")).to.equal(1);
			expect(() => repo.update({ id: 999, patch: { minutes: 500 }, actorId: adminId })).to.throw(
				"payout 999 not found",
			);
			expect(() => repo.update({ id: payout.id, patch: { minutes: 0 }, actorId: adminId })).to.throw(
				"minutes must be a whole number and not 0",
			);
		});

		it("deletes a payout and audits it", () => {
			const payout = repo.create({ userId: annaId, year: 2026, month: 1, minutes: 480, actorId: adminId });

			expect(repo.remove({ id: payout.id, actorId: adminId, now: 3000 })).to.equal(true);
			expect(repo.findById(payout.id)).to.equal(null);
			expect(repo.sumMinutes(annaId, 2026)).to.equal(0);
			expect(lastDetail("payout.delete")).to.deep.equal({
				userId: annaId,
				year: 2026,
				month: 1,
				minutes: 480,
			});
			expect(repo.remove({ id: payout.id, actorId: adminId })).to.equal(false);
		});
	});
});
