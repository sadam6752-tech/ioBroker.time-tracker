/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository, type UsersRepository } from "./users";
import { createAbsencesRepository, UnknownAbsenceTypeError, type AbsencesRepository } from "./absences";

describe("absences repository", () => {
	let db: Db;
	let users: UsersRepository;
	let repo: AbsencesRepository;
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
		users = createUsersRepository(db);
		repo = createAbsencesRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	describe("types", () => {
		it("lists the seeded global types sorted by code", () => {
			const types = repo.types();

			expect(types.map(type => type.code)).to.deep.equal(["E", "F", "I", "K", "M", "U", "W"]);
			const vacation = types.find(type => type.code === "F");
			expect(vacation?.name).to.equal("Ferien");
			expect(vacation?.paid).to.equal(true);
			expect(vacation?.factor).to.equal(100);
			expect(vacation?.reduceVacation).to.equal(true);
			expect(vacation?.userId).to.equal(null);
			// "Weiterbildung" is credited with 50 %
			expect(types.find(type => type.code === "W")?.factor).to.equal(50);
		});

		it("resolves types by code and id and prefers user specific rows", () => {
			expect(repo.findType("F")?.code).to.equal("F");
			expect(repo.findType("F", annaId)?.name).to.equal("Ferien");
			expect(repo.findType(999)).to.equal(null);
			expect(repo.findType("nope")).to.equal(null);

			const globalId = repo.findType("F")?.id ?? 0;
			expect(repo.findType(globalId)?.code).to.equal("F");

			// a user specific type with the same code wins
			db.prepare(
				"INSERT INTO absence_types (user_id, code, name, paid, factor, reduce_vacation, is_active) VALUES (?, 'F', 'Urlaub', 1, 100, 1, 1)",
			).run(annaId);
			expect(repo.findType("F", annaId)?.name).to.equal("Urlaub");
			expect(repo.findType("F")?.name).to.equal("Ferien");
		});

		it("hides inactive types unless asked for them", () => {
			db.prepare("UPDATE absence_types SET is_active = 0 WHERE code = 'M'").run();

			expect(repo.types().map(type => type.code)).to.not.include("M");
			expect(repo.types({ includeInactive: true }).map(type => type.code)).to.include("M");
		});
	});

	describe("create", () => {
		it("creates a planned absence for a single day by default", () => {
			const absence = repo.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-07-06",
				actorId: annaId,
				now: 1000,
			});

			expect(absence.id).to.be.greaterThan(0);
			expect(absence.dateFrom).to.equal("2026-07-06");
			// a single day absence ends on its first day
			expect(absence.dateTo).to.equal("2026-07-06");
			expect(absence.dayPortion).to.equal(1);
			expect(absence.status).to.equal("planned");
			expect(absence.hours).to.equal(null);
			expect(absence.createdAt).to.equal(1000);
			expect(absence.createdBy).to.equal(annaId);
			expect(repo.findById(absence.id)?.typeId).to.equal(repo.findType("F")?.id);
			expect(countAudit("absence.create")).to.equal(1);
			expect(lastDetail("absence.create")).to.deep.equal({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-07-06",
				dateTo: "2026-07-06",
				dayPortion: 1,
				status: "planned",
			});
		});

		it("stores a range, a half day and the status", () => {
			const absence = repo.create({
				userId: annaId,
				typeId: repo.findType("K")?.id,
				dateFrom: "2026-02-02",
				dateTo: "2026-02-06",
				dayPortion: 0.5,
				hours: 4,
				status: "taken",
				note: "halbe Tage",
				actorId: adminId,
			});

			expect(absence.dateTo).to.equal("2026-02-06");
			expect(absence.dayPortion).to.equal(0.5);
			expect(absence.hours).to.equal(4);
			expect(absence.status).to.equal("taken");
			expect(absence.note).to.equal("halbe Tage");
		});

		it("rejects an unknown type without writing anything", () => {
			expect(() =>
				repo.create({ userId: annaId, typeCode: "X", dateFrom: "2026-07-06", actorId: annaId }),
			).to.throw(UnknownAbsenceTypeError);
			expect(() => repo.create({ userId: annaId, dateFrom: "2026-07-06", actorId: annaId })).to.throw(
				UnknownAbsenceTypeError,
			);
			expect(repo.listByUser(annaId)).to.deep.equal([]);
			expect(countAudit("absence.create")).to.equal(0);
		});

		it("validates dates and the day portion", () => {
			const base = { userId: annaId, typeCode: "F", actorId: annaId };

			expect(() => repo.create({ ...base, dateFrom: "06.07.2026" })).to.throw(
				'dateFrom "06.07.2026" is not a date',
			);
			expect(() => repo.create({ ...base, dateFrom: "2026-02-30" })).to.throw("is not a date");
			expect(() => repo.create({ ...base, dateFrom: "2026-07-06", dateTo: "2026-07-01" })).to.throw(
				"must not be after dateTo",
			);
			expect(() => repo.create({ ...base, dateFrom: "2026-07-06", dayPortion: 0 })).to.throw("dayPortion");
			expect(() => repo.create({ ...base, dateFrom: "2026-07-06", dayPortion: 1.5 })).to.throw("dayPortion");
			expect(repo.listByUser(annaId)).to.deep.equal([]);
		});
	});

	describe("update and status", () => {
		it("audits the changed fields of an absence", () => {
			const absence = repo.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-07-06",
				dateTo: "2026-07-10",
				actorId: annaId,
				now: 1000,
			});

			const updated = repo.update({
				id: absence.id,
				patch: { dateTo: "2026-07-12", note: "verlängert" },
				reason: "Flug verschoben",
				actorId: adminId,
				now: 2000,
			});

			expect(updated.dateTo).to.equal("2026-07-12");
			expect(updated.note).to.equal("verlängert");
			expect(countAudit("absence.update")).to.equal(1);
			const detail = lastDetail("absence.update");
			expect(detail.reason).to.equal("Flug verschoben");
			expect(detail.changes).to.deep.equal({
				dateTo: { old: "2026-07-10", new: "2026-07-12" },
				note: { old: null, new: "verlängert" },
			});
		});

		it("changes the type by code and skips unchanged writes", () => {
			const absence = repo.create({ userId: annaId, typeCode: "F", dateFrom: "2026-07-06", actorId: annaId });

			const changedType = repo.update({ id: absence.id, patch: { typeCode: "K" }, actorId: adminId });
			expect(changedType.typeId).to.equal(repo.findType("K")?.id);
			expect(countAudit("absence.update")).to.equal(1);

			const unchanged = repo.update({ id: absence.id, patch: { typeCode: "K" }, actorId: adminId });
			expect(unchanged.typeId).to.equal(changedType.typeId);
			expect(countAudit("absence.update")).to.equal(1);
		});

		it("rejects an unknown type or an inverted range", () => {
			const absence = repo.create({ userId: annaId, typeCode: "F", dateFrom: "2026-07-06", actorId: annaId });

			expect(() => repo.update({ id: absence.id, patch: { typeCode: "X" }, actorId: adminId })).to.throw(
				UnknownAbsenceTypeError,
			);
			expect(() => repo.update({ id: absence.id, patch: { dateTo: "2026-07-01" }, actorId: adminId })).to.throw(
				"must not be after dateTo",
			);
			expect(() => repo.update({ id: 999, patch: { note: "x" }, actorId: adminId })).to.throw(
				"absence 999 not found",
			);
			expect(repo.findById(absence.id)?.typeId).to.equal(repo.findType("F")?.id);
		});

		it("moves an absence between planned and taken", () => {
			const absence = repo.create({ userId: annaId, typeCode: "F", dateFrom: "2026-07-06", actorId: annaId });
			expect(absence.status).to.equal("planned");

			const taken = repo.setStatus({ id: absence.id, status: "taken", actorId: adminId, now: 3000 });
			expect(taken.status).to.equal("taken");
			expect(countAudit("absence.status")).to.equal(1);
			expect(lastDetail("absence.status")).to.deep.equal({
				changes: { status: { old: "planned", new: "taken" } },
			});

			// setting the same status again changes nothing
			repo.setStatus({ id: absence.id, status: "taken", actorId: adminId });
			expect(countAudit("absence.status")).to.equal(1);
			expect(() => repo.setStatus({ id: 999, status: "taken", actorId: adminId })).to.throw(
				"absence 999 not found",
			);
		});
	});

	describe("queries", () => {
		beforeEach(() => {
			repo.create({
				userId: annaId,
				typeCode: "F",
				dateFrom: "2026-07-06",
				dateTo: "2026-07-10",
				status: "taken",
				actorId: annaId,
			});
			repo.create({ userId: annaId, typeCode: "K", dateFrom: "2026-03-02", actorId: annaId });
			repo.create({ userId: annaId, typeCode: "F", dateFrom: "2027-01-04", actorId: annaId });
			repo.create({ userId: adminId, typeCode: "F", dateFrom: "2026-07-06", actorId: adminId });
		});

		it("lists absences of a year or a range", () => {
			expect(repo.listByUser(annaId, { year: 2026 }).map(absence => absence.dateFrom)).to.deep.equal([
				"2026-03-02",
				"2026-07-06",
			]);
			expect(repo.listByUser(annaId).map(absence => absence.dateFrom)).to.deep.equal([
				"2026-03-02",
				"2026-07-06",
				"2027-01-04",
			]);
			expect(repo.listByUser(annaId, { from: "2026-07-01", to: "2026-07-31" })).to.have.lengthOf(1);
			expect(repo.listByUser(999)).to.deep.equal([]);
		});

		it("finds the absences covering a single day", () => {
			expect(repo.forDate(annaId, "2026-07-08")).to.have.lengthOf(1);
			expect(repo.forDate(annaId, "2026-07-06")).to.have.lengthOf(1);
			expect(repo.forDate(annaId, "2026-07-11")).to.deep.equal([]);
			expect(repo.forDate(adminId, "2026-07-08")).to.deep.equal([]);
		});

		it("returns the absences with their type information", () => {
			const absences = repo.withTypesInRange(annaId, "2026-01-01", "2026-12-31");

			expect(absences).to.have.lengthOf(2);
			const vacation = absences.find(absence => absence.typeCode === "F");
			expect(vacation?.typeName).to.equal("Ferien");
			expect(vacation?.factor).to.equal(100);
			expect(vacation?.reduceVacation).to.equal(true);
			expect(vacation?.status).to.equal("taken");
			expect(absences.find(absence => absence.typeCode === "K")?.reduceVacation).to.equal(false);
		});
	});

	describe("remove", () => {
		it("deletes an absence and audits it", () => {
			const absence = repo.create({ userId: annaId, typeCode: "F", dateFrom: "2026-07-06", actorId: annaId });

			expect(repo.remove({ id: absence.id, actorId: adminId, now: 4000 })).to.equal(true);
			expect(repo.findById(absence.id)).to.equal(null);
			expect(countAudit("absence.delete")).to.equal(1);
			expect(lastDetail("absence.delete")).to.deep.equal({
				userId: annaId,
				dateFrom: "2026-07-06",
				dateTo: "2026-07-06",
				status: "planned",
			});
			expect(repo.remove({ id: absence.id, actorId: adminId })).to.equal(false);
		});
	});
});
