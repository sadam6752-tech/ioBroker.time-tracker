/**
 * Punch repository (`time_entries`): idempotent inserts, optimistic locking and audit trail.
 *
 * All writes go through a transaction together with their audit entry, so no punch change is ever
 * recorded without a trace.
 */

import type { Db } from "../database";
import type { PunchEntry } from "../../domain/punch";
import { utcToWallTime, localDate as resolveLocalDate } from "../../util/time";
import { NotFoundError } from "../../errors";
import { writeAuditLog, writeTimeEntryAudit, type FieldChange } from "./audit";

/** Origin of a punch. */
export type EntrySource = "web" | "nfc" | "terminal" | "api" | "admin" | "import";
/** Synchronisation state of a punch. */
export type EntrySyncState = "synced" | "pending" | "conflict";
/** Stored direction hint (the pairing order stays authoritative). */
export type EntryDirection = "in" | "out" | "auto";

/** A punch as stored in the database. */
export interface EntryRecord {
	/** Primary key */
	id: number;
	/** Owner of the punch */
	userId: number;
	/** Punch instant, UTC epoch seconds (authoritative) */
	tsUtc: number;
	/** Instant reported by the client (offline punches), informational only */
	clientTsUtc: number | null;
	/** Wall clock time of the user at the punch instant (derived cache) */
	tsLocal: number;
	/** Local date of the user at the punch instant (derived cache) */
	localDate: string;
	/** Direction hint for the UI (the pairing order stays authoritative) */
	direction: EntryDirection;
	/** Origin of the punch */
	source: EntrySource;
	/** Idempotency key of the client (offline queue, import) */
	idempotencyKey: string | null;
	/** Synchronisation state */
	syncState: EntrySyncState;
	/** Revision counter for optimistic locking */
	revision: number;
	/** Free-form note of the employee or the administrator */
	note: string | null;
}

/** Input for creating a punch. */
export interface CreateEntryInput {
	/** Owner of the punch */
	userId: number;
	/** Punch instant, UTC epoch seconds */
	tsUtc: number;
	/** Client supplied instant (offline punches), informational only */
	clientTsUtc?: number | null;
	/** Time zone used to derive the local cache fields */
	timeZone: string;
	/** Origin, default `web` */
	source?: EntrySource;
	/** Direction hint, default `auto` */
	direction?: EntryDirection;
	/** Idempotency key (offline queue, import) */
	idempotencyKey?: string | null;
	/** Synchronisation state, default `synced` */
	syncState?: EntrySyncState;
	/** Free-form note */
	note?: string | null;
	/** Reason of an administrative correction (audit trail) */
	reason?: string | null;
	/** Actor creating the punch (for administrative creation) */
	actorId?: number | null;
	/** Actor IP address */
	actorIp?: string | null;
	/** Instant of creation, defaults to now */
	now?: number;
}

/** Input for updating a punch (optimistic locking). */
export interface UpdateEntryInput {
	/** Id of the changed punch */
	id: number;
	/** Revision the caller has read */
	expectedRevision: number;
	/** Fields to change */
	patch: {
		tsUtc?: number;
		note?: string | null;
		source?: EntrySource;
		userId?: number;
	};
	/** Mandatory reason for administrative corrections */
	reason?: string | null;
	/** Who performs the change */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Time zone used to recompute the local cache fields */
	timeZone: string;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Thrown when a punch was modified by someone else in the meantime. */
export class RevisionConflictError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param entryId - id of the conflicting punch
	 * @param current - record as stored in the database
	 */
	constructor(
		public readonly entryId: number,
		public readonly current: EntryRecord,
	) {
		super(`entry ${entryId} was modified by someone else (current revision ${current.revision})`);
		this.name = "RevisionConflictError";
	}
}

/** Punch storage operations. */
export interface EntriesRepository {
	/** Creates a punch; repeated calls with the same idempotency key return the existing punch */
	insert(input: CreateEntryInput): { entry: EntryRecord; created: boolean };
	/** Reads a punch by id */
	findById(id: number): EntryRecord | null;
	/** Punches of one user within a local date range (inclusive) */
	listByRange(userId: number, fromDate: string, toDate: string): EntryRecord[];
	/** Punches of one user on one local date */
	listByDate(userId: number, localDate: string): EntryRecord[];
	/** Changes a punch; throws `RevisionConflictError` when the revision does not match */
	update(input: UpdateEntryInput): EntryRecord;
	/** Punches of one user with a given synchronisation state (newest first) */
	listBySyncState(userId: number, syncState: EntrySyncState): EntryRecord[];
	/** Punch that was stored with the given idempotency key, `null` when unknown */
	findByIdempotencyKey(userId: number, idempotencyKey: string): EntryRecord | null;
	/** Moves a punch into another synchronisation state (resolving offline conflicts) */
	setSyncState(input: {
		id: number;
		syncState: EntrySyncState;
		actorId: number;
		reason?: string | null;
		actorIp?: string | null;
		now?: number;
	}): EntryRecord;
	/** Deletes a punch and records the deletion in the audit trail */
	remove(input: {
		id: number;
		actorId: number;
		reason?: string | null;
		actorIp?: string | null;
		now?: number;
	}): boolean;
}

