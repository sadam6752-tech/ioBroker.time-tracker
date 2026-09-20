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
	/** File name prefix, default `time-tracker-` */
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
	/** Queues an uploaded backup for the next start (the file is checked before it is kept) */
	queueRestore(
		upload: Buffer,
		input?: { name?: string; actorId?: number | null; reason?: string },
	): PendingRestoreInfo;
	/** Queues one of the known backups for the next start */
	queueExistingBackup(name: string, input?: { actorId?: number | null; reason?: string }): PendingRestoreInfo;
	/** Deletes one of the known backups */
	remove(name: string, input?: { actorId?: number | null; reason?: string }): BackupFile;
	/** The restore that waits for the next start, `null` when there is none */
	pending(): PendingRestoreInfo | null;
}

/** Default prefix of the backup files. */
const DEFAULT_PREFIX = "time-tracker-";

/** Name of a backup that waits for the next start of the adapter. */
export const RESTORE_PENDING_FILE = "restore-pending.sqlite";

/** Sidecar of a pending restore: who queued it and what the file contains. */
export const RESTORE_PENDING_INFO = "restore-pending.json";

/** A restore that waits for the next adapter start. */
export interface PendingRestoreInfo {
	/** Name the uploader gave the file, used for the download */
	name: string;
	/** Who queued the restore, `null` for the system */
	actorId: number | null;
	/** Instant the restore was queued, UTC epoch seconds */
	queuedAt: number;
	/** Size in bytes */
	sizeBytes: number;
	/** Number of employees in the file */
	users: number;
	/** Number of punches in the file */
	entries: number;
}

/** Result of applying a queued restore at startup. */
export interface AppliedRestore {
	/** The file that became the database */
	restored: BackupInfo;
	/** Path the previous database was moved to, `null` when there was none */
	previous: string | null;
	/** Who queued it, `null` for the system */
	actorId: number | null;
}

/**
 * Checks a database file: readable, consistent and of this schema.
 *
 * The file is opened read-only, so a check never touches it. A file that is not a database, is damaged or comes
 * from a different schema is refused with a message that says why.
 *
 * @param file - path of the file
 * @param prefix - file name prefix, used to read the time from the name
 * @returns information about the checked file
 */
export function verifyBackupFile(file: string, prefix: string = DEFAULT_PREFIX): BackupInfo {
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
		const version = check.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
			{ version: number } | undefined;
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
 * Replaces a database file with a backup file.
 *
 * The caller closes the database first; a file that does not pass {@link verifyBackupFile} never touches the
 * database, and the previous file is kept next to it (`<database>.before-restore-<stamp>`).
 *
 * @param dbFile - path of the database
 * @param backupFile - path of the backup to apply
 * @param now - instant source, defaults to the system clock
 * @returns path the previous database was moved to, `null` when there was none
 */
export function swapDatabaseFile(
	dbFile: string,
	backupFile: string,
	now: () => number = () => Math.floor(Date.now() / 1000),
): string | null {
	if (!dbFile || dbFile === ":memory:") {
		throw new ValidationError("an in-memory database cannot be restored");
	}

	// the journal of the old database would shadow the restored file
	for (const suffix of ["-wal", "-shm"]) {
		fs.rmSync(`${dbFile}${suffix}`, { force: true });
	}

	const previous = fs.existsSync(dbFile) ? `${dbFile}.before-restore-${stamp(now())}` : null;
	if (previous) {
		fs.renameSync(dbFile, previous);
	}
	fs.copyFileSync(backupFile, dbFile);
	return previous;
}

/**
 * Path of a queued restore next to the database.
 *
 * @param dbFile - path of the database
 * @returns path of the queued backup file
 */
export function pendingRestorePath(dbFile: string): string {
	return path.join(path.dirname(dbFile), RESTORE_PENDING_FILE);
}

/**
 * Path of the sidecar that describes the queued restore.
 *
 * @param dbFile - path of the database
 * @returns path of the sidecar
 */
export function pendingRestoreInfoPath(dbFile: string): string {
	return path.join(path.dirname(dbFile), RESTORE_PENDING_INFO);
}

/**
 * Reads the queued restore, if there is one.
 *
 * A sidecar without the file (or the other way round) counts as nothing to do: an incomplete pair must not stop
 * the adapter from starting.
 *
 * @param dbFile - path of the database
 * @returns description of the queued restore or `null`
 */
export function readPendingRestore(dbFile: string): PendingRestoreInfo | null {
	const info = pendingRestoreInfoPath(dbFile);
	if (!fs.existsSync(info) || !fs.existsSync(pendingRestorePath(dbFile))) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(info, "utf8")) as PendingRestoreInfo;
	} catch {
		return null;
	}
}

