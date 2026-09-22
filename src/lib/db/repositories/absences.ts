/**
 * Absence repository (`absence_types`, `absences`).
 *
 * An absence is a date range plus a day portion, so half days and multi-day absences share one
 * representation. The status separates requested (`planned`) from booked (`taken`) absences; the
 * vacation balance reports used and planned days separately.
 */

import type { Db } from "../database";
import { isDateString } from "../../util/time";
import { NotFoundError, ValidationError } from "../../errors";
import { diffFields, writeAuditLog } from "./audit";

/** Status of an absence: requested/planned or already taken. */
export type AbsenceStatus = "taken" | "planned";

/**
 * Approval of an absence: the employee requests, the administration decides.
 *
 * Independent of {@link AbsenceStatus}, which says whether the days are planned or already taken — a request can be
 * planned and still wait for its decision. Rows that exist before migration 21 count as `approved`, so nothing
 * changes for a running installation.
 */
export type AbsenceApproval = "requested" | "approved" | "rejected";

/**
 * True when an absence counts for the calculation.
 *
 * A row counts unless it is a request that still waits for its decision or a rejected one. Everything else is
 * effective — including rows that predate migration 21 and therefore carry no value at all.
 *
 * @param absence - the absence to check
 * @param absence.approval - approval of the absence, missing on rows that predate migration 21
 * @returns true when the days count
 */
export function isApproved(absence: { approval?: AbsenceApproval }): boolean {
	return absence.approval !== "requested" && absence.approval !== "rejected";
}

/** An absence type (global when `userId` is `null`, otherwise user specific). */
export interface AbsenceTypeRecord {
	/** Primary key */
	id: number;
	/** Owner, `null` for the global types */
	userId: number | null;
	/** Short code, e.g. `F` for vacation */
	code: string;
	/** Display name */
	name: string;
	/** True when the absence is paid */
	paid: boolean;
	/** Percentage of the working time credited (100 = fully credited) */
	factor: number;
	/** True for vacation, which reduces the vacation balance */
	reduceVacation: boolean;
	/** Inactive types are hidden but keep their history */
	isActive: boolean;
}