interface EntryRow {
	id: number;
	user_id: number;
	ts_utc: number;
	client_ts_utc: number | null;
	ts_local: number;
	local_date: string;
	direction: EntryDirection;
	source: EntrySource;
	idempotency_key: string | null;
	sync_state: EntrySyncState;
	revision: number;
	note: string | null;
}

/**
 * Maps a database row to a domain record.
 *
 * @param row - raw database row
 * @returns punch record
 */
export function mapEntryRow(row: EntryRow): EntryRecord {
	return {
		id: row.id,
		userId: row.user_id,
		tsUtc: row.ts_utc,
		clientTsUtc: row.client_ts_utc,
		tsLocal: row.ts_local,
		localDate: row.local_date,
		direction: row.direction,
		source: row.source,
		idempotencyKey: row.idempotency_key,
		syncState: row.sync_state,
		revision: row.revision,
		note: row.note,
	};
}

/**
 * Converts stored punches into pairing input.
 *
 * @param records - punch records
 * @returns minimal punch information for `buildDayPunches`
 */
export function toPunchEntries(records: EntryRecord[]): PunchEntry[] {
	return records.map(record => ({ id: record.id, tsUtc: record.tsUtc, syncState: record.syncState }));
}

const COLUMNS = `id, user_id, ts_utc, client_ts_utc, ts_local, local_date, direction, source,
	idempotency_key, sync_state, revision, note`;

