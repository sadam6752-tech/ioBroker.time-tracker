/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { diffFields, writeAuditLog, writeTimeEntryAudit } from "./audit";

describe("audit helpers", () => {
	let db: Db;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
	});

	afterEach(() => {
		db.close();
	});

	describe("writeAuditLog", () => {
		it("stores action, entity and serialised detail", () => {
			const id = writeAuditLog(db, {
				atUtc: 1000,
				actorId: 7,
				action: "entry.update",
				entity: "time_entry",
				entityId: 42,
				detail: { reason: "typo" },
				ip: "10.0.0.5",
			});

			const row = db
				.prepare(
					"SELECT at_utc AS atUtc, actor_id AS actorId, action, entity, entity_id AS entityId, detail, ip FROM audit_log WHERE id = ?",
				)
				.get(id) as {
				atUtc: number;
				actorId: number;
				action: string;
				entity: string;
				entityId: string;
				detail: string;
				ip: string;
			};

			expect(row.atUtc).to.equal(1000);
			expect(row.actorId).to.equal(7);
			expect(row.action).to.equal("entry.update");
			expect(row.entity).to.equal("time_entry");
			// ids are stored as text so that both numbers and keys can be used
			expect(row.entityId).to.equal("42");
			expect(JSON.parse(row.detail)).to.deep.equal({ reason: "typo" });
			expect(row.ip).to.equal("10.0.0.5");
		});

		it("tolerates missing optional values and defaults the instant to now", () => {
			const before = Math.floor(Date.now() / 1000);
			const id = writeAuditLog(db, { action: "system.start" });

			const row = db
				.prepare("SELECT at_utc AS atUtc, actor_id AS actorId, entity, detail FROM audit_log WHERE id = ?")
				.get(id) as {
				atUtc: number;
				actorId: number | null;
				entity: string | null;
				detail: string | null;
			};

			expect(row.atUtc).to.be.at.least(before);
			expect(row.actorId).to.equal(null);
			expect(row.entity).to.equal(null);
			expect(row.detail).to.equal(null);
		});
	});

	describe("writeTimeEntryAudit", () => {
		it("stores the changes as JSON and keeps the reason", () => {
			const id = writeTimeEntryAudit(db, {
				entryId: 5,
				userId: 2,
				action: "update",
				changes: { tsUtc: { old: 100, new: 200 } },
				oldTsUtc: 100,
				newTsUtc: 200,
				revision: 3,
				reason: "corrected",
				actorId: 1,
				actorIp: "127.0.0.1",
				atUtc: 1500,
			});

			const row = db
				.prepare(
					"SELECT entry_id AS entryId, user_id AS userId, action, changes, old_ts_utc AS oldTsUtc, new_ts_utc AS newTsUtc, revision, reason, actor_id AS actorId, actor_ip AS actorIp, at_utc AS atUtc FROM time_entry_audit WHERE id = ?",
				)
				.get(id) as {
				entryId: number;
				userId: number;
				action: string;
				changes: string;
				oldTsUtc: number;
				newTsUtc: number;
				revision: number;
				reason: string;
				actorId: number;
				actorIp: string;
				atUtc: number;
			};

			expect(row.entryId).to.equal(5);
			expect(row.userId).to.equal(2);
			expect(row.action).to.equal("update");
			expect(JSON.parse(row.changes)).to.deep.equal({ tsUtc: { old: 100, new: 200 } });
			expect(row.oldTsUtc).to.equal(100);
			expect(row.newTsUtc).to.equal(200);
			expect(row.revision).to.equal(3);
			expect(row.reason).to.equal("corrected");
			expect(row.actorId).to.equal(1);
			expect(row.actorIp).to.equal("127.0.0.1");
			expect(row.atUtc).to.equal(1500);
		});

		it("allows a null entry id for deletions", () => {
			const id = writeTimeEntryAudit(db, { entryId: null, userId: 2, action: "delete", actorId: 1 });

			const row = db
				.prepare("SELECT entry_id AS entryId, changes FROM time_entry_audit WHERE id = ?")
				.get(id) as {
				entryId: number | null;
				changes: string | null;
			};

			expect(row.entryId).to.equal(null);
			expect(row.changes).to.equal(null);
		});
	});

	describe("diffFields", () => {
		it("compares typed records field by field", () => {
			expect(diffFields({ a: 1, b: "x" }, { a: 1, b: "y" }, ["a", "b"])).to.deep.equal({
				b: { old: "x", new: "y" },
			});
			expect(diffFields({ a: 1 }, { a: 1 }, ["a"])).to.deep.equal({});
			// null and undefined are different values
			expect(
				diffFields({ a: null as string | null | undefined }, { a: undefined as string | null | undefined }, [
					"a",
				]),
			).to.deep.equal({ a: { old: null, new: undefined } });
		});

		it("reports several changes at once", () => {
			expect(diffFields({ a: 1, b: 2, c: 3 }, { a: 9, b: 2, c: 8 }, ["a", "b", "c"])).to.deep.equal({
				a: { old: 1, new: 9 },
				c: { old: 3, new: 8 },
			});
		});
	});
});
