/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository } from "./users";
import { createTriggersRepository, type TriggersRepository } from "./triggers";

describe("triggers repository", () => {
	let db: Db;
	let repo: TriggersRepository;
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
	 * Reads the detail of the newest audit row of one action.
	 *
	 * @param action - action key
	 * @returns parsed detail object
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
		repo = createTriggersRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	it("stores a condition rule and audits the creation", () => {
		const rule = repo.save({
			label: "Finger am Leser",
			sourceState: "fingerprint.0.lastMatch",
			condition: "1",
			userId: annaId,
			actorId: adminId,
			now: 1000,
		});

		expect(rule).to.deep.include({
			label: "Finger am Leser",
			sourceState: "fingerprint.0.lastMatch",
			mode: "condition",
			condition: "1",
			userId: annaId,
			action: "punch",
			isActive: true,
			cooldownSec: 0,
			lastFiredAt: null,
		});
		expect(repo.list()).to.have.length(1);
		expect(countAudit("trigger_rule.create")).to.equal(1);
		expect(lastDetail("trigger_rule.create")).to.deep.include({ sourceState: "fingerprint.0.lastMatch" });
	});

	it("refuses a condition rule without a value or without an employee", () => {
		expect(() => repo.save({ sourceState: "a.0.b", userId: annaId, actorId: adminId })).to.throw(
			"condition is required",
		);
		expect(() => repo.save({ sourceState: "a.0.b", condition: "1", actorId: adminId })).to.throw(
			"userId must reference",
		);
		expect(() =>
			repo.save({ sourceState: "has space", condition: "1", userId: annaId, actorId: adminId }),
		).to.throw("whitespace");
		expect(() =>
			repo.save({ sourceState: "a.0.b", condition: "1", userId: annaId, cooldownSec: -1, actorId: adminId }),
		).to.throw("cooldownSec");
		expect(repo.list()).to.be.empty;
	});

	it("uses the value as the employee in mode user", () => {
		const rule = repo.save({
			sourceState: "fingerprint.0.user",
			mode: "user",
			condition: "ignored",
			userId: annaId,
			action: "present",
			actorId: adminId,
		});

		expect(rule).to.deep.include({ mode: "user", condition: null, userId: null, action: "present" });
	});

	it("audits only the changed fields and keeps a stretch of the same rule quiet", () => {
		const rule = repo.save({
			sourceState: "a.0.b",
			condition: "true",
			userId: annaId,
			actorId: adminId,
			now: 1000,
		});
		const before = countAudit("trigger_rule.update");

		repo.save({ id: rule.id, sourceState: "a.0.b", condition: "true", userId: annaId, actorId: adminId });
		expect(countAudit("trigger_rule.update")).to.equal(before);

		const changed = repo.save({
			id: rule.id,
			sourceState: "a.0.b",
			condition: "true",
			userId: annaId,
			cooldownSec: 30,
			isActive: false,
			actorId: adminId,
			now: 2000,
		});
		expect(changed).to.deep.include({ cooldownSec: 30, isActive: false });
		expect(countAudit("trigger_rule.update")).to.equal(before + 1);
		expect(lastDetail("trigger_rule.update")).to.have.property("changes").that.has.property("cooldownSec");

		// a disabled rule disappears from the default list but stays reachable
		expect(repo.list()).to.be.empty;
		expect(repo.list({ includeInactive: true })).to.have.length(1);
		expect(repo.findById(rule.id)).to.not.equal(null);
	});

	it("refuses an unknown id and deletes with an audit row", () => {
		expect(() =>
			repo.save({ id: 999, sourceState: "a.0.b", condition: "1", userId: annaId, actorId: adminId }),
		).to.throw("not found");

		const rule = repo.save({ sourceState: "a.0.b", condition: "1", userId: annaId, actorId: adminId });
		expect(repo.remove({ id: rule.id, actorId: adminId, now: 3000 })).to.equal(true);
		expect(repo.remove({ id: rule.id, actorId: adminId })).to.equal(false);
		expect(repo.list({ includeInactive: true })).to.be.empty;
		expect(countAudit("trigger_rule.delete")).to.equal(1);
	});

	it("remembers a fire without touching the configuration", () => {
		const rule = repo.save({
			sourceState: "a.0.b",
			condition: "1",
			userId: annaId,
			cooldownSec: 60,
			actorId: adminId,
			now: 1000,
		});
		repo.markFired({ id: rule.id, now: 5000 });

		const reloaded = repo.findById(rule.id);
		expect(reloaded?.lastFiredAt).to.equal(5000);
		expect(reloaded?.cooldownSec).to.equal(60);
		// the fire is not a configuration change: no additional audit row
		expect(countAudit("trigger_rule.update")).to.equal(0);
	});
});