/**
 * Creates the punch repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createEntriesRepository(db: Db): EntriesRepository {
	const selectById = db.prepare(`SELECT ${COLUMNS} FROM time_entries WHERE id = ?`);
	const selectByIdempotency = db.prepare(
		`SELECT ${COLUMNS} FROM time_entries WHERE user_id = ? AND idempotency_key = ?`,
	);
	const selectByRange = db.prepare(
		`SELECT ${COLUMNS} FROM time_entries
		 WHERE user_id = ? AND local_date >= ? AND local_date <= ?
		 ORDER BY ts_utc, id`,
	);
	const selectByDate = db.prepare(
		`SELECT ${COLUMNS} FROM time_entries WHERE user_id = ? AND local_date = ? ORDER BY ts_utc, id`,
	);
	const selectBySyncState = db.prepare(
		`SELECT ${COLUMNS} FROM time_entries WHERE user_id = ? AND sync_state = ? ORDER BY ts_utc DESC, id DESC`,
	);
	const insertRow = db.prepare(
		`INSERT INTO time_entries
		 (user_id, ts_utc, client_ts_utc, ts_local, local_date, direction, source, idempotency_key,
		  sync_state, revision, note, created_by, created_at, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
	);
	const updateRow = db.prepare(
		`UPDATE time_entries
		 SET ts_utc = ?, ts_local = ?, local_date = ?, note = ?, source = ?, user_id = ?,
		     revision = revision + 1, updated_at = ?, updated_by = ?
		 WHERE id = ? AND revision = ?`,
	);
	const deleteRow = db.prepare("DELETE FROM time_entries WHERE id = ?");
	const updateSyncState = db.prepare(
		"UPDATE time_entries SET sync_state = ?, updated_at = ?, updated_by = ? WHERE id = ?",
	);

	const read = (id: number): EntryRecord | null => {
		const row = selectById.get(id) as EntryRow | undefined;
		return row ? mapEntryRow(row) : null;
	};

	return {
		insert(input: CreateEntryInput): { entry: EntryRecord; created: boolean } {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const idempotencyKey = input.idempotencyKey ?? null;

			if (idempotencyKey) {
				const existing = selectByIdempotency.get(input.userId, idempotencyKey) as EntryRow | undefined;
				if (existing) {
					return { entry: mapEntryRow(existing), created: false };
				}
			}

			const record = {
				userId: input.userId,
				tsUtc: input.tsUtc,
				clientTsUtc: input.clientTsUtc ?? null,
				tsLocal: utcToWallTime(input.tsUtc, input.timeZone),
				localDate: resolveLocalDate(input.tsUtc, input.timeZone),
				direction: input.direction ?? "auto",
				source: input.source ?? "web",
				idempotencyKey,
				syncState: input.syncState ?? "synced",
				note: input.note ?? null,
			};

			let entryId = 0;
			const run = db.transaction((): void => {
				const result = insertRow.run(
					record.userId,
					record.tsUtc,
					record.clientTsUtc,
					record.tsLocal,
					record.localDate,
					record.direction,
					record.source,
					record.idempotencyKey,
					record.syncState,
					record.note,
					input.actorId ?? null,
					now,
					now,
					input.actorId ?? null,
				);
				entryId = Number(result.lastInsertRowid);
				writeTimeEntryAudit(db, {
					entryId,
					userId: record.userId,
					action: "create",
					changes: {
						tsUtc: { old: null, new: record.tsUtc },
						source: { old: null, new: record.source },
					},
					newTsUtc: record.tsUtc,
					revision: 1,
					reason: input.reason ?? null,
					actorId: input.actorId ?? record.userId,
					actorIp: input.actorIp ?? null,
					atUtc: now,
				});
			});
			run();

			const created = read(entryId);
			if (!created) {
				throw new Error(`entry ${entryId} disappeared right after creation`);
			}
			return { entry: created, created: true };
		},

		findById: read,

		listByRange(userId: number, fromDate: string, toDate: string): EntryRecord[] {
			const rows = selectByRange.all(userId, fromDate, toDate) as EntryRow[];
			return rows.map(mapEntryRow);
		},

		listByDate(userId: number, localDate: string): EntryRecord[] {
			const rows = selectByDate.all(userId, localDate) as EntryRow[];
			return rows.map(mapEntryRow);
		},

		listBySyncState(userId: number, syncState: EntrySyncState): EntryRecord[] {
			const rows = selectBySyncState.all(userId, syncState) as EntryRow[];
			return rows.map(mapEntryRow);
		},

		findByIdempotencyKey(userId: number, idempotencyKey: string): EntryRecord | null {
			const row = selectByIdempotency.get(userId, idempotencyKey) as EntryRow | undefined;
			return row ? mapEntryRow(row) : null;
		},

		setSyncState(input: {
			id: number;
			syncState: EntrySyncState;
			actorId: number;
			reason?: string | null;
			actorIp?: string | null;
			now?: number;
		}): EntryRecord {
			const current = read(input.id);
			if (!current) {
				throw new NotFoundError(`entry ${input.id} not found`);
			}
			if (current.syncState === input.syncState) {
				return current;
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				updateSyncState.run(input.syncState, now, input.actorId, input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "entry.sync_state",
					entity: "time_entry",
					entityId: input.id,
					detail: {
						changes: { syncState: { old: current.syncState, new: input.syncState } },
						reason: input.reason ?? null,
					},
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`entry ${input.id} disappeared right after the sync state change`);
			}
			return updated;
		},

		update(input: UpdateEntryInput): EntryRecord {
			const current = read(input.id);
			if (!current) {
				throw new NotFoundError(`entry ${input.id} not found`);
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const nextTsUtc = input.patch.tsUtc ?? current.tsUtc;
			const nextUserId = input.patch.userId ?? current.userId;
			const nextNote = input.patch.note === undefined ? current.note : input.patch.note;
			const nextSource = input.patch.source ?? current.source;

			const changes: Record<string, FieldChange> = {};
			if (nextTsUtc !== current.tsUtc) {
				changes.tsUtc = { old: current.tsUtc, new: nextTsUtc };
			}
			if (nextUserId !== current.userId) {
				changes.userId = { old: current.userId, new: nextUserId };
			}
			if (nextNote !== current.note) {
				changes.note = { old: current.note, new: nextNote };
			}
			if (nextSource !== current.source) {
				changes.source = { old: current.source, new: nextSource };
			}
			if (Object.keys(changes).length === 0) {
				// nothing to do, keep the revision untouched
				return current;
			}

			const run = db.transaction((): void => {
				const result = updateRow.run(
					nextTsUtc,
					utcToWallTime(nextTsUtc, input.timeZone),
					resolveLocalDate(nextTsUtc, input.timeZone),
					nextNote,
					nextSource,
					nextUserId,
					now,
					input.actorId,
					input.id,
					input.expectedRevision,
				);
				if (result.changes === 0) {
					throw new RevisionConflictError(input.id, read(input.id) ?? current);
				}

				writeTimeEntryAudit(db, {
					entryId: input.id,
					userId: current.userId,
					action: "update",
					changes,
					oldTsUtc: current.tsUtc,
					newTsUtc: nextTsUtc,
					revision: input.expectedRevision + 1,
					reason: input.reason ?? null,
					actorId: input.actorId,
					actorIp: input.actorIp ?? null,
					atUtc: now,
				});
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "entry.update",
					entity: "time_entry",
					entityId: input.id,
					detail: { changes, reason: input.reason ?? null },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`entry ${input.id} not found after update`);
			}
			return updated;
		},

		remove(input: {
			id: number;
			actorId: number;
			reason?: string | null;
			actorIp?: string | null;
			now?: number;
		}): boolean {
			const current = read(input.id);
			if (!current) {
				return false;
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deleteRow.run(input.id);
				writeTimeEntryAudit(db, {
					entryId: input.id,
					userId: current.userId,
					action: "delete",
					changes: { tsUtc: { old: current.tsUtc, new: null } },
					oldTsUtc: current.tsUtc,
					revision: current.revision + 1,
					reason: input.reason ?? null,
					actorId: input.actorId,
					actorIp: input.actorIp ?? null,
					atUtc: now,
				});
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "entry.delete",
					entity: "time_entry",
					entityId: input.id,
					detail: { tsUtc: current.tsUtc, reason: input.reason ?? null },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},
	};
}
