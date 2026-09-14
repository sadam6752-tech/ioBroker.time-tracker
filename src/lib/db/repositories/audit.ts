/**
 * Audit trail helpers: every change of a punch and every administrative action is recorded append-only.
 */

import type { Db } from "../database";

/** A single change of one field. */
export interface FieldChange {
	/** Value before the change */
	old: unknown;
	/** Value after the change */
	new: unknown;
}

/**
 * Compares the old and the new value of every field and collects the differences.
 *
 * @param before - record before the change
 * @param after - record after the change
 * @param fields - field names to compare
 * @returns changed fields, empty when nothing changed
 */
export function diffFields<T extends Record<string, unknown>>(
	before: T,
	after: T,
	fields: (keyof T)[],
): Record<string, FieldChange> {
	const changes: Record<string, FieldChange> = {};
	for (const field of fields) {
		if (before[field] !== after[field]) {
			changes[String(field)] = { old: before[field], new: after[field] };
		}
	}
	return changes;
}

/** Input for a generic audit log entry. */
export interface AuditLogInput {
	/** Actor user id, `null` for system actions (import, scheduled jobs) */
	actorId?: number | null;
	/** Short action key, e.g. `entry.update`, `settings.set` */
	action: string;
	/** Affected entity, e.g. `time_entry`, `user` */
	entity?: string | null;
	/** Id of the affected entity */
	entityId?: string | number | null;
	/** Free-form detail (serialised as JSON) */
	detail?: unknown;
	/** Client IP address */
	ip?: string | null;
	/** Instant of the action, defaults to now */
	atUtc?: number;
}

/** Input for a punch audit entry. */
export interface TimeEntryAuditInput {
	/** Punch id, `null` when the punch was deleted */
	entryId: number | null;
	/** Owner of the punch */
	userId: number;
	/** Kind of change */
	action: "create" | "update" | "delete";
	/** Changed fields (serialised as JSON) */
	changes?: Record<string, FieldChange> | null;
	/** Timestamp before the change */
	oldTsUtc?: number | null;
	/** Timestamp after the change */
	newTsUtc?: number | null;
	/** Revision after the change */
	revision?: number | null;
	/** Mandatory reason for administrative corrections */
	reason?: string | null;
	/** Who performed the change */
	actorId: number;
	/** Client IP address */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	atUtc?: number;
}

/**
 * Writes an entry to the generic audit log.
 *
 * @param db - open database handle
 * @param input - audit information
 * @returns id of the created audit row
 */
export function writeAuditLog(db: Db, input: AuditLogInput): number {
	const result = db
		.prepare(
			`INSERT INTO audit_log (at_utc, actor_id, action, entity, entity_id, detail, ip)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.atUtc ?? Math.floor(Date.now() / 1000),
			input.actorId ?? null,
			input.action,
			input.entity ?? null,
			input.entityId == null ? null : String(input.entityId),
			input.detail === undefined ? null : JSON.stringify(input.detail),
			input.ip ?? null,
		);
	return Number(result.lastInsertRowid);
}

/**
 * Writes an entry to the punch audit trail (append-only).
 *
 * @param db - open database handle
 * @param input - punch audit information
 * @returns id of the created audit row
 */
export function writeTimeEntryAudit(db: Db, input: TimeEntryAuditInput): number {
	const result = db
		.prepare(
			`INSERT INTO time_entry_audit
			 (entry_id, user_id, action, changes, old_ts_utc, new_ts_utc, revision, reason, actor_id, actor_ip, at_utc)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.entryId,
			input.userId,
			input.action,
			input.changes ? JSON.stringify(input.changes) : null,
			input.oldTsUtc ?? null,
			input.newTsUtc ?? null,
			input.revision ?? null,
			input.reason ?? null,
			input.actorId,
			input.actorIp ?? null,
			input.atUtc ?? Math.floor(Date.now() / 1000),
		);
	return Number(result.lastInsertRowid);
}

/**
 * Reads the audit trail of one punch (newest first).
 *
 * @param db - open database handle
 * @param entryId - punch id
 * @returns audit rows with parsed `changes`
 */
export function readTimeEntryAudit(
	db: Db,
	entryId: number,
): {
	id: number;
	action: string;
	changes: Record<string, FieldChange> | null;
	revision: number | null;
	reason: string | null;
	actorId: number;
	atUtc: number;
}[] {
	const rows = db
		.prepare(
			`SELECT id, action, changes, revision, reason, actor_id AS actorId, at_utc AS atUtc
			 FROM time_entry_audit WHERE entry_id = ? ORDER BY id DESC`,
		)
		.all(entryId) as {
		id: number;
		action: string;
		changes: string | null;
		revision: number | null;
		reason: string | null;
		actorId: number;
		atUtc: number;
	}[];

	return rows.map(row => ({
		...row,
		changes: row.changes ? (JSON.parse(row.changes) as Record<string, FieldChange>) : null,
	}));
}
