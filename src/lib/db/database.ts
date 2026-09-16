/**
 * SQLite access layer: opening the database, applying migrations.
 *
 * Rules (see internal specification, section 2):
 *  - WAL journal mode, foreign keys enforced, busy timeout for concurrent access.
 *  - Migrations are append-only and applied in one transaction each.
 */

import Database from "better-sqlite3";
import { migrations, type Migration } from "./migrations";

export type Db = Database.Database;

/**
 * Opens (or creates) the database file and applies the required pragmas.
 *
 * @param file - database file path or `:memory:`
 * @returns open database handle
 */
export function openDatabase(file: string): Db {
	const db = new Database(file);
	// WAL keeps readers (PWA/API) working while the adapter writes; ignored for :memory:
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.pragma("synchronous = NORMAL");
	return db;
}

/**
 * Creates the migration bookkeeping table if needed and returns the highest applied version.
 *
 * @param db - open database handle
 * @returns highest applied migration version, 0 when the schema is empty
 */
export function currentSchemaVersion(db: Db): number {
	db.exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT    NOT NULL,
			applied_at INTEGER NOT NULL
		)`,
	);
	const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
		version: number;
	};
	return row.version;
}

/**
 * Applies all pending migrations (ascending) and returns the number of applied migrations.
 *
 * @param db - open database handle
 * @param log - optional log callback (adapter debug log)
 */
export function migrate(db: Db, log?: (message: string) => void): number {
	const applied = currentSchemaVersion(db);
	const pending = migrations
		.filter((migration: Migration) => migration.version > applied)
		.sort((a: Migration, b: Migration) => a.version - b.version);

	for (const migration of pending) {
		const applyOne = db.transaction((m: Migration): void => {
			// a migration brings either SQL text or JavaScript steps (or both)
			if (m.sql) {
				db.exec(m.sql);
			}
			m.run?.(db);
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
				m.version,
				m.name,
				Math.floor(Date.now() / 1000),
			);
		});
		applyOne(migration);
		log?.(`applied database migration ${migration.version}: ${migration.name}`);
	}

	return pending.length;
}

/**
 * Convenience helper: opens the database, applies migrations and returns the handle.
 *
 * @param file - database file path or `:memory:`
 * @param log - optional callback invoked for every applied migration
 * @returns open database handle with an up-to-date schema
 */
export function openAndMigrate(file: string, log?: (message: string) => void): Db {
	const db = openDatabase(file);
	try {
		migrate(db, log);
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}
