/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository, type UsersRepository } from "./users";
import { createTerminalsRepository, hashToken, type TerminalsRepository } from "./terminals";

describe("terminals repository", () => {
	let db: Db;
	let users: UsersRepository;
	let repo: TerminalsRepository;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		repo = createTerminalsRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
	});

	afterEach(() => {
		db.close();
	});

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

	it("hands out a device token exactly once and only stores its hash", () => {
		const { terminal, deviceToken } = repo.create({
			name: "Werkstatt",
			location: "Halle 1",
			actorId: adminId,
			now: 1000,
		});

		expect(deviceToken).to.be.a("string").and.have.length.greaterThan(20);
		expect(terminal).to.deep.include({
			name: "Werkstatt",
			location: "Halle 1",
			pinRequired: true,
			isActive: true,
			expiresAt: null,
			lastSeenAt: null,
		});
		// the record never carries the token, and the stored hash is a SHA-256
		expect(JSON.stringify(terminal)).to.not.contain(deviceToken);
		const stored = db.prepare("SELECT token_hash FROM kiosk_terminals WHERE id = ?").get(terminal.id) as {
			token_hash: string;
		};
		expect(stored.token_hash).to.equal(hashToken(deviceToken));
		expect(stored.token_hash).to.have.lengthOf(64);
		// the audit trail records the creation without the secret
		expect(countAudit("terminal.create")).to.equal(1);
		const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'terminal.create'").get() as {
			detail: string;
		};
		expect(audit.detail).to.not.contain(deviceToken);

		expect(repo.findByToken(deviceToken, 1000)?.id).to.equal(terminal.id);
		expect(repo.findByToken("falsch")).to.equal(null);
		expect(repo.findById(terminal.id)?.name).to.equal("Werkstatt");
		expect(repo.list().map(entry => entry.name)).to.deep.equal(["Werkstatt"]);
	});

	it("refuses invalid input and expired tokens", () => {
		expect(() => repo.create({ name: "  ", actorId: adminId })).to.throw(/name is required/);
		expect(() => repo.create({ name: "X", ttlDays: 0, actorId: adminId })).to.throw(/ttlDays must be/);

		const { deviceToken } = repo.create({ name: "Kurz", ttlDays: 1, actorId: adminId, now: 1000 });
		// the day after tomorrow the token is worthless
		expect(repo.findByToken(deviceToken, 1000 + 2 * 86400)).to.equal(null);
	});

	it("starts a session that replaces the previous one and expires", () => {
		const { terminal } = repo.create({ name: "Werkstatt", actorId: adminId, now: 1000 });

		const first = repo.startSession({ id: terminal.id, ttlMinutes: 15, now: 1000 });
		expect(first.expiresAt).to.equal(1000 + 15 * 60);
		expect(repo.findBySession(first.terminalSession, 1030)?.id).to.equal(terminal.id);

		// a second device session invalidates the first one
		const second = repo.startSession({ id: terminal.id, ttlMinutes: 15, now: 1010 });
		expect(repo.findBySession(first.terminalSession, 1030)).to.equal(null);
		expect(repo.findBySession(second.terminalSession, 1030)?.id).to.equal(terminal.id);

		// the heartbeat extends the session and records the life sign
		const extended = repo.touch({ id: terminal.id, ttlMinutes: 15, now: 1020 });
		expect(extended.expiresAt).to.equal(1020 + 15 * 60);
		expect(repo.findBySession(second.terminalSession, 1030)?.lastSeenAt).to.equal(1020);

		expect(() => repo.startSession({ id: 999, ttlMinutes: 15 })).to.throw(/not found/);
	});

	it("revokes a terminal and ends its session", () => {
		const { terminal, deviceToken } = repo.create({ name: "Werkstatt", actorId: adminId, now: 1000 });
		const session = repo.startSession({ id: terminal.id, ttlMinutes: 15, now: 1000 });

		expect(repo.revoke({ id: terminal.id, actorId: adminId, now: 2000 })).to.equal(true);
		expect(repo.findByToken(deviceToken, 1000)).to.equal(null);
		expect(repo.findBySession(session.terminalSession, 2000)).to.equal(null);
		expect(repo.list()).to.have.lengthOf(0);
		expect(repo.list({ includeInactive: true })).to.have.lengthOf(1);
		expect(countAudit("terminal.revoke")).to.equal(1);

		// a second revoke finds nothing to do
		expect(repo.revoke({ id: terminal.id, actorId: adminId })).to.equal(false);
		expect(repo.revoke({ id: 999, actorId: adminId })).to.equal(false);
	});

	it("remembers the employees of a terminal", () => {
		const annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		const { terminal } = repo.create({
			name: "Werkstatt",
			userIds: [adminId, annaId, annaId],
			actorId: adminId,
			now: 1000,
		});

		// duplicates are dropped, the order follows the ids
		expect(terminal.userIds).to.deep.equal([adminId, annaId].sort((a, b) => a - b));

		// a later selection replaces the list, an empty one means “all employees”
		expect(
			repo.setUsers({ id: terminal.id, userIds: [annaId], actorId: adminId, now: 2000 }).userIds,
		).to.deep.equal([annaId]);
		expect(repo.setUsers({ id: terminal.id, userIds: [], actorId: adminId, now: 3000 }).userIds).to.deep.equal([]);
		expect(countAudit("terminal.users")).to.equal(2);

		// the record and the list carry the assignment with them
		expect(repo.findById(terminal.id)?.userIds).to.deep.equal([]);
		expect(repo.list()[0]?.userIds).to.deep.equal([]);

		// an unknown terminal is refused
		expect(() => repo.setUsers({ id: 999, userIds: [], actorId: adminId })).to.throw(/not found/);
	});
});
