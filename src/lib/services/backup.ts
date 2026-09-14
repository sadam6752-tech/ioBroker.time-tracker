/**
 * Backup service: hot copies of the database, retention and a tested restore.
 *
 * A backup is taken with `VACUUM INTO` — SQLite writes a consistent, defragmented copy while the adapter keeps
 * working, so there is no need to stop anything for a daily backup. The file is written next to its final name
 * and renamed afterwards, so a half written copy never looks like a usable backup.
 *
 * Files are named `<prefix><YYYY-MM-DDTHH-MM-SS>.sqlite` in UTC; the name is the only place the time is kept,
 * which keeps the rotation independent of filesystem timestamps (they change when a file is copied).
 *
 * Retention deletes files older than `retentionDays` but always keeps the newest one — an instance with a very
 * long downtime must not lose its last usable backup.
 *
 * A restore requires a **closed** database: the running instance holds the file open, so the swap is an
 * administrative step (stop the adapter, restore, start it again). `verify` refuses a file that is not a
 * readable, consistent database of this schema, so a restore never silently replaces data with garbage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { Db } from "../db/database";
import { writeAuditLog } from "../db/repositories/audit";
import { ValidationError } from "../errors";

/** Data sources of the backup service. */
export interface BackupDeps {
	/** Open database handle */
	db: Db;
	/** Directory the backups are written to (created when missing) */
	dir: string;
	/** File name prefix, default `zeiterfassung-` */
	prefix?: string;
	/** Days a backup is kept, default 30; `0` keeps only the newest one */
	retentionDays?: number;
	/** Instant source, defaults to the system clock */
	now?: () => number;
}

/** One backup file. */
export interface BackupFile {
	/** File name without directory */
	name: string;
	/** Absolute path */
	file: string;
	/** Size in bytes */
	sizeBytes: number;
	/** Instant from the name, UTC epoch seconds */
	createdAt: number;
}

/** A checked backup. */
export interface BackupInfo extends BackupFile {
	/** Schema version stored in the file */
	schemaVersion: number;
	/** Number of employees in the file */
	users: number;
	/** Number of punches in the file */
	entries: number;
}

/** Result of taking a backup. */
export interface CreateBackupResult {
	/** The created file */
	backup: BackupInfo;
	/** Names of the files the retention removed */
	removed: string[];
}

/** Result of a restore. */
export interface RestoreResult {
	/** The restored file */
	restored: BackupInfo;
	/** Path the previous database was moved to, `null` when there was none */
	previous: string | null;
}

/** The backup service. */
export interface BackupService {
	/** Takes a backup and applies the retention */
	create(input?: { actorId?: number | null; reason?: string }): CreateBackupResult;
	/** Known backups, newest first */
	list(): BackupFile[];
	/** Applies the retention and returns the removed file names */
	rotate(): string[];
	/** Checks a file: readable, consistent, expected schema */
	verify(file: string): BackupInfo;
	/** Replaces the database file with a backup (the database must be closed) */
	restore(file: string): RestoreResult;
}

/** Default prefix of the backup files. */
const DEFAULT_PREFIX = "zeiterfassung-";

/** Default retention in days. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Formats an instant the way it appears in a file name.
 *
 * @param tsUtc - UTC epoch seconds
 * @returns `YYYY-MM-DDTHH-MM-SS` in UTC
 */
function stamp(tsUtc: number): string {
	return new Date(tsUtc * 1000).toISOString().slice(0, 19).replace(/:/g, "-");
}

/**
 * Reads the instant out of a file name.
 *
 * @param name - file name
 * @param prefix - configured prefix
 * @returns UTC epoch seconds or `null` when the name does not belong to a backup
 */
function createdAtOf(name: string, prefix: string): number | null {
	if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) {
		return null;
	}
	// `2026-09-14T19-30-00` -> `2026-09-14T19:30:00Z`; only the time part uses dashes
	const raw = name.slice(prefix.length, -".sqlite".length);
	const iso = `${raw.slice(0, 11)}${raw.slice(11).replace(/-/g, ":")}Z`;
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/**
 * Creates the backup service.
 *
 * @param deps - database, directory and retention
 * @returns the service
 */
