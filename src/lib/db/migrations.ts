/**
 * Versioned database migrations.
 *
 * The schema follows the internal specification (section 2). Rules:
 *  - Times are stored as UTC epoch seconds (INTEGER); durations as whole minutes.
 *  - Local date/time fields (`ts_local`, `local_date`) are derived caches of `ts_utc` + user time zone.
 *  - Migrations are never *reinterpreted*: a released migration keeps its effect for databases that already
 *    ran it, and every schema change comes as a new migration. Definitions that only freshly created
 *    databases ever see may be tidied up afterwards, as long as fresh and upgraded installations end up with
 *    the same schema (see migration 10, which cleans up behind migrations 1, 2 and 5).
 */

import type { Db } from "./database";

/**
 * A single schema migration: either plain SQL or a JavaScript step for changes that SQL cannot express
 * (e.g. “drop this column, but only when it is still there”).
 */
export interface Migration {
	/** Monotonically increasing version number, applied in ascending order */
	version: number;
	/** Short description, stored in `schema_migrations` for traceability */
	name: string;
	/** SQL statements (may contain several statements separated by semicolons) */
	sql?: string;
	/** JavaScript steps, run inside the same transaction as `sql` */
	run?: (db: Db) => void;
}

/**
 * Checks whether a table has a column.
 *
 * Migrations that clean up after older versions use this to stay safe for both kinds of database: one that was
 * created by an older version and one that was created by the current one (which never creates the column).
 *
 * @param db - open database handle
 * @param table - table name
 * @param column - column name
 * @returns true when the column exists
 */
export function hasColumn(db: Db, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.some(row => row.name === column);
}

