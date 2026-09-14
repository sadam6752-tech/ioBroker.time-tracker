/**
 * Versioned database migrations.
 *
 * The schema follows the internal specification (section 2). Rules:
 *  - Times are stored as UTC epoch seconds (INTEGER); durations as whole minutes.
 *  - Local date/time fields (`ts_local`, `local_date`) are derived caches of `ts_utc` + user time zone.
 *  - Every migration is append-only: never change an existing migration, add a new one.
 */

/**
 * A single, append-only schema migration.
 */
export interface Migration {
	/** Monotonically increasing version number, applied in ascending order */
	version: number;
	/** Short description, stored in `schema_migrations` for traceability */
	name: string;
	/** SQL statements (may contain several statements separated by semicolons) */
	sql: string;
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
				legacy_sha1     TEXT,
				display_name    TEXT    NOT NULL,
				email           TEXT,
				rfid_card       TEXT,
				is_active       INTEGER NOT NULL DEFAULT 1,
				must_change_pw  INTEGER NOT NULL DEFAULT 0,
				locale          TEXT    NOT NULL DEFAULT 'de-DE',
				timezone        TEXT    NOT NULL DEFAULT 'Europe/Zurich',
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
				holiday_flags        TEXT,
				legacy_source        TEXT
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
];
