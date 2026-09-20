/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { currentSchemaVersion, openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { ValidationError } from "../errors";
import { createBackupService, recordRestore, type BackupService } from "./backup";
import { applyPendingRestore, pendingRestoreInfoPath, pendingRestorePath, readPendingRestore } from "./backup";

describe("backup service", () => {
	let root: string;
	let dbFile: string;
	let backupDir: string;
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let service: BackupService;
	/** Clock the service uses; shifted to simulate older backups. */
	let clock: number;

	/**
	 * Opens (or reopens) the database file of the test.
	 */
	function open(): void {
		db = openAndMigrate(dbFile);
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
	}

	/**
	 * Appends one employee with one punch.
	 *
	 * @param login - login of the employee
	 */
	function addEmployeeWithPunch(login: string): void {
		const user = users.create({ login, displayName: login, passwordHash: "x", roleKeys: ["employee"] });
		entries.insert({
			userId: user.id,
			tsUtc: 1_000_000,
			timeZone: "Europe/Berlin",
			source: "web",
			actorId: user.id,
			now: 1_000_000,
		});
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "time-tracker-backup-"));
		dbFile = path.join(root, "time-tracker.sqlite");
		backupDir = path.join(root, "backups");
		clock = 1_800_000_000;
		open();
		seed(db, { holidayYears: [2026] });
		service = createBackupService({ db, dir: backupDir, retentionDays: 30, now: () => clock });
	});

	afterEach(() => {
		if (db.open) {
			db.close();
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("writes a consistent copy and reports what it contains", () => {
		addEmployeeWithPunch("anna");
		const file = service.create({ actorId: users.list()[0].id, reason: "test" });

		expect(file.removed).to.deep.equal([]);
		expect(file.backup.name).to.equal("time-tracker-2027-01-15T08-00-00.sqlite");
		expect(file.backup.createdAt).to.equal(clock);
		expect(file.backup.sizeBytes).to.be.greaterThan(0);
		expect(file.backup.schemaVersion).to.equal(currentSchemaVersion(db));
		expect(file.backup.users).to.equal(users.list().length);
		expect(file.backup.entries).to.be.greaterThan(0);
		// the temporary file of the copy is gone, only the finished backup stays
		expect(fs.existsSync(`${file.backup.file}.part`)).to.equal(false);
		expect(service.list().map(entry => entry.name)).to.deep.equal([file.backup.name]);

		const actions = db
			.prepare("SELECT action FROM audit_log ORDER BY id")
			.all()
			.map((row: unknown) => (row as { action: string }).action);
		expect(actions).to.include("backup.create");
	});

	it("keeps the newest backup and removes the expired ones", () => {
		const older = service.create().backup;
		clock += 10 * 86_400;
		const middle = service.create().backup;
		clock += 30 * 86_400;
		const newest = service.create();

		// 40 days old: beyond the retention of 30 days, 10 days old: inside it
		expect(newest.removed).to.deep.equal([older.name]);
		expect(service.list().map(entry => entry.name)).to.deep.equal([newest.backup.name, middle.name]);
		expect(fs.existsSync(older.file)).to.equal(false);
	});

	it("always keeps the newest backup, even without a retention window", () => {
		service = createBackupService({ db, dir: backupDir, retentionDays: 0, now: () => clock });
		const first = service.create().backup;
		clock += 86_400;
		const second = service.create();

		expect(second.removed).to.deep.equal([first.name]);
		expect(service.list().map(entry => entry.name)).to.deep.equal([second.backup.name]);
	});

	it("refuses a file that is not a usable backup", () => {
		expect(() => service.verify(path.join(backupDir, "gibt-es-nicht.sqlite"))).to.throw(ValidationError);

		fs.mkdirSync(backupDir, { recursive: true });
		const garbage = path.join(backupDir, "time-tracker-2027-01-15T08-00-00.sqlite");
		fs.writeFileSync(garbage, "kein sqlite");
		expect(() => service.verify(garbage)).to.throw(/not a readable database/);
	});

	it("refuses to restore while the database is open", () => {
		const backup = service.create().backup;
		expect(() => service.restore(backup.file)).to.throw(/must be closed/);
	});

	it("refuses a database of a foreign schema", () => {
		fs.mkdirSync(backupDir, { recursive: true });
		const foreign = path.join(backupDir, "fremd.sqlite");
		const other = new Database(foreign);
		other.exec("CREATE TABLE irgendwas (x INTEGER)");
		other.close();

		expect(() => service.verify(foreign)).to.throw(/not a backup of this adapter/);
	});

	it("restores a backup and keeps the previous database next to it", () => {
		addEmployeeWithPunch("anna");
		const backup = service.create().backup;
		const expectedUsers = users.list().length;

		// everything after the backup is lost with a restore
		addEmployeeWithPunch("beat");
		expect(users.list().length).to.equal(expectedUsers + 1);

		db.close();
		const result = service.restore(backup.file);
		expect(result.restored.name).to.equal(backup.name);
		expect(result.previous).to.be.a("string");
		expect(fs.existsSync(String(result.previous))).to.equal(true);

		open();
		expect(users.list().map(user => user.login)).to.deep.equal(["anna"]);
		expect(currentSchemaVersion(db)).to.equal(backup.schemaVersion);

		// the restore itself is recorded, so the trail explains the jump in the data
		recordRestore(db, result.restored, null, clock);
		const audit = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'backup.restore'").get() as {
			count: number;
		};
		expect(audit.count).to.equal(1);
	});

	it("queues one of the known backups and applies it at the next start", () => {
		addEmployeeWithPunch("anna");
		const created = service.create();

		// the queue is written next to the database and reported as pending
		const pending = service.queueExistingBackup(created.backup.name, { actorId: null, reason: "test" });
		expect(pending.name).to.equal(created.backup.name);
		expect(pending.users).to.be.greaterThan(0);
		expect(service.pending()?.name).to.equal(created.backup.name);
		expect(readPendingRestore(dbFile)).to.deep.equal(pending);
		expect(fs.existsSync(pendingRestorePath(dbFile))).to.equal(true);

		// the swap itself needs a closed database, so it happens while the adapter starts
		db.close();
		const applied = applyPendingRestore(dbFile, () => clock);

		// the file the administrator queued became the database: it carries the same content
		expect(applied?.restored.entries).to.equal(pending.entries);
		expect(applied?.restored.users).to.equal(pending.users);
		expect(applied?.previous).to.not.equal(null);
		// the queued files are gone, so the next start does not repeat the swap
		expect(readPendingRestore(dbFile)).to.equal(null);
		expect(fs.existsSync(pendingRestoreInfoPath(dbFile))).to.equal(false);
		expect(fs.existsSync(dbFile)).to.equal(true);

		open();
		expect(users.list().length, "the restored file carries the employee").to.equal(1);
	});

	it("deletes a single backup and refuses a name that is not in the list", () => {
		const first = service.create();
		clock += 60;
		const second = service.create();
		expect(service.list().map(file => file.name)).to.deep.equal([second.backup.name, first.backup.name]);

		const removed = service.remove(first.backup.name, { actorId: null, reason: "test" });
		expect(removed.name).to.equal(first.backup.name);
		expect(fs.existsSync(removed.file)).to.equal(false);
		expect(service.list().map(file => file.name)).to.deep.equal([second.backup.name]);

		// the audit trail records which file was deleted
		const audit = db
			.prepare("SELECT entity_id AS entityId FROM audit_log WHERE action = 'backup.remove'")
			.get() as { entityId: string };
		expect(audit.entityId).to.equal(first.backup.name);

		// a name that is not in the list never reaches the file system
		expect(() => service.remove("../time-tracker.sqlite")).to.throw(ValidationError);
		expect(fs.existsSync(dbFile)).to.equal(true);
	});

	it("queues an uploaded file and keeps a waiting restore when the upload is refused", () => {
		addEmployeeWithPunch("anna");
		const source = service.create();

		// the bytes of a real backup arrive as a file and are accepted; the name is only a label, so it is cleaned
		const bytes = fs.readFileSync(source.backup.file);
		const pending = service.queueRestore(bytes, { name: "../../etc/passwd", actorId: null });
		expect(pending.name).to.equal(".._.._etc_passwd");
		expect(pending.sizeBytes).to.equal(bytes.length);
		expect(service.pending()?.name).to.equal(".._.._etc_passwd");
		expect(fs.readFileSync(pendingRestorePath(dbFile)).length).to.equal(bytes.length);

		// bytes that are not a backup change nothing: the queued restore stays exactly as it was
		expect(() => service.queueRestore(Buffer.from("das ist keine Datenbank"), { name: "kaputt.sqlite" })).to.throw(
			ValidationError,
		);
		expect(service.pending()?.name).to.equal(".._.._etc_passwd");
		expect(fs.readFileSync(pendingRestorePath(dbFile)).length).to.equal(bytes.length);
		// the staged copy of the refused upload is cleaned up
		expect(fs.existsSync(`${pendingRestorePath(dbFile)}.part`)).to.equal(false);

		// an empty upload is refused before anything is written
		expect(() => service.queueRestore(Buffer.alloc(0))).to.throw(ValidationError);
	});

	it("keeps the queue when the queued file is not usable", () => {
		fs.writeFileSync(pendingRestorePath(dbFile), "das ist keine Datenbank");
		fs.writeFileSync(
			pendingRestoreInfoPath(dbFile),
			JSON.stringify({ name: "kaputt", actorId: null, queuedAt: clock, sizeBytes: 23, users: 0, entries: 0 }),
		);
		db.close();

		expect(() => applyPendingRestore(dbFile)).to.throw(ValidationError);

		// nothing was swapped or deleted, so a working file can be handed in
		expect(readPendingRestore(dbFile)?.name).to.equal("kaputt");
		expect(fs.existsSync(dbFile)).to.equal(true);
	});

	it("ignores files that are not backups", () => {
		// without a directory there is nothing to report
		expect(service.list()).to.deep.equal([]);

		fs.mkdirSync(backupDir, { recursive: true });
		fs.writeFileSync(path.join(backupDir, "time-tracker-halb-fertig.sqlite.part"), "abgebrochen");
		fs.writeFileSync(path.join(backupDir, "time-tracker-kein-datum.sqlite"), "kein Datum");
		expect(service.list()).to.deep.equal([]);
	});

	it("refuses to restore an in-memory database", () => {
		const backup = service.create().backup;
		// an in-memory database has no file to overwrite, so a restore cannot land anywhere
		const memory = openAndMigrate(":memory:");
		const memoryService = createBackupService({ db: memory, dir: backupDir, now: () => clock });
		memory.close();

		expect(() => memoryService.restore(backup.file)).to.throw(/in-memory database cannot be restored/);
	});

	it("restores into a missing database file without keeping a copy", () => {
		addEmployeeWithPunch("anna");
		const backup = service.create().backup;
		const expectedUsers = users.list().length;

		db.close();
		fs.rmSync(dbFile, { force: true });
		const result = service.restore(backup.file);
		// nothing was there to keep
		expect(result.previous).to.equal(null);

		open();
		expect(users.list().length).to.equal(expectedUsers);
	});
});