/** Input for creating or updating an absence type. */
export interface UpsertAbsenceTypeInput {
	/** Owner, `null` (default) for the global types */
	userId?: number | null;
	/** Short code, e.g. `F` for vacation */
	code: string;
	/** Display name */
	name: string;
	/** True when the absence is paid, defaults to `true` */
	paid?: boolean;
	/** Percentage of the working time credited (defaults to `100`) */
	factor?: number;
	/** True for vacation, which reduces the vacation balance, defaults to `false` */
	reduceVacation?: boolean;
	/** False hides the type but keeps its history, defaults to `true` */
	isActive?: boolean;
	/** Who creates or changes the type */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** An absence as stored in the database. */
export interface AbsenceRecord {
	/** Primary key */
	id: number;
	/** Employee the absence belongs to */
	userId: number;
	/** Absence type */
	typeId: number;
	/** First day, local date `YYYY-MM-DD` */
	dateFrom: string;
	/** Last day, local date `YYYY-MM-DD` */
	dateTo: string;
	/** Portion of each day (1 = whole day, 0.5 = half day) */
	dayPortion: number;
	/** Hours of a partial day absence, informational only */
	hours: number | null;
	/** Requested or already taken */
	status: AbsenceStatus;
	/** Approval of the administration: requested, approved or rejected */
	approval: AbsenceApproval;
	/** Instant of the decision, UTC epoch seconds (`null` while nobody decided) */
	decidedAt: number | null;
	/** Who decided about the request */
	decidedBy: number | null;
	/** Reason of the decision, shown to the employee */
	decisionNote: string | null;
	/** Free-form note */
	note: string | null;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
	/** Who created the absence */
	createdBy: number | null;
}

/** An absence together with its type (input for the calculation service). */
export interface AbsenceWithType extends AbsenceRecord {
	/** Short code of the type, e.g. `F` */
	typeCode: string;
	/** Display name of the type */
	typeName: string;
	/** True when the absence is paid */
	paid: boolean;
	/** Percentage of the working time credited */
	factor: number;
	/** True for vacation, which reduces the vacation balance */
	reduceVacation: boolean;
}

/** Input for creating an absence. */
export interface CreateAbsenceInput {
	/** Employee the absence belongs to */
	userId: number;
	/** Absence type by id (alternative to `typeCode`) */
	typeId?: number;
	/** Absence type by code, user specific types win over the global ones */
	typeCode?: string;
	/** First day, local date `YYYY-MM-DD` */
	dateFrom: string;
	/** Last day, defaults to `dateFrom` */
	dateTo?: string;
	/** Portion of each day, default 1 */
	dayPortion?: number;
	/** Hours of a partial day absence */
	hours?: number | null;
	/** Status, default `planned` (a request that still needs approval) */
	status?: AbsenceStatus;
	/** Approval, default `approved` (the administration enters dates, an employee requests them) */
	approval?: AbsenceApproval;
	/** Free-form note */
	note?: string | null;
	/** Who creates the absence */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of creation, defaults to now */
	now?: number;
}

/** Input for changing an absence. */
export interface UpdateAbsenceInput {
	/** Id of the changed absence */
	id: number;
	/** Fields to change */
	patch: {
		typeId?: number;
		typeCode?: string;
		dateFrom?: string;
		dateTo?: string;
		dayPortion?: number;
		hours?: number | null;
		note?: string | null;
	};
	/** Reason of the change (recorded in the audit trail) */
	reason?: string | null;
	/** Who performs the change */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Thrown when an absence type cannot be resolved. */
export class UnknownAbsenceTypeError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param reference - id or code that could not be resolved
	 */
	constructor(public readonly reference: string | number) {
		super(`unknown absence type "${reference}"`);
		this.name = "UnknownAbsenceTypeError";
	}
}

/** Absence storage operations. */
export interface AbsencesRepository {
	/** Absence types of a user, including the global ones */
	types(options?: { userId?: number | null; includeInactive?: boolean }): AbsenceTypeRecord[];
	/** Resolves a type by id or code, user specific types win over the global ones */
	findType(reference: number | string, userId?: number | null): AbsenceTypeRecord | null;
	/** Creates an absence type or updates the existing one with the same code */
	upsertType(input: UpsertAbsenceTypeInput): { type: AbsenceTypeRecord; created: boolean };
	/** Removes an absence type that no absence uses */
	removeType(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
	/** Reads an absence by id */
	findById(id: number): AbsenceRecord | null;
	/** Creates an absence and audits it */
	create(input: CreateAbsenceInput): AbsenceRecord;
	/** Changes an absence and audits the changed fields */
	update(input: UpdateAbsenceInput): AbsenceRecord;
	/** Moves an absence between `planned` and `taken` */
	setStatus(input: {
		id: number;
		status: AbsenceStatus;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): AbsenceRecord;
	/** Approves or rejects a request of an employee and audits the decision */
	setApproval(input: {
		id: number;
		approval: AbsenceApproval;
		note?: string | null;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): AbsenceRecord;
	/** Deletes an absence by id */
	remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
	/** Absences of one user within an optional period, sorted by start date */
	listByUser(userId: number, options?: { from?: string; to?: string; year?: number }): AbsenceRecord[];
	/** Absences overlapping a date, sorted by start date */
	forDate(userId: number, date: string): AbsenceRecord[];
	/** Absences overlapping a range, including their type information */
	withTypesInRange(userId: number, from: string, to: string): AbsenceWithType[];
	/** Absences of **all** employees overlapping a range — the overview of the administration */
	allInRange(from: string, to: string): AbsenceWithType[];
}

interface AbsenceTypeRow {
	id: number;
	user_id: number | null;
	code: string;
	name: string;
	paid: number;
	factor: number;
	reduce_vacation: number;
	is_active: number;
}

interface AbsenceRow {
	id: number;
	user_id: number;
	type_id: number;
	date_from: string;
	date_to: string;
	day_portion: number;
	hours: number | null;
	status: AbsenceStatus;
	approval: AbsenceApproval;
	decided_at: number | null;
	decided_by: number | null;
	decision_note: string | null;
	note: string | null;
	created_at: number;
	created_by: number | null;
}

interface AbsenceWithTypeRow extends AbsenceRow {
	type_code: string;
	type_name: string;
	type_paid: number;
	type_factor: number;
	type_reduce_vacation: number;
}

const TYPE_COLUMNS = "id, user_id, code, name, paid, factor, reduce_vacation, is_active";
const ABSENCE_COLUMNS = `id, user_id, type_id, date_from, date_to, day_portion, hours, status, approval, decided_at, decided_by, decision_note, note,
\tcreated_at, created_by`;

/** Field names of an absence that are compared for the audit trail. */
const AUDITED_FIELDS: (keyof AbsenceRecord)[] = ["typeId", "dateFrom", "dateTo", "dayPortion", "hours", "note"];

/**
 * Maps a database row to an absence type record.
 *
 * @param row - raw database row
 * @returns absence type record
 */
export function mapAbsenceTypeRow(row: AbsenceTypeRow): AbsenceTypeRecord {
	return {
		id: row.id,
		userId: row.user_id,
		code: row.code,
		name: row.name,
		paid: row.paid !== 0,
		factor: row.factor,
		reduceVacation: row.reduce_vacation !== 0,
		isActive: row.is_active !== 0,
	};
}

/**
 * Maps a database row to an absence record.
 *
 * @param row - raw database row
 * @returns absence record
 */
export function mapAbsenceRow(row: AbsenceRow): AbsenceRecord {
	return {
		id: row.id,
		userId: row.user_id,
		typeId: row.type_id,
		dateFrom: row.date_from,
		dateTo: row.date_to,
		dayPortion: row.day_portion,
		hours: row.hours,
		status: row.status,
		approval: row.approval,
		decidedAt: row.decided_at,
		decidedBy: row.decided_by,
		decisionNote: row.decision_note,
		note: row.note,
		createdAt: row.created_at,
		createdBy: row.created_by,
	};
}

/**
 * Checks and normalises a calendar date.
 *
 * @param value - date to validate
 * @param label - field name used in the error message
 * @returns the validated date
 */
function requireDate(value: string, label: string): string {
	const trimmed = value.trim();
	if (!isDateString(trimmed)) {
		throw new ValidationError(`${label} "${value}" is not a date (YYYY-MM-DD)`);
	}
	return trimmed;
}

/**
 * Validates the day portion of an absence.
 *
 * @param value - raw day portion
 * @returns the validated day portion
 */
function requireDayPortion(value: number): number {
	if (!Number.isFinite(value) || value <= 0 || value > 1) {
		throw new ValidationError(`dayPortion must be greater than 0 and at most 1 (got ${value})`);
	}
	return value;
}

/**
 * Creates the absence repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createAbsencesRepository(db: Db): AbsencesRepository {
	const selectTypeById = db.prepare(`SELECT ${TYPE_COLUMNS} FROM absence_types WHERE id = ?`);
	const selectTypeUserCode = db.prepare(`SELECT ${TYPE_COLUMNS} FROM absence_types WHERE code = ? AND user_id = ?`);
	const selectTypeGlobalCode = db.prepare(
		`SELECT ${TYPE_COLUMNS} FROM absence_types WHERE code = ? AND user_id IS NULL`,
	);
	const selectAbsenceById = db.prepare(`SELECT ${ABSENCE_COLUMNS} FROM absences WHERE id = ?`);
	const selectByUser = db.prepare(
		`SELECT ${ABSENCE_COLUMNS} FROM absences
		 WHERE user_id = ? AND date_to >= ? AND date_from <= ?
		 ORDER BY date_from, date_to, id`,
	);
	const selectWithTypes = db.prepare(
		`SELECT a.id, a.user_id, a.type_id, a.date_from, a.date_to, a.day_portion, a.hours, a.status, a.approval,
		        a.decided_at, a.decided_by, a.decision_note, a.note, a.created_at, a.created_by,
		        t.code AS type_code, t.name AS type_name, t.paid AS type_paid, t.factor AS type_factor,
		        t.reduce_vacation AS type_reduce_vacation
		 FROM absences a JOIN absence_types t ON t.id = a.type_id
		 WHERE a.user_id = ? AND a.date_to >= ? AND a.date_from <= ?
		 ORDER BY a.date_from, a.date_to, a.id`,
	);
	// the same list for the administration: every employee in one answer, so the overview needs one request
	const selectAllWithTypes = db.prepare(
		`SELECT a.id, a.user_id, a.type_id, a.date_from, a.date_to, a.day_portion, a.hours, a.status, a.approval,
		        a.decided_at, a.decided_by, a.decision_note, a.note, a.created_at, a.created_by,
		        t.code AS type_code, t.name AS type_name, t.paid AS type_paid, t.factor AS type_factor,
		        t.reduce_vacation AS type_reduce_vacation
		 FROM absences a JOIN absence_types t ON t.id = a.type_id
		 WHERE a.date_to >= ? AND a.date_from <= ?
		 ORDER BY a.date_from, a.date_to, a.user_id, a.id`,
	);
	const insertAbsence = db.prepare(
		`INSERT INTO absences
		 (user_id, type_id, date_from, date_to, day_portion, hours, status, approval, decided_at, decided_by,
		  decision_note, note, created_at, created_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateAbsence = db.prepare(
		`UPDATE absences SET type_id = ?, date_from = ?, date_to = ?, day_portion = ?, hours = ?, note = ?
		 WHERE id = ?`,
	);
	const updateStatusStatement = db.prepare("UPDATE absences SET status = ? WHERE id = ?");
	const updateApprovalStatement = db.prepare(
		"UPDATE absences SET approval = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?",
	);
	const deleteAbsence = db.prepare("DELETE FROM absences WHERE id = ?");
	const insertType = db.prepare(
		`INSERT INTO absence_types (user_id, code, name, paid, factor, reduce_vacation, is_active)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateType = db.prepare(
		`UPDATE absence_types SET name = ?, paid = ?, factor = ?, reduce_vacation = ?, is_active = ? WHERE id = ?`,
	);
	const deleteType = db.prepare("DELETE FROM absence_types WHERE id = ?");
	const countAbsencesOfType = db.prepare("SELECT COUNT(*) AS count FROM absences WHERE type_id = ?");

	const read = (id: number): AbsenceRecord | null => {
		const row = selectAbsenceById.get(id) as AbsenceRow | undefined;
		return row ? mapAbsenceRow(row) : null;
	};

	/**
	 * Resolves a type by id or code (user specific types win over the global ones).
	 *
	 * @param reference - id or code
	 * @param userId - owner used to prefer user specific types
	 * @returns type record or `null`
	 */
	const resolveType = (reference: number | string, userId?: number | null): AbsenceTypeRecord | null => {
		if (typeof reference === "number") {
			const row = selectTypeById.get(reference) as AbsenceTypeRow | undefined;
			return row ? mapAbsenceTypeRow(row) : null;
		}
		if (userId != null) {
			const own = selectTypeUserCode.get(reference, userId) as AbsenceTypeRow | undefined;
			if (own) {
				return mapAbsenceTypeRow(own);
			}
		}
		const global = selectTypeGlobalCode.get(reference) as AbsenceTypeRow | undefined;
		return global ? mapAbsenceTypeRow(global) : null;
	};

	/**
	 * Resolves a type or throws when it cannot be found.
	 *
	 * @param input - type reference and owner
	 * @param input.typeId - type id (alternative to `input.typeCode`)
	 * @param input.typeCode - type code (alternative to `input.typeId`)
	 * @param input.userId - owner used to prefer user specific types
	 * @returns resolved type
	 */
	const requireType = (input: { typeId?: number; typeCode?: string; userId: number }): AbsenceTypeRecord => {
		const reference = input.typeId ?? input.typeCode;
		if (reference === undefined) {
			throw new UnknownAbsenceTypeError("(none)");
		}
		const type = resolveType(reference, input.userId);
		if (!type) {
			throw new UnknownAbsenceTypeError(reference);
		}
		return type;
	};

	return {
		types(options?: { userId?: number | null; includeInactive?: boolean }): AbsenceTypeRecord[] {
			const activeOnly = options?.includeInactive === true ? "" : " AND is_active = 1";
			const userId = options?.userId ?? null;
			const rows = db
				.prepare(
					`SELECT ${TYPE_COLUMNS} FROM absence_types
					 WHERE (user_id IS NULL OR user_id = ?)${activeOnly}
					 ORDER BY code, id`,
				)
				.all(userId) as AbsenceTypeRow[];
			return rows.map(mapAbsenceTypeRow);
		},

		findType(reference: number | string, userId?: number | null): AbsenceTypeRecord | null {
			return resolveType(reference, userId);
		},

		upsertType(input: UpsertAbsenceTypeInput): { type: AbsenceTypeRecord; created: boolean } {
			const userId = input.userId ?? null;
			const code = input.code.trim().toUpperCase();
			if (!/^[A-Za-z0-9_-]{1,8}$/.test(code)) {
				throw new ValidationError(`code must be 1 to 8 letters, digits, "-" or "_" (got "${input.code}")`);
			}
			const name = input.name.trim();
			if (!name) {
				throw new ValidationError("name is required");
			}
			const factor = input.factor ?? 100;
			if (!Number.isInteger(factor) || factor < 0 || factor > 100) {
				throw new ValidationError(`factor must be a whole number between 0 and 100 (got ${input.factor})`);
			}
			const paid = input.paid ?? true;
			const reduceVacation = input.reduceVacation ?? false;
			const isActive = input.isActive ?? true;
			const now = input.now ?? Math.floor(Date.now() / 1000);

			const existing = resolveType(code, userId);
			let typeId = existing?.id ?? 0;

			const run = db.transaction((): void => {
				if (existing) {
					updateType.run(name, paid ? 1 : 0, factor, reduceVacation ? 1 : 0, isActive ? 1 : 0, existing.id);
				} else {
					const result = insertType.run(
						userId,
						code,
						name,
						paid ? 1 : 0,
						factor,
						reduceVacation ? 1 : 0,
						isActive ? 1 : 0,
					);
					typeId = Number(result.lastInsertRowid);
				}

				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					ip: input.actorIp ?? null,
					action: existing ? "absence_type.update" : "absence_type.create",
					entity: "absence_types",
					entityId: typeId,
					detail: { code, userId, name, paid, factor, reduceVacation, isActive },
				});
			});
			run();

			const type = existing
				? { ...existing, name, paid, factor, reduceVacation, isActive }
				: {
						id: typeId,
						userId,
						code,
						name,
						paid,
						factor,
						reduceVacation,
						isActive,
					};
			return { type, created: existing === null };
		},

		removeType(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const existing = resolveType(input.id);
			if (!existing) {
				return false;
			}
			// A type that absences use cannot go: they would lose their meaning (and the foreign key would refuse the
			// delete anyway). The caller turns this into a message the administration can act on.
			const used = (countAbsencesOfType.get(input.id) as { count: number }).count;
			if (used > 0) {
				throw new ValidationError(`absence type ${existing.code} is still used by ${used} absence(s)`);
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deleteType.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "absence.type.remove",
					entity: "absence_type",
					entityId: input.id,
					detail: { code: existing.code, name: existing.name },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},

		findById: read,

		create(input: CreateAbsenceInput): AbsenceRecord {
			const type = requireType(input);
			const dateFrom = requireDate(input.dateFrom, "dateFrom");
			const dateTo = requireDate(input.dateTo ?? dateFrom, "dateTo");
			if (dateFrom > dateTo) {
				throw new ValidationError(`dateFrom (${dateFrom}) must not be after dateTo (${dateTo})`);
			}
			const dayPortion = requireDayPortion(input.dayPortion ?? 1);
			const status: AbsenceStatus = input.status ?? "planned";
			// the administration enters dates straight away, a request of an employee waits for its decision
			const approval: AbsenceApproval = input.approval ?? "approved";
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const decidedAt = approval === "requested" ? null : now;
			const decidedBy = approval === "requested" ? null : input.actorId;

			let absenceId = 0;
			const run = db.transaction((): void => {
				const result = insertAbsence.run(
					input.userId,
					type.id,
					dateFrom,
					dateTo,
					dayPortion,
					input.hours ?? null,
					status,
					approval,
					decidedAt,
					decidedBy,
					null,
					input.note ?? null,
					now,
					input.actorId,
				);
				absenceId = Number(result.lastInsertRowid);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "absence.create",
					entity: "absence",
					entityId: absenceId,
					detail: {
						userId: input.userId,
						typeCode: type.code,
						dateFrom,
						dateTo,
						dayPortion,
						status,
					},
					ip: input.actorIp ?? null,
				});
			});
			run();

			const created = read(absenceId);
			if (!created) {
				throw new Error(`absence ${absenceId} disappeared right after creation`);
			}
			return created;
		},