/**
 * Applies a queued restore while the database is closed.
 *
 * This runs while the adapter starts: the file the administration uploaded becomes the database, the previous
 * file is kept next to it, and the queued files are removed afterwards. A file that fails the check is refused
 * and the queued files stay, so the administrator can hand in a working one.
 *
 * @param dbFile - path of the database
 * @param now - instant source, defaults to the system clock
 * @returns what was restored and who queued it, `null` when nothing was queued
 */
export function applyPendingRestore(
	dbFile: string,
	now: () => number = () => Math.floor(Date.now() / 1000),
): AppliedRestore | null {
	const pending = readPendingRestore(dbFile);
	if (!pending) {
		return null;
	}

	const file = pendingRestorePath(dbFile);
	const restored = verifyBackupFile(file);
	const previous = swapDatabaseFile(dbFile, file, now);
	// the queued files have done their job once the database carries their content
	fs.rmSync(file, { force: true });
	fs.rmSync(pendingRestoreInfoPath(dbFile), { force: true });
	return { restored, previous, actorId: pending.actorId };
}

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
		// the check lives next to the service: the adapter uses it while it starts, when no database is open
		return verifyBackupFile(file, prefix);
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
	 * Path of the database, refused when it lives only in memory.
	 *
	 * @returns path of the database file
	 */
	function databaseFile(): string {
		const target = deps.db.name;
		if (!target || target === ":memory:") {
			throw new ValidationError("an in-memory database cannot be restored");
		}
		return target;
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
		return { restored, previous: swapDatabaseFile(databaseFile(), file, now) };
	}

	/**
	 * Queues a file for the next start.
	 *
	 * The file is checked before it is queued: a file that is not a readable database of this schema is refused
	 * and removed, so a restart can never pick up garbage. The running database stays untouched — the swap happens
	 * while the adapter starts, when no connection holds the file open.
	 *
	 * @param source - path of the file to queue
	 * @param input - name for the overview and who queued it
	 * @param input.name - name for the overview, defaults to the name of the stored file
	 * @param input.actorId - user id of the actor, `null` for the system
	 * @param input.reason - short reason stored in the audit trail
	 * @returns the queued restore
	 */
	function queue(
		source: string | Buffer,
		input: { name?: string; actorId?: number | null; reason?: string },
	): PendingRestoreInfo {
		const dbFile = databaseFile();
		const pendingFile = pendingRestorePath(dbFile);
		fs.mkdirSync(path.dirname(pendingFile), { recursive: true });

		// The new file is checked before it replaces the queued one: a failed upload must not throw away a restore
		// that is already waiting, and a file that is not a backup must never be picked up at the next start.
		const staged = `${pendingFile}.part`;
		fs.rmSync(staged, { force: true });
		if (typeof source === "string") {
			fs.copyFileSync(source, staged);
		} else {
			fs.writeFileSync(staged, source);
		}

		let info: BackupInfo;
		try {
			info = verify(staged);
		} catch (error) {
			// the staged file is removed, the queued one stays untouched
			fs.rmSync(staged, { force: true });
			throw error;
		}
		fs.renameSync(staged, pendingFile);

		const queuedAt = now();
		// The name only labels the queued restore (it is shown and logged), it never becomes a path — but a name
		// full of slashes or line breaks has no business in a log line or in a header either.
		const label = (input.name ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
		const pending: PendingRestoreInfo = {
			name: label || info.name,
			actorId: input.actorId ?? null,
			queuedAt,
			sizeBytes: info.sizeBytes,
			users: info.users,
			entries: info.entries,
		};
		fs.writeFileSync(pendingRestoreInfoPath(dbFile), `${JSON.stringify(pending, null, "\t")}\n`, "utf8");
		writeAuditLog(deps.db, {
			actorId: pending.actorId,
			action: "backup.queue_restore",
			entity: "backup",
			entityId: pending.name,
			detail: {
				sizeBytes: pending.sizeBytes,
				users: pending.users,
				entries: pending.entries,
				...(input.reason ? { reason: input.reason } : {}),
			},
			atUtc: queuedAt,
		});
		return pending;
	}

	/**
	 * Queues an uploaded backup for the next start.
	 *
	 * @param upload - bytes of the uploaded file
	 * @param input - who uploaded it and what it should be called
	 * @param input.name - name for the download, defaults to the name of the stored file
	 * @param input.actorId - user id of the actor, `null` for the system
	 * @param input.reason - short reason stored in the audit trail
	 * @returns the queued restore
	 */
	function queueRestore(
		upload: Buffer,
		input: { name?: string; actorId?: number | null; reason?: string } = {},
	): PendingRestoreInfo {
		if (upload.length === 0) {
			throw new ValidationError("the uploaded file is empty");
		}
		// the bytes go straight to the staging path: a queued restore is not touched by a refused upload
		return queue(upload, input);
	}

	/**
	 * Queues one of the known backups for the next start.
	 *
	 * This is the way back for the everyday case: the administration picks a file from the list, the adapter
	 * applies it while it starts. Only files of the list are accepted, so a name from outside cannot reach the
	 * file system.
	 *
	 * @param name - file name as `list()` reports it
	 * @param input - who queued it and why
	 * @param input.actorId - user id of the actor, `null` for the system
	 * @param input.reason - short reason stored in the audit trail
	 * @returns the queued restore
	 */
	function queueExistingBackup(
		name: string,
		input: { actorId?: number | null; reason?: string } = {},
	): PendingRestoreInfo {
		const known = list().find(entry => entry.name === name);
		if (!known) {
			throw new ValidationError(`backup ${name} does not exist`);
		}
		return queue(known.file, { ...input, name });
	}

	/**
	 * Deletes one of the known backups.
	 *
	 * Only files of the list are deleted, so the requested name never reaches the file system on its own. The
	 * file that waits for the next start is none of them: that is not a backup but the pending restore.
	 *
	 * @param name - file name as `list()` reports it
	 * @param input - who removed it and why
	 * @param input.actorId - user id of the actor, `null` for the system
	 * @param input.reason - short reason stored in the audit trail
	 * @returns the removed file
	 */
	function remove(name: string, input: { actorId?: number | null; reason?: string } = {}): BackupFile {
		const known = list().find(entry => entry.name === name);
		if (!known) {
			throw new ValidationError(`backup ${name} does not exist`);
		}
		fs.rmSync(known.file, { force: true });
		writeAuditLog(deps.db, {
			actorId: input.actorId ?? null,
			action: "backup.remove",
			entity: "backup",
			entityId: known.name,
			detail: {
				sizeBytes: known.sizeBytes,
				...(input.reason ? { reason: input.reason } : {}),
			},
			atUtc: now(),
		});
		return known;
	}

	/**
	 * The restore that waits for the next start.
	 *
	 * A database that lives only in memory cannot be restored at all, so it reports nothing instead of failing:
	 * the list of backups stays readable.
	 *
	 * @returns the queued restore or `null`
	 */
	function pending(): PendingRestoreInfo | null {
		const target = deps.db.name;
		if (!target || target === ":memory:") {
			return null;
		}
		return readPendingRestore(target);
	}

	return { create, list, rotate, verify, restore, queueRestore, queueExistingBackup, remove, pending };
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