export function createBackupService(deps: BackupDeps): BackupService {
	const prefix = deps.prefix ?? DEFAULT_PREFIX;
	const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

	/**
	 * Lists the backup files of the directory.
	 *
	 * @returns files, newest first
	 */
	function list(): BackupFile[] {
		let names: string[];
		try {
			names = fs.readdirSync(deps.dir);
		} catch {
			// the directory does not exist yet: an instance without a backup has none
			return [];
		}

		const files: BackupFile[] = [];
		for (const name of names) {
			const createdAt = createdAtOf(name, prefix);
			if (createdAt === null) {
				continue;
			}
			const file = path.join(deps.dir, name);
			try {
				files.push({ name, file, sizeBytes: fs.statSync(file).size, createdAt });
			} catch {
				// a file that disappeared between listing and reading is not listed
			}
		}
		return files.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
	}

	/**
	 * Applies the retention.
	 *
	 * @returns names of the removed files
	 */
	function rotate(): string[] {
		const files = list();
		const removed: string[] = [];
		// the newest backup always stays, even when it is older than the retention
		for (const file of files.slice(1)) {
			const ageDays = (now() - file.createdAt) / 86_400;
			if (ageDays <= retentionDays) {
				continue;
			}
			try {
				fs.rmSync(file.file);
				removed.push(file.name);
			} catch {
				// a file that cannot be removed (locked, permissions) is kept
			}
		}
		return removed;
	}

	/**
	 * Checks a backup file.
	 *
	 * @param file - path of the file
	 * @returns information about the checked file
	 */
	function verify(file: string): BackupInfo {
		if (!fs.existsSync(file)) {
			throw new ValidationError(`backup ${path.basename(file)} does not exist`);
		}

		const sizeBytes = fs.statSync(file).size;
		let check: Database.Database;
		try {
			check = new Database(file, { readonly: true, fileMustExist: true });
		} catch (error) {
			throw new ValidationError(
				`backup ${path.basename(file)} is not a readable database (${(error as Error).message})`,
			);
		}

		const name = path.basename(file);
		try {
			// SQLite opens a file lazily, so a file that is not a database only fails on the first read
			const integrity = check.pragma("integrity_check", { simple: true });
			if (integrity !== "ok") {
				throw new ValidationError(`backup ${name} is damaged: ${String(integrity)}`);
			}
			const version = check
				.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
				.get() as { version: number } | undefined;
			if (!version) {
				throw new ValidationError(`backup ${name} has no schema information`);
			}
			const users = check.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
			const entries = check.prepare("SELECT COUNT(*) AS count FROM time_entries").get() as { count: number };

			return {
				name,
				file,
				sizeBytes,
				createdAt: createdAtOf(name, prefix) ?? Math.floor(Date.now() / 1000),
				schemaVersion: version.version,
				users: users.count,
				entries: entries.count,
			};
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
			const message = (error as Error).message;
			throw new ValidationError(
				/not a database|notadb/i.test(message)
					? `backup ${name} is not a readable database (${message})`
					: `backup ${name} is not a backup of this adapter (${message})`,
			);
		} finally {
			check.close();
		}
	}

	/**
	 * Takes a backup.
	 *
	 * @param input - who triggered it and why
	 * @param input.actorId - user id of the actor, `null` for the system
	 * @param input.reason - short reason stored in the audit trail
	 * @returns the created file and the files the retention removed
	 */
	function create(input: { actorId?: number | null; reason?: string } = {}): CreateBackupResult {
		fs.mkdirSync(deps.dir, { recursive: true });
		const timestamp = now();
		const name = `${prefix}${stamp(timestamp)}.sqlite`;
		const target = path.join(deps.dir, name);
		// a second backup within the same second replaces the first one instead of failing
		fs.rmSync(target, { force: true });
		const partial = `${target}.part`;

		try {
			// `VACUUM INTO` writes a consistent copy of the open database, so the adapter keeps working
			deps.db.prepare("VACUUM INTO ?").run(partial);
			fs.renameSync(partial, target);
		} catch (error) {
			fs.rmSync(partial, { force: true });
			throw error;
		}

		const backup = verify(target);
		writeAuditLog(deps.db, {
			actorId: input.actorId ?? null,
			action: "backup.create",
			entity: "backup",
			entityId: name,
			detail: {
				sizeBytes: backup.sizeBytes,
				schemaVersion: backup.schemaVersion,
				users: backup.users,
				entries: backup.entries,
				...(input.reason ? { reason: input.reason } : {}),
			},
			atUtc: timestamp,
		});

		const removed = rotate();
		if (removed.length > 0) {
			writeAuditLog(deps.db, {
				actorId: input.actorId ?? null,
				action: "backup.rotate",
				entity: "backup",
				detail: { removed },
				atUtc: timestamp,
			});
		}

		return { backup, removed };
	}

	/**
	 * Replaces the database file with a backup.
	 *
	 * The caller closes the database first and reopens it afterwards; a backup that does not pass `verify` never
	 * touches the database file, and the previous file is kept next to it.
	 *
	 * @param file - path of the backup
	 * @returns the restored file and the path the previous database was moved to
	 */
	function restore(file: string): RestoreResult {
		const restored = verify(file);
		if (deps.db.open) {
			throw new ValidationError("the database must be closed before it can be restored");
		}
		const target = deps.db.name;
		if (!target || target === ":memory:") {
			throw new ValidationError("an in-memory database cannot be restored");
		}

		// the journal of the old database would shadow the restored file
		for (const suffix of ["-wal", "-shm"]) {
			fs.rmSync(`${target}${suffix}`, { force: true });
		}

		const previous = fs.existsSync(target) ? `${target}.before-restore-${stamp(now())}` : null;
		if (previous) {
			fs.renameSync(target, previous);
		}
		fs.copyFileSync(file, target);
		return { restored, previous };
	}

	return { create, list, rotate, verify, restore };
}

/**
 * Records a completed restore in the audit trail.
 *
 * The database is closed while a backup is restored, so the entry can only be written afterwards — the caller
 * writes it right after reopening the restored file.
 *
 * @param db - reopened database handle
 * @param info - the restored backup
 * @param actorId - who restored it, `null` for the system
 * @param atUtc - instant of the restore, defaults to now
 * @returns id of the created audit row
 */
export function recordRestore(db: Db, info: BackupInfo, actorId: number | null, atUtc?: number): number {
	return writeAuditLog(db, {
		actorId,
		action: "backup.restore",
		entity: "backup",
		entityId: info.name,
		detail: {
			sizeBytes: info.sizeBytes,
			schemaVersion: info.schemaVersion,
			users: info.users,
			entries: info.entries,
		},
		atUtc,
	});
}
