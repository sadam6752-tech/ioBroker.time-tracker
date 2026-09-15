/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { readTimeEntryAudit } from "./audit";
import { createEntriesRepository, RevisionConflictError, toPunchEntries } from "./entries";

const berlin = "Europe/Berlin";
const t0 = 1767222000; // 2026-01-01T00:00+01:00

function insertUser(db: Db, login = "tester"): number {
	const now = Math.floor(Date.now() / 1000);
	const result = db
		.prepare("INSERT INTO users (login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
		.run(login, "Tester", now, now);
	return Number(result.lastInsertRowid);
}

function countAuditLog(db: Db, action: string): number {
	return (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = ?").get(action) as { c: number }).c;
}

function countEntries(db: Db): number {
	return (db.prepare("SELECT COUNT(*) AS c FROM time_entries").get() as { c: number }).c;
}

describe("entries repository", () => {
	let db: Db;
	let repo: ReturnType<typeof createEntriesRepository>;
	let userId: number;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		repo = createEntriesRepository(db);
		userId = insertUser(db);
		adminId = insertUser(db, "admin");
	});

	afterEach(() => {
		db.close();
	});

	it("derives the local cache fields from the time zone", () => {
		const { entry, created } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });

		expect(created).to.equal(true);
		expect(entry.localDate).to.equal("2026-01-01");
		expect(entry.tsLocal).to.equal(1767225600); // local wall clock frame (UTC+1 in January)
		expect(entry.revision).to.equal(1);
		expect(entry.syncState).to.equal("synced");
		expect(entry.source).to.equal("web");
		expect(entry.direction).to.equal("auto");
	});

	it("records the creation in the audit trail", () => {
		const { entry } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });
		const audit = readTimeEntryAudit(db, entry.id);

		expect(audit).to.have.lengthOf(1);
		expect(audit[0].action).to.equal("create");
		expect(audit[0].revision).to.equal(1);
		expect(audit[0].actorId).to.equal(userId);
		expect(audit[0].atUtc).to.equal(1000);
	});

	it("returns the existing punch for a repeated idempotency key", () => {
		const first = repo.insert({ userId, tsUtc: t0, timeZone: berlin, idempotencyKey: "uuid-1", now: 1000 });
		const second = repo.insert({ userId, tsUtc: t0 + 60, timeZone: berlin, idempotencyKey: "uuid-1", now: 2000 });

		expect(first.created).to.equal(true);
		expect(second.created).to.equal(false);
		expect(second.entry.id).to.equal(first.entry.id);
		expect(second.entry.tsUtc).to.equal(t0); // the stored punch wins
		expect(countEntries(db)).to.equal(1);
		expect(readTimeEntryAudit(db, first.entry.id)).to.have.lengthOf(1);
	});

	it("accepts the same idempotency key for another user", () => {
		repo.insert({ userId, tsUtc: t0, timeZone: berlin, idempotencyKey: "shared", now: 1000 });
		repo.insert({ userId: adminId, tsUtc: t0, timeZone: berlin, idempotencyKey: "shared", now: 1000 });

		expect(countEntries(db)).to.equal(2);
	});

	it("updates a punch and audits the changed fields", () => {
		const { entry } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });
		const updated = repo.update({
			id: entry.id,
			expectedRevision: 1,
			patch: { tsUtc: t0 + 3600, note: "corrected" },
			reason: "typo while punching",
			actorId: adminId,
			actorIp: "10.0.0.1",
			timeZone: berlin,
			now: 2000,
		});

		expect(updated.revision).to.equal(2);
		expect(updated.tsUtc).to.equal(t0 + 3600);
		expect(updated.note).to.equal("corrected");

		const audit = readTimeEntryAudit(db, entry.id);
		expect(audit).to.have.lengthOf(2);
		expect(audit[0].action).to.equal("update");
		expect(audit[0].revision).to.equal(2);
		expect(audit[0].reason).to.equal("typo while punching");
		expect(Object.keys(audit[0].changes ?? {}).sort()).to.deep.equal(["note", "tsUtc"]);
		expect(audit[0].changes?.tsUtc.old).to.equal(t0);
		expect(audit[0].changes?.tsUtc.new).to.equal(t0 + 3600);
		expect(countAuditLog(db, "entry.update")).to.equal(1);
	});

	it("recomputes the local date when the timestamp moves to another day", () => {
		const { entry } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });
		const updated = repo.update({
			id: entry.id,
			expectedRevision: 1,
			patch: { tsUtc: t0 + 25 * 3600 },
			actorId: adminId,
			timeZone: berlin,
			now: 2000,
		});

		expect(updated.localDate).to.equal("2026-01-02");
	});

	it("rejects a stale revision", () => {
		const { entry } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });
		repo.update({
			id: entry.id,
			expectedRevision: 1,
			patch: { note: "first" },
			actorId: adminId,
			timeZone: berlin,
			now: 2000,
		});

		let error: unknown;
		try {
			repo.update({
				id: entry.id,
				expectedRevision: 1,
				patch: { note: "second" },
				actorId: adminId,
				timeZone: berlin,
				now: 3000,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(RevisionConflictError);
		expect((error as RevisionConflictError).current.revision).to.equal(2);
		expect((error as RevisionConflictError).entryId).to.equal(entry.id);
		// the second change was not applied
		expect(repo.findById(entry.id)?.note).to.equal("first");
		expect(readTimeEntryAudit(db, entry.id)).to.have.lengthOf(2);
	});

	it("keeps the revision when nothing changes", () => {
		const { entry } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });
		const unchanged = repo.update({
			id: entry.id,
			expectedRevision: 1,
			patch: { note: null },
			actorId: adminId,
			timeZone: berlin,
			now: 2000,
		});

		expect(unchanged.revision).to.equal(1);
		expect(readTimeEntryAudit(db, entry.id)).to.have.lengthOf(1);
	});

	it("deletes a punch and keeps the audit trail", () => {
		const { entry } = repo.insert({ userId, tsUtc: t0, timeZone: berlin, now: 1000 });
		expect(repo.remove({ id: entry.id, actorId: adminId, reason: "duplicate", now: 2000 })).to.equal(true);

		expect(repo.findById(entry.id)).to.equal(null);
		const audit = readTimeEntryAudit(db, entry.id);
		expect(audit[0].action).to.equal("delete");
		expect(audit[0].reason).to.equal("duplicate");
		expect(countAuditLog(db, "entry.delete")).to.equal(1);
		expect(repo.remove({ id: entry.id, actorId: adminId })).to.equal(false);
	});

	it("finds a punch by its idempotency key and lists punches by sync state", () => {
		const stored = repo.insert({
			userId,
			tsUtc: t0,
			timeZone: berlin,
			idempotencyKey: "offline-1",
			syncState: "conflict",
			now: 1000,
		}).entry;
		repo.insert({ userId, tsUtc: t0 + 3600, timeZone: berlin, now: 1000 });

		expect(repo.findByIdempotencyKey(userId, "offline-1")?.id).to.equal(stored.id);
		expect(repo.findByIdempotencyKey(userId, "unknown")).to.equal(null);
		expect(repo.findByIdempotencyKey(adminId, "offline-1")).to.equal(null);
		expect(repo.listBySyncState(userId, "conflict").map(entry => entry.id)).to.deep.equal([stored.id]);
		expect(repo.listBySyncState(userId, "pending")).to.deep.equal([]);
	});

	it("moves a punch between synchronisation states", () => {
		const stored = repo.insert({ userId, tsUtc: t0, timeZone: berlin, syncState: "conflict", now: 1000 }).entry;

		const synced = repo.setSyncState({
			id: stored.id,
			syncState: "synced",
			actorId: adminId,
			reason: "clock corrected",
			now: 2000,
		});

		expect(synced.syncState).to.equal("synced");
		expect(repo.listBySyncState(userId, "conflict")).to.deep.equal([]);
		// the revision is untouched, the change is audited
		expect(synced.revision).to.equal(stored.revision);
		expect(countAuditLog(db, "entry.sync_state")).to.equal(1);

		// setting the same state again does nothing
		repo.setSyncState({ id: stored.id, syncState: "synced", actorId: adminId });
		expect(countAuditLog(db, "entry.sync_state")).to.equal(1);
		expect(() => repo.setSyncState({ id: 999, syncState: "synced", actorId: adminId })).to.throw(
			"entry 999 not found",
		);
	});

	it("lists punches by date and range in chronological order", () => {
		repo.insert({ userId, tsUtc: t0 + 10 * 3600, timeZone: berlin, now: 1000 });
		repo.insert({ userId, tsUtc: t0 + 8 * 3600, timeZone: berlin, now: 1000 });
		repo.insert({ userId, tsUtc: t0 + 30 * 3600, timeZone: berlin, now: 1000 }); // next day

		const day = repo.listByDate(userId, "2026-01-01");
		expect(day.map(entry => entry.tsUtc)).to.deep.equal([t0 + 8 * 3600, t0 + 10 * 3600]);
		expect(toPunchEntries(day)).to.have.lengthOf(2);

		const range = repo.listByRange(userId, "2026-01-01", "2026-01-02");
		expect(range).to.have.lengthOf(3);
		expect(repo.listByRange(userId, "2026-01-02", "2026-01-02")).to.have.lengthOf(1);
		expect(repo.listByDate(adminId, "2026-01-01")).to.deep.equal([]);
	});
});