		update(input: UpdateAbsenceInput): AbsenceRecord {
			const current = read(input.id);
			if (!current) {
				throw new NotFoundError(`absence ${input.id} not found`);
			}

			const type =
				input.patch.typeId === undefined && input.patch.typeCode === undefined
					? null
					: requireType({ ...input.patch, userId: current.userId });
			const next: AbsenceRecord = {
				...current,
				typeId: type?.id ?? current.typeId,
				dateFrom: input.patch.dateFrom ? requireDate(input.patch.dateFrom, "dateFrom") : current.dateFrom,
				dateTo: input.patch.dateTo ? requireDate(input.patch.dateTo, "dateTo") : current.dateTo,
				dayPortion:
					input.patch.dayPortion === undefined
						? current.dayPortion
						: requireDayPortion(input.patch.dayPortion),
				hours: input.patch.hours === undefined ? current.hours : input.patch.hours,
				note: input.patch.note === undefined ? current.note : input.patch.note,
			};
			if (next.dateFrom > next.dateTo) {
				throw new ValidationError(`dateFrom (${next.dateFrom}) must not be after dateTo (${next.dateTo})`);
			}

			const changes = diffFields(
				current as unknown as Record<string, unknown>,
				next as unknown as Record<string, unknown>,
				AUDITED_FIELDS as unknown as (keyof Record<string, unknown>)[],
			);
			if (Object.keys(changes).length === 0) {
				return current;
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				updateAbsence.run(
					next.typeId,
					next.dateFrom,
					next.dateTo,
					next.dayPortion,
					next.hours,
					next.note,
					input.id,
				);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "absence.update",
					entity: "absence",
					entityId: input.id,
					detail: { changes, reason: input.reason ?? null },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`absence ${input.id} disappeared right after the update`);
			}
			return updated;
		},