export const migrations: Migration[] = [
	{
		version: 1,
		name: "core: users, roles, permissions, work profiles, shift and pause rules, settings, sessions, audit, import runs",
		sql: `
			CREATE TABLE users (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				login           TEXT    NOT NULL UNIQUE,
				password_hash   TEXT    NOT NULL DEFAULT '',
				display_name    TEXT    NOT NULL,
				email           TEXT,
				rfid_card       TEXT,
				is_active       INTEGER NOT NULL DEFAULT 1,
				must_change_pw  INTEGER NOT NULL DEFAULT 0,
				locale          TEXT    NOT NULL DEFAULT 'de-DE',
				timezone        TEXT    NOT NULL DEFAULT 'Europe/Berlin',
				created_at      INTEGER NOT NULL,
				updated_at      INTEGER NOT NULL,
				last_login_at   INTEGER
			);

			CREATE TABLE roles (
				id    INTEGER PRIMARY KEY AUTOINCREMENT,
				key   TEXT NOT NULL UNIQUE,
				name  TEXT NOT NULL
			);

			CREATE TABLE permissions (
				id   INTEGER PRIMARY KEY AUTOINCREMENT,
				key  TEXT NOT NULL UNIQUE
			);

			CREATE TABLE role_permissions (
				role_id       INTEGER NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
				permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
				PRIMARY KEY (role_id, permission_id)
			);

			CREATE TABLE user_roles (
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
				PRIMARY KEY (user_id, role_id)
			);

			CREATE TABLE work_profiles (
				user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
				percent              REAL    NOT NULL DEFAULT 100,
				weekly_hours         REAL    NOT NULL DEFAULT 42.5,
				workdays             TEXT    NOT NULL DEFAULT '0;1;1;1;1;1;0',
				start_date           INTEGER,
				end_date             INTEGER,
				overtime_carryover   INTEGER NOT NULL DEFAULT 0,
				vorholzeit_per_year  INTEGER NOT NULL DEFAULT 0,
				vacation_carryover   REAL    NOT NULL DEFAULT 0,
				vacation_per_year    REAL    NOT NULL DEFAULT 0,
				overtime_model       TEXT    NOT NULL DEFAULT 'monthly'
				                     CHECK (overtime_model IN ('cumulative','yearly','monthly')),
				holiday_flags        TEXT
			);

			CREATE TABLE shift_rules (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
				day_of_week INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
				from_min    INTEGER,
				to_min      INTEGER,
				surcharge   REAL    NOT NULL DEFAULT 0,
				is_active   INTEGER NOT NULL DEFAULT 1
			);

			CREATE TABLE pause_rules (
				id        INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
				from_min  INTEGER NOT NULL,
				to_min    INTEGER,
				pause_min INTEGER NOT NULL,
				is_active INTEGER NOT NULL DEFAULT 1,
				CHECK (to_min IS NULL OR to_min > from_min)
			);

			CREATE TABLE app_settings (
				key        TEXT PRIMARY KEY,
				value      TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE TABLE sessions (
				id         TEXT PRIMARY KEY,
				user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				user_agent TEXT,
				ip         TEXT,
				revoked    INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE audit_log (
				id        INTEGER PRIMARY KEY AUTOINCREMENT,
				at_utc    INTEGER NOT NULL,
				actor_id  INTEGER,
				action    TEXT NOT NULL,
				entity    TEXT,
				entity_id TEXT,
				detail    TEXT,
				ip        TEXT
			);

			CREATE TABLE import_runs (
				id               INTEGER PRIMARY KEY AUTOINCREMENT,
				source           TEXT NOT NULL,
				source_path      TEXT NOT NULL,
				started_at       INTEGER NOT NULL,
				finished_at      INTEGER,
				mode             TEXT NOT NULL DEFAULT 'dry-run'
				                 CHECK (mode IN ('dry-run','commit')),
				status           TEXT NOT NULL DEFAULT 'running'
				                 CHECK (status IN ('running','ok','warnings','mismatch','failed')),
				timezone_assumed TEXT,
				stats            TEXT,
				warnings         TEXT,
				actor_id         INTEGER REFERENCES users(id)
			);
		`,
	},
	{
		version: 2,
		name: "time: entries, audit, day/month/year aggregates, payouts",
		sql: `
			CREATE TABLE time_entries (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				ts_utc          INTEGER NOT NULL,
				client_ts_utc   INTEGER,
				ts_local        INTEGER NOT NULL,
				local_date      TEXT    NOT NULL,
				direction       TEXT    NOT NULL DEFAULT 'auto'
				                CHECK (direction IN ('in','out','auto')),
				source          TEXT    NOT NULL DEFAULT 'web'
				                CHECK (source IN ('web','nfc','terminal','api','admin','import')),
				idempotency_key TEXT,
				sync_state      TEXT    NOT NULL DEFAULT 'synced'
				                CHECK (sync_state IN ('synced','pending','conflict')),
				revision        INTEGER NOT NULL DEFAULT 1,
				note            TEXT,
				created_by      INTEGER REFERENCES users(id),
				created_at      INTEGER NOT NULL,
				updated_at      INTEGER NOT NULL,
				updated_by      INTEGER REFERENCES users(id)
			);

			CREATE INDEX idx_entries_user_date ON time_entries(user_id, local_date);
			CREATE INDEX idx_entries_user_ts   ON time_entries(user_id, ts_utc);
			CREATE UNIQUE INDEX idx_entries_idem
				ON time_entries(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

			CREATE TABLE time_entry_audit (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				entry_id   INTEGER,
				user_id    INTEGER NOT NULL,
				action     TEXT    NOT NULL,
				changes    TEXT,
				old_ts_utc INTEGER,
				new_ts_utc INTEGER,
				revision   INTEGER,
				reason     TEXT,
				actor_id   INTEGER NOT NULL,
				actor_ip   TEXT,
				at_utc     INTEGER NOT NULL
			);
			CREATE INDEX idx_entry_audit_entry ON time_entry_audit(entry_id);
		`,
	},
	{
		version: 3,
		name: "aggregates: day, month, year and payouts",
		sql: `
			CREATE TABLE day_aggregates (
				user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				local_date     TEXT    NOT NULL,
				worked_min     INTEGER NOT NULL DEFAULT 0,
				break_min      INTEGER NOT NULL DEFAULT 0,
				target_min     INTEGER NOT NULL DEFAULT 0,
				balance_min    INTEGER NOT NULL DEFAULT 0,
				absence_code   TEXT,
				is_holiday     INTEGER NOT NULL DEFAULT 0,
				first_in_utc   INTEGER,
				last_out_utc   INTEGER,
				has_open_entry INTEGER NOT NULL DEFAULT 0,
				updated_at     INTEGER NOT NULL,
				PRIMARY KEY (user_id, local_date)
			);

			CREATE TABLE month_aggregates (
				user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				year          INTEGER NOT NULL,
				month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
				worked_min    INTEGER NOT NULL DEFAULT 0,
				target_min    INTEGER NOT NULL DEFAULT 0,
				balance_min   INTEGER NOT NULL DEFAULT 0,
				overtime_min  INTEGER NOT NULL DEFAULT 0,
				vacation_used REAL    NOT NULL DEFAULT 0,
				updated_at    INTEGER NOT NULL,
				PRIMARY KEY (user_id, year, month)
			);

			CREATE TABLE year_aggregates (
				user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				year                  INTEGER NOT NULL,
				worked_min            INTEGER NOT NULL DEFAULT 0,
				target_min            INTEGER NOT NULL DEFAULT 0,
				overtime_min          INTEGER NOT NULL DEFAULT 0,
				overtime_start        INTEGER NOT NULL DEFAULT 0,
				vacation_days         REAL    NOT NULL DEFAULT 0,
				vacation_used         REAL    NOT NULL DEFAULT 0,
				vacation_left         REAL    NOT NULL DEFAULT 0,
				vacation_planned_days REAL    NOT NULL DEFAULT 0,
				settled               INTEGER NOT NULL DEFAULT 0,
				updated_at            INTEGER NOT NULL,
				PRIMARY KEY (user_id, year)
			);

			CREATE TABLE payouts (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				year       INTEGER NOT NULL,
				month      INTEGER,
				minutes    INTEGER NOT NULL DEFAULT 0,
				amount     REAL,
				note       TEXT,
				created_at INTEGER NOT NULL,
				created_by INTEGER REFERENCES users(id)
			);
			CREATE INDEX idx_payouts_user ON payouts(user_id, year, month);
		`,
	},
	{
		version: 4,
		name: "absence: types, absences, holidays",
		sql: `
			CREATE TABLE absence_types (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
				code            TEXT    NOT NULL,
				name            TEXT    NOT NULL,
				paid            INTEGER NOT NULL DEFAULT 1,
				factor          REAL    NOT NULL DEFAULT 100,
				reduce_vacation INTEGER NOT NULL DEFAULT 0,
				is_active       INTEGER NOT NULL DEFAULT 1
			);

			CREATE UNIQUE INDEX idx_absence_types_global
				ON absence_types(code) WHERE user_id IS NULL;
			CREATE UNIQUE INDEX idx_absence_types_user
				ON absence_types(user_id, code) WHERE user_id IS NOT NULL;

			CREATE TABLE absences (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				type_id     INTEGER NOT NULL REFERENCES absence_types(id),
				date_from   TEXT    NOT NULL,
				date_to     TEXT    NOT NULL,
				day_portion REAL    NOT NULL DEFAULT 1 CHECK (day_portion > 0 AND day_portion <= 1),
				hours       REAL,
				status      TEXT    NOT NULL DEFAULT 'taken'
				            CHECK (status IN ('taken','planned')),
				note        TEXT,
				created_at  INTEGER NOT NULL,
				created_by  INTEGER REFERENCES users(id),
				CHECK (date_from <= date_to)
			);
			CREATE INDEX idx_absences_user_dates ON absences(user_id, date_from, date_to);

			CREATE TABLE holidays (
				id     INTEGER PRIMARY KEY AUTOINCREMENT,
				region TEXT    NOT NULL DEFAULT 'global',
				year   INTEGER NOT NULL,
				date   TEXT    NOT NULL,
				name   TEXT    NOT NULL,
				UNIQUE (region, date)
			);
			CREATE INDEX idx_holidays_year ON holidays(year, region);
		`,
	},
	{
		version: 5,
		name: "devices: rfid tags and kiosk terminals",
		sql: `
			CREATE TABLE rfid_tags (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				uid          TEXT,
				token_hash   TEXT    NOT NULL,
				user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
				label        TEXT,
				is_active    INTEGER NOT NULL DEFAULT 1,
				expires_at   INTEGER,
				last_used_at INTEGER,
				created_at   INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX idx_rfid_uid ON rfid_tags(uid) WHERE uid IS NOT NULL;

			CREATE TABLE kiosk_terminals (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				name         TEXT    NOT NULL,
				location     TEXT,
				token_hash   TEXT    NOT NULL,
				pin_required INTEGER NOT NULL DEFAULT 1,
				is_active    INTEGER NOT NULL DEFAULT 1,
				expires_at   INTEGER,
				last_seen_at INTEGER,
				created_at   INTEGER NOT NULL
			);
		`,
	},
	{
		version: 6,
		name: "users: personal PIN for the kiosk terminal",
		sql: `ALTER TABLE users ADD COLUMN pin_hash TEXT;`,
	},
	{
		version: 7,
		name: "kiosk terminals: short lived sessions",
		sql: `
			ALTER TABLE kiosk_terminals ADD COLUMN session_hash       TEXT;
			ALTER TABLE kiosk_terminals ADD COLUMN session_expires_at INTEGER;
		`,
	},
	{
		version: 8,
		name: "defaults: time zone Europe/Zurich becomes Europe/Berlin",
		sql: `
			-- The default time zone of the adapter is Europe/Berlin now. Migration 1 is append-only, so a new
			-- database already gets the new default with it; existing installations are adjusted here: every
			-- employee and every instance setting that still carries the old default is moved over. Values that
			-- were chosen deliberately keep their name — they only change when they are exactly the old default.
			UPDATE users        SET timezone = 'Europe/Berlin' WHERE timezone = 'Europe/Zurich';
			UPDATE app_settings SET value    = 'Europe/Berlin' WHERE key = 'timezone' AND value = 'Europe/Zurich';
		`,
	},
	{
		version: 9,
		name: "users: picture of the employee",
		sql: `ALTER TABLE users ADD COLUMN avatar TEXT;`,
	},
	{
		version: 10,
		name: "drops the leftovers of the removed data import",
		run: (db: Db): void => {
			// The adapter does not read data of another time tracking system any more, so the columns that existed
			// for it are dropped. Fresh databases never create them (migrations 1, 2 and 5 are clean), so every
			// step asks first: an upgraded database loses the columns, a fresh one has nothing to do.
			if (hasColumn(db, "users", "legacy_sha1")) {
				db.exec("ALTER TABLE users DROP COLUMN legacy_sha1");
			}
			if (hasColumn(db, "work_profiles", "legacy_source")) {
				db.exec("ALTER TABLE work_profiles DROP COLUMN legacy_source");
			}

			// rfid_tags carried the printed card number of that system as a second identifier. SQLite cannot drop
			// a column that a CHECK constraint mentions, so the table is rebuilt without it; existing rows keep
			// their id, their uid and their token hash, and the unique index on the uid is recreated.
			if (!hasColumn(db, "rfid_tags", "legacy_code")) {
				return;
			}
			db.exec(`
				CREATE TABLE rfid_tags_new (
					id           INTEGER PRIMARY KEY AUTOINCREMENT,
					uid          TEXT,
					token_hash   TEXT    NOT NULL,
					user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
					label        TEXT,
					is_active    INTEGER NOT NULL DEFAULT 1,
					expires_at   INTEGER,
					last_used_at INTEGER,
					created_at   INTEGER NOT NULL
				);
				INSERT INTO rfid_tags_new (id, uid, token_hash, user_id, label, is_active, expires_at, last_used_at, created_at)
					SELECT id, uid, token_hash, user_id, label, is_active, expires_at, last_used_at, created_at
					FROM rfid_tags;
				DROP TABLE rfid_tags;
				ALTER TABLE rfid_tags_new RENAME TO rfid_tags;
				CREATE UNIQUE INDEX idx_rfid_uid ON rfid_tags(uid) WHERE uid IS NOT NULL;
			`);
		},
	},
	{
		version: 11,
		name: "terminals: the employees of a terminal",
		sql: `
			-- A terminal stands at one place — an office, a workshop — and is meant for the employees that work
			-- there. No row for a terminal means "all employees", so terminals that existed before keep working
			-- exactly as they did.
			CREATE TABLE terminal_users (
				terminal_id INTEGER NOT NULL REFERENCES kiosk_terminals(id) ON DELETE CASCADE,
				user_id     INTEGER NOT NULL REFERENCES users(id)           ON DELETE CASCADE,
				created_at  INTEGER NOT NULL,
				PRIMARY KEY (terminal_id, user_id)
			);
			CREATE INDEX idx_terminal_users_user ON terminal_users(user_id);
		`,
	},
	{
		version: 12,
		name: "work profiles: paid breaks",
		sql: `ALTER TABLE work_profiles ADD COLUMN pause_paid INTEGER NOT NULL DEFAULT 0;`,
	},
	{
		version: 13,
		name: "work profiles: paid break minutes instead of the paid flag",
		run: (db: Db): void => {
			// The flag became an amount: a company may pay a quarter of an hour and nothing more. A profile that had
			// the flag set keeps a fully paid break (a day has 1440 minutes), a fresh profile pays nothing at all.
			if (!hasColumn(db, "work_profiles", "pause_paid_minutes")) {
				db.exec("ALTER TABLE work_profiles ADD COLUMN pause_paid_minutes INTEGER NOT NULL DEFAULT 0");
			}
			if (hasColumn(db, "work_profiles", "pause_paid")) {
				db.exec("UPDATE work_profiles SET pause_paid_minutes = 1440 WHERE pause_paid = 1");
				db.exec("ALTER TABLE work_profiles DROP COLUMN pause_paid");
			}
		},
	},
	{
		version: 14,
		name: "day aggregates: paid break minutes",
		sql: `ALTER TABLE day_aggregates ADD COLUMN paid_break_min INTEGER NOT NULL DEFAULT 0;`,
	},
	{
		version: 15,
		name: "trigger rules: ioBroker states that punch or set the presence",
		sql: `
			-- A rule watches a state of another adapter (a fingerprint reader, a button, a door contact) and turns a
			-- write on it into a punch or a presence change. Mode "condition" fires when the value matches
			-- "condition" and punches for "user_id"; mode "user" posts the employee the value names. "last_fired_at"
			-- keeps a chatty reader in check together with "cooldown_sec".
			CREATE TABLE trigger_rules (
				id            INTEGER PRIMARY KEY AUTOINCREMENT,
				label         TEXT,
				source_state  TEXT    NOT NULL,
				mode          TEXT    NOT NULL DEFAULT 'condition'
					CHECK (mode IN ('condition','user')),
				condition     TEXT,
				user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
				action        TEXT    NOT NULL DEFAULT 'punch'
					CHECK (action IN ('punch','quickPunch','present','absent')),
				is_active     INTEGER NOT NULL DEFAULT 1,
				cooldown_sec  INTEGER NOT NULL DEFAULT 0,
				last_fired_at INTEGER,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL
			);
			CREATE INDEX idx_trigger_rules_source ON trigger_rules(source_state);
		`,
	},
	{
		version: 16,
		name: "automation rules: what the adapter does on its own (clock out, reminders)",
		sql: `
			-- A rule of the adapter itself, not of a foreign state: at a certain local time (clockOut, missingPunch)
			-- or after a while without a break (breakReminder) the adapter acts. "user_id" is NULL for every
			-- employee, so a company rule and a rule for one person can live side by side.
			CREATE TABLE automation_rules (
				id            INTEGER PRIMARY KEY AUTOINCREMENT,
				label         TEXT,
				kind          TEXT    NOT NULL
					CHECK (kind IN ('clockOut','missingPunch','breakReminder')),
				user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
				at_minute     INTEGER,
				after_minutes INTEGER,
				is_active     INTEGER NOT NULL DEFAULT 1,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL
			);
			CREATE INDEX idx_automation_rules_kind ON automation_rules(kind);

			-- What a rule already did: one row per rule, employee and local date keeps it at "once a day" and doubles
			-- as the log the administration shows. A punch that is already written is never written twice.
			CREATE TABLE automation_runs (
				rule_id    INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
				user_id    INTEGER NOT NULL REFERENCES users(id)            ON DELETE CASCADE,
				local_date TEXT    NOT NULL,
				fired_at   INTEGER NOT NULL,
				action     TEXT    NOT NULL,
				PRIMARY KEY (rule_id, user_id, local_date)
			);
			CREATE INDEX idx_automation_runs_user ON automation_runs(user_id, local_date);
		`,
	},
	{
		version: 17,
		name: "automation rules: weekdays and a weekly instead of a daily guard",
		sql: `
			-- A rule can be limited to certain weekdays: bit 0 is Monday … bit 6 is Sunday, 127 is every day.
			ALTER TABLE automation_rules ADD COLUMN weekdays INTEGER NOT NULL DEFAULT 127;

			-- 'day' keeps the guard of one run per employee and date, 'week' allows one run per ISO week.
			ALTER TABLE automation_rules ADD COLUMN repeat TEXT NOT NULL DEFAULT 'day';

			-- the guard column no longer holds a date only: for a weekly rule it is the ISO week (2026-W38), so the
			-- name says what it keeps. Existing rows stay valid — a date is the period of a daily rule.
			ALTER TABLE automation_runs RENAME COLUMN local_date TO period;
		`,
	},
];
