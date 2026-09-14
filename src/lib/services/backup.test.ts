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
			timeZone: "Europe/Zurich",
			source: "web",
			actorId: user.id,
			now: 1_000_000,
		});
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "zeiterfassung-backup-"));
		dbFile = path.join(root, "zeiterfassung.sqlite");
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
		expect(file.backup.name).to.equal("zeiterfassung-2027-01-15T08-00-00.sqlite");
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
		const garbage = path.join(backupDir, "zeiterfassung-2027-01-15T08-00-00.sqlite");
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
});
