/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createDayNotesRepository, MAX_DAY_NOTE_LENGTH, type DayNotesRepository } from "./dayNotes";
import { createUsersRepository } from "./users";

describe("day notes repository", () => {
	let db: Db;
	let dayNotes: DayNotesRepository;
	let annaId: number;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		const users = createUsersRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		dayNotes = createDayNotesRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("writes, replaces and removes the note of one day", () => {
		const created = dayNotes.save({
			userId: annaId,
			localDate: "2026-01-07",
			note: " vergessen auszustempeln ",
			actorId: annaId,
			now: 5000,
		});
		expect(created).to.deep.include({
			userId: annaId,
			localDate: "2026-01-07",
			note: "vergessen auszustempeln",
			createdBy: annaId,
			createdAt: 5000,
			handledAt: null,
		});

		const updated = dayNotes.save({
			userId: annaId,
			localDate: "2026-01-07",
			note: "doch nur vergessen",
			actorId: adminId,
			now: 6000,
		});
		expect(updated?.note).to.equal("doch nur vergessen");
		expect(updated?.updatedBy).to.equal(adminId);

		expect(dayNotes.listByRange(annaId, "2026-01-01", "2026-01-31")).to.have.lengthOf(1);
		expect(dayNotes.find(annaId, "2026-01-08")).to.equal(null);

		expect(
			dayNotes.save({ userId: annaId, localDate: "2026-01-07", note: "", actorId: annaId, now: 7000 }),
		).to.equal(null);
		expect(dayNotes.find(annaId, "2026-01-07")).to.equal(null);

		const actions = (
			db.prepare("SELECT action FROM audit_log WHERE entity = 'day_notes' ORDER BY id").all() as {
				action: string;
			}[]
		).map(row => row.action);
		expect(actions).to.deep.equal(["day_note.create", "day_note.update", "day_note.delete"]);
	});

	it("marks a note as handled and validates the input", () => {
		expect(() => dayNotes.save({ userId: annaId, localDate: "07.01.2026", note: "x", actorId: annaId })).to.throw(
			/date/,
		);
		expect(() =>
			dayNotes.save({
				userId: annaId,
				localDate: "2026-01-07",
				note: "x".repeat(MAX_DAY_NOTE_LENGTH + 1),
				actorId: annaId,
			}),
		).to.throw(/500/);
		expect(() =>
			dayNotes.setHandled({ userId: annaId, localDate: "2026-01-07", handled: true, actorId: adminId }),
		).to.throw(/not found/);

		dayNotes.save({
			userId: annaId,
			localDate: "2026-01-07",
			note: "Kommen vergessen",
			actorId: annaId,
			now: 5000,
		});
		const handled = dayNotes.setHandled({
			userId: annaId,
			localDate: "2026-01-07",
			handled: true,
			actorId: adminId,
			now: 9000,
		});
		expect(handled.handledAt).to.equal(9000);
		expect(handled.handledBy).to.equal(adminId);

		const open = dayNotes.setHandled({
			userId: annaId,
			localDate: "2026-01-07",
			handled: false,
			actorId: adminId,
			now: 9500,
		});
		expect(open.handledAt).to.equal(null);
		expect(open.handledBy).to.equal(null);
	});
});