		setStatus(input: {
			id: number;
			status: AbsenceStatus;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): AbsenceRecord {
			const current = read(input.id);
			if (!current) {
				throw new NotFoundError(`absence ${input.id} not found`);
			}
			if (current.status === input.status) {
				return current;
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				updateStatusStatement.run(input.status, input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "absence.status",
					entity: "absence",
					entityId: input.id,
					detail: { changes: { status: { old: current.status, new: input.status } } },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`absence ${input.id} disappeared right after the status change`);
			}
			return updated;
		},

		setApproval(input: {
			id: number;
			approval: AbsenceApproval;
			note?: string | null;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): AbsenceRecord {
			const current = read(input.id);
			if (!current) {
				throw new NotFoundError(`absence ${input.id} not found`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);

			const run = db.transaction((): void => {
				updateApprovalStatement.run(input.approval, now, input.actorId, input.note ?? null, input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "absence.approval",
					entity: "absence",
					entityId: input.id,
					detail: {
						changes: { approval: { old: current.approval, new: input.approval } },
						...(input.note ? { note: input.note } : {}),
					},
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`absence ${input.id} disappeared right after the decision`);
			}
			return updated;
		},

		remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const current = read(input.id);
			if (!current) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);

			const run = db.transaction((): void => {
				deleteAbsence.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "absence.delete",
					entity: "absence",
					entityId: input.id,
					detail: {
						userId: current.userId,
						dateFrom: current.dateFrom,
						dateTo: current.dateTo,
						status: current.status,
					},
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},

		listByUser(userId: number, options?: { from?: string; to?: string; year?: number }): AbsenceRecord[] {
			const from = options?.from ?? (options?.year === undefined ? "0000-01-01" : `${options.year}-01-01`);
			const to = options?.to ?? (options?.year === undefined ? "9999-12-31" : `${options.year}-12-31`);
			const rows = selectByUser.all(userId, from, to) as AbsenceRow[];
			return rows.map(mapAbsenceRow);
		},

		forDate(userId: number, date: string): AbsenceRecord[] {
			const day = requireDate(date, "date");
			const rows = selectByUser.all(userId, day, day) as AbsenceRow[];
			return rows.map(mapAbsenceRow);
		},

		withTypesInRange(userId: number, from: string, to: string): AbsenceWithType[] {
			const rows = selectWithTypes.all(
				userId,
				requireDate(from, "from"),
				requireDate(to, "to"),
			) as AbsenceWithTypeRow[];
			return rows.map(row => ({
				...mapAbsenceRow(row),
				typeCode: row.type_code,
				typeName: row.type_name,
				paid: row.type_paid !== 0,
				factor: row.type_factor,
				reduceVacation: row.type_reduce_vacation !== 0,
			}));
		},

		allInRange(from: string, to: string): AbsenceWithType[] {
			const rows = selectAllWithTypes.all(
				requireDate(from, "from"),
				requireDate(to, "to"),
			) as AbsenceWithTypeRow[];
			return rows.map(row => ({
				...mapAbsenceRow(row),
				typeCode: row.type_code,
				typeName: row.type_name,
				paid: row.type_paid !== 0,
				factor: row.type_factor,
				reduceVacation: row.type_reduce_vacation !== 0,
			}));
		},
	};
}
