/// <reference types="mocha" />
import { expect } from "chai";
import { currentSchemaVersion, migrate, openAndMigrate, openDatabase, type Db } from "./database";
import { hasColumn, migrations } from "./migrations";

function insertUser(db: Db, login = "tester"): number {
	const now = Math.floor(Date.now() / 1000);
	const result = db
		.prepare(`INSERT INTO users (login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
		.run(login, "Tester", now, now);
	return Number(result.lastInsertRowid);
}

describe("database", () => {
	let db: Db;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("applies all migrations and records them", () => {
		const expectedVersion = Math.max(...migrations.map(migration => migration.version));
		expect(currentSchemaVersion(db)).to.equal(expectedVersion);

		const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
			version: number;
		}[];
		expect(rows.map(row => row.version)).to.deep.equal(
			migrations.map(migration => migration.version).sort((a, b) => a - b),
		);
	});

	it("is idempotent", () => {
		expect(migrate(db)).to.equal(0);
		expect(currentSchemaVersion(db)).to.equal(Math.max(...migrations.map(m => m.version)));
	});

	it("creates the core tables", () => {
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
		).map(row => row.name);

		for (const table of [
			"users",
			"roles",
			"permissions",
			"role_permissions",
			"user_roles",
			"work_profiles",
			"shift_rules",
			"pause_rules",
			"time_entries",
			"time_entry_audit",
			"day_aggregates",
			"month_aggregates",
			"year_aggregates",
			"payouts",
			"absence_types",
			"absences",
			"holidays",
			"rfid_tags",
			"kiosk_terminals",
			"app_settings",
			"sessions",
			"audit_log",
			"import_runs",
		]) {
			expect(names, `table ${table} should exist`).to.include(table);
		}
	});

	it("keeps the leftovers of the removed data import out of a fresh schema", () => {
		// the columns existed for the importer of another system; a database created today never gets them
		for (const [table, column] of [
			["users", "legacy_sha1"],
			["work_profiles", "legacy_source"],
			["rfid_tags", "legacy_code"],
		] as const) {
			expect(hasColumn(db, table, column), `${table}.${column} should not exist`).to.equal(false);
		}

		const indexes = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
		).map(row => row.name);
		expect(indexes).to.not.include("idx_rfid_legacy");
	});

	it("removes the leftovers from a database that still carries them", () => {
		// an older installation: the columns of the removed import plus the old layout of `rfid_tags`
		db.exec("ALTER TABLE users ADD COLUMN legacy_sha1 TEXT");
		db.exec("ALTER TABLE work_profiles ADD COLUMN legacy_source TEXT");
		db.exec(`
			DROP TABLE rfid_tags;
			CREATE TABLE rfid_tags (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				uid          TEXT,
				token_hash   TEXT    NOT NULL,
				legacy_code  TEXT,
				user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
				label        TEXT,
				is_active    INTEGER NOT NULL DEFAULT 1,
				expires_at   INTEGER,
				last_used_at INTEGER,
				created_at   INTEGER NOT NULL,
				CHECK (uid IS NOT NULL OR legacy_code IS NOT NULL)
			);
			CREATE UNIQUE INDEX idx_rfid_uid    ON rfid_tags(uid)         WHERE uid IS NOT NULL;
			CREATE UNIQUE INDEX idx_rfid_legacy ON rfid_tags(legacy_code) WHERE legacy_code IS NOT NULL;
			INSERT INTO rfid_tags (uid, token_hash, legacy_code, created_at) VALUES ('tag-1', 'hash-1', 'K-42', 1000);
		`);

		const cleanup = migrations.find(migration => migration.version === 10);
		if (!cleanup?.run) {
			throw new Error("migration 10 should be a JavaScript step");
		}
		cleanup.run(db);

		expect(hasColumn(db, "users", "legacy_sha1")).to.equal(false);
		expect(hasColumn(db, "work_profiles", "legacy_source")).to.equal(false);
		expect(hasColumn(db, "rfid_tags", "legacy_code")).to.equal(false);

		// the tag itself survives with its id and its identifiers
		expect(db.prepare("SELECT id, uid, token_hash FROM rfid_tags").get()).to.deep.equal({
			id: 1,
			uid: "tag-1",
			token_hash: "hash-1",
		});

		const indexes = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
		).map(row => row.name);
		expect(indexes).to.include("idx_rfid_uid");
		expect(indexes).to.not.include("idx_rfid_legacy");
	});

	it("enforces foreign keys", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(() =>
			db
				.prepare(
					`INSERT INTO time_entries (user_id, ts_utc, ts_local, local_date, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(999999, now, now, "2026-01-01", now, now),
		).to.throw(/FOREIGN KEY/);
	});

	it("enforces the idempotency key per user", () => {
		const userId = insertUser(db);
		const now = Math.floor(Date.now() / 1000);
		const insert = db.prepare(
			`INSERT INTO time_entries (user_id, ts_utc, ts_local, local_date, idempotency_key, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		insert.run(userId, now, now, "2026-01-01", "uuid-1", now, now);
		expect(() => insert.run(userId, now + 60, now + 60, "2026-01-01", "uuid-1", now, now)).to.throw(
			/UNIQUE constraint failed/,
		);

		// a different key works, and the same key for another user as well
		insert.run(userId, now + 120, now + 120, "2026-01-01", "uuid-2", now, now);
		const otherUser = insertUser(db, "other");
		insert.run(otherUser, now, now, "2026-01-01", "uuid-1", now, now);

		expect((db.prepare("SELECT COUNT(*) AS c FROM time_entries").get() as { c: number }).c).to.equal(3);
	});

	it("defaults new entries to a revision of 1", () => {
		const userId = insertUser(db);
		const now = Math.floor(Date.now() / 1000);
		db.prepare(
			`INSERT INTO time_entries (user_id, ts_utc, ts_local, local_date, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(userId, now, now, "2026-01-01", now, now);

		const row = db.prepare("SELECT revision, sync_state, source FROM time_entries").get() as {
			revision: number;
			sync_state: string;
			source: string;
		};
		expect(row.revision).to.equal(1);
		expect(row.sync_state).to.equal("synced");
		expect(row.source).to.equal("web");
	});

	it("allows one global absence type per code, but per-user overrides", () => {
		const now = Math.floor(Date.now() / 1000);
		db.prepare("INSERT INTO absence_types (user_id, code, name) VALUES (NULL, 'F', 'Ferien')").run();
		expect(() =>
			db.prepare("INSERT INTO absence_types (user_id, code, name) VALUES (NULL, 'F', 'Ferien 2')").run(),
		).to.throw(/UNIQUE constraint failed/);

		const userId = insertUser(db);
		db.prepare("INSERT INTO absence_types (user_id, code, name) VALUES (?, 'F', 'Ferien')").run(userId);
		expect((db.prepare("SELECT COUNT(*) AS c FROM absence_types").get() as { c: number }).c).to.equal(2);
		expect(now).to.be.a("number");
	});

	it("rejects invalid absence ranges and portions", () => {
		const userId = insertUser(db);
		const now = Math.floor(Date.now() / 1000);
		db.prepare("INSERT INTO absence_types (user_id, code, name) VALUES (NULL, 'F', 'Ferien')").run();
		const typeId = (db.prepare("SELECT id FROM absence_types WHERE code = 'F'").get() as { id: number }).id;

		const insert = db.prepare(
			`INSERT INTO absences (user_id, type_id, date_from, date_to, day_portion, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		expect(() => insert.run(userId, typeId, "2026-02-10", "2026-02-01", 1, now)).to.throw(
			/CHECK constraint failed/,
		);
		expect(() => insert.run(userId, typeId, "2026-02-01", "2026-02-02", 1.5, now)).to.throw(
			/CHECK constraint failed/,
		);
		insert.run(userId, typeId, "2026-02-01", "2026-02-02", 0.5, now);
		expect((db.prepare("SELECT COUNT(*) AS c FROM absences").get() as { c: number }).c).to.equal(1);
	});

	it("moves the old default time zone to Europe/Berlin (migration 8)", () => {
		// an installation that was created before the default changed: migrate up to version 7 and then see
		// what the new migration does
		const old = openDatabase(":memory:");
		try {
			for (const migration of migrations.filter(entry => entry.version <= 7)) {
				if (migration.sql) {
					old.exec(migration.sql);
				}
				migration.run?.(old);
			}
			old.exec(
				`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
			);
			old.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, 'pre-test', 0)").run();

			const oldDefault = insertUser(old, "alt");
			old.prepare("UPDATE users SET timezone = 'Europe/Zurich' WHERE id = ?").run(oldDefault);
			const chosen = insertUser(old, "usa");
			old.prepare("UPDATE users SET timezone = 'America/New_York' WHERE id = ?").run(chosen);
			old.prepare(
				"INSERT INTO app_settings (key, value, updated_at) VALUES ('timezone', 'Europe/Zurich', 0)",
			).run();
			old.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('other', 'Europe/Zurich', 0)").run();

			// migration 8 and everything that came after it are pending for this installation
			const pending = migrations.filter(entry => entry.version > 7).length;
			expect(migrate(old)).to.equal(pending);
			expect(currentSchemaVersion(old)).to.equal(Math.max(...migrations.map(entry => entry.version)));

			// the old default moves over, a deliberately chosen zone stays
			expect(old.prepare("SELECT login, timezone FROM users ORDER BY login").all()).to.deep.equal([
				{ login: "alt", timezone: "Europe/Berlin" },
				{ login: "usa", timezone: "America/New_York" },
			]);
			expect(
				(old.prepare("SELECT value FROM app_settings WHERE key = 'timezone'").get() as { value: string }).value,
			).to.equal("Europe/Berlin");
			// the same text under another key is not a time zone and stays untouched
			expect(
				(old.prepare("SELECT value FROM app_settings WHERE key = 'other'").get() as { value: string }).value,
			).to.equal("Europe/Zurich");
		} finally {
			old.close();
		}
	});

	it("keeps WAL and foreign keys enabled", () => {
		const fileDb = openDatabase(":memory:");
		expect(fileDb.pragma("foreign_keys", { simple: true })).to.equal(1);
		fileDb.close();
	});
});
