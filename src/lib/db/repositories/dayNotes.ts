/**
 * Day notes (`day_notes`): what an employee wants the administration to know about one day.
 *
 * An employee does not change punches; the day of a forgotten punch is corrected by the administration. What the
 * employee may do is leave a note like “forgot to clock in or out”. That message lives outside the punches, because
 * a day without a punch is exactly the case it is meant for. One note per employee and day: writing a second one
 * replaces the first, an empty text takes it back. The administration marks a note as handled and keeps it.
 */

import type { Db } from "../database";
import { isDateString } from "../../util/time";
import { NotFoundError, ValidationError } from "../../errors";
import { writeAuditLog } from "./audit";

/** Longest text a note may carry. */
export const MAX_DAY_NOTE_LENGTH = 500;

/** A note an employee left for one of his days. */
export interface DayNoteRecord {
	/** Primary key */
	id: number;
	/** Owner of the day */
	userId: number;
	/** Local date the note belongs to (`YYYY-MM-DD`) */
	localDate: string;
	/** Text of the note */
	note: string;
	/** Who wrote it */
	createdBy: number | null;
	/** Instant it was written, UTC epoch seconds */
	createdAt: number;
	/** Who changed it last */
	updatedBy: number | null;
	/** Instant of the last change, UTC epoch seconds */
	updatedAt: number;
	/** Instant the administration marked it as handled, `null` while it waits */
	handledAt: number | null;
	/** Who marked it as handled */
	handledBy: number | null;
}

/** Input for writing (or clearing) the note of one day. */
export interface SaveDayNoteInput {
	/** Owner of the day */
	userId: number;
	/** Local date the note belongs to */
	localDate: string;
	/** Text of the note; an empty text removes the stored note */
	note: string;
	/** Who writes it */
	actorId: number;
	/** Client IP address */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Input for marking a note as handled (or open again). */
export interface HandleDayNoteInput {
	/** Owner of the day */
	userId: number;
	/** Local date the note belongs to */
	localDate: string;
	/** True marks it as handled, false puts it back into the list of open notes */
	handled: boolean;
	/** Who decides */
	actorId: number;
	/** Client IP address */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Typed access to the day notes. */
export interface DayNotesRepository {
	/** Notes of one employee in a local date range (inclusive), oldest first */
	listByRange(userId: number, fromDate: string, toDate: string): DayNoteRecord[];
	/** Note of one day or `null` */
	find(userId: number, localDate: string): DayNoteRecord | null;
	/**
	 * Writes the note of one day.
	 *
	 * @param input - owner, day, text and actor
	 * @returns the stored note, `null` when an empty text removed it
	 */
	save(input: SaveDayNoteInput): DayNoteRecord | null;
	/**
	 * Marks a note as handled or open again.
	 *
	 * @param input - owner, day and decision
	 * @returns the updated note
	 */
	setHandled(input: HandleDayNoteInput): DayNoteRecord;
}

/** One row of `day_notes` as it is stored. */
interface DayNoteRow {
	id: number;
	user_id: number;
	local_date: string;
	note: string;
	created_by: number | null;
	created_at: number;
	updated_by: number | null;
	updated_at: number;
	handled_at: number | null;
	handled_by: number | null;
}

/**
 * Creates the repository of the day notes.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createDayNotesRepository(db: Db): DayNotesRepository {
	const COLUMNS = `id, user_id, local_date, note, created_by, created_at, updated_by, updated_at, handled_at,
		handled_by`;
	const selectByRange = db.prepare(
		`SELECT ${COLUMNS} FROM day_notes WHERE user_id = ? AND local_date BETWEEN ? AND ? ORDER BY local_date, id`,
	);
	const selectByDate = db.prepare(`SELECT ${COLUMNS} FROM day_notes WHERE user_id = ? AND local_date = ?`);
	const insert = db.prepare(
		`INSERT INTO day_notes (user_id, local_date, note, created_by, created_at, updated_by, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateText = db.prepare(`UPDATE day_notes SET note = ?, updated_by = ?, updated_at = ? WHERE id = ?`);
	const removeRow = db.prepare(`DELETE FROM day_notes WHERE id = ?`);
	const updateHandled = db.prepare(
		`UPDATE day_notes SET handled_at = ?, handled_by = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
	);

	/**
	 * Turns a stored row into the record the API returns.
	 *
	 * @param row - stored row
	 * @returns the record
	 */
	const mapRow = (row: DayNoteRow): DayNoteRecord => ({
		id: row.id,
		userId: row.user_id,
		localDate: row.local_date,
		note: row.note,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedBy: row.updated_by,
		updatedAt: row.updated_at,
		handledAt: row.handled_at,
		handledBy: row.handled_by,
	});

	/**
	 * Reads the note of one day.
	 *
	 * @param userId - owner of the day
	 * @param localDate - the day
	 * @returns the note or `null`
	 */
	const read = (userId: number, localDate: string): DayNoteRecord | null => {
		const row = selectByDate.get(userId, localDate) as DayNoteRow | undefined;
		return row ? mapRow(row) : null;
	};

	/**
	 * Checks the day a note belongs to.
	 *
	 * @param localDate - the day
	 */
	const requireDate = (localDate: string): void => {
		if (!isDateString(localDate)) {
			throw new ValidationError("localDate must be a date (YYYY-MM-DD)");
		}
	};

	return {
		listByRange(userId: number, fromDate: string, toDate: string): DayNoteRecord[] {
			const rows = selectByRange.all(userId, fromDate, toDate) as DayNoteRow[];
			return rows.map(mapRow);
		},

		find: read,

		save(input: SaveDayNoteInput): DayNoteRecord | null {
			requireDate(input.localDate);
			const note = input.note.trim();
			if (note.length > MAX_DAY_NOTE_LENGTH) {
				throw new ValidationError(
					`note must not be longer than ${MAX_DAY_NOTE_LENGTH} characters (got ${note.length})`,
				);
			}
			const atUtc = input.now ?? Math.floor(Date.now() / 1000);
			const existing = read(input.userId, input.localDate);

			// an empty text is how a note is taken back
			if (note === "") {
				if (!existing) {
					return null;
				}
				const run = db.transaction((): void => {
					removeRow.run(existing.id);
					writeAuditLog(db, {
						atUtc,
						actorId: input.actorId,
						action: "day_note.delete",
						entity: "day_notes",
						entityId: existing.id,
						detail: { userId: input.userId, localDate: input.localDate, note: existing.note },
						ip: input.actorIp ?? null,
					});
				});
				run();
				return null;
			}

			if (existing && existing.note === note) {
				return existing;
			}

			const run = db.transaction((): void => {
				if (existing) {
					updateText.run(note, input.actorId, atUtc, existing.id);
					writeAuditLog(db, {
						atUtc,
						actorId: input.actorId,
						action: "day_note.update",
						entity: "day_notes",
						entityId: existing.id,
						detail: {
							userId: input.userId,
							localDate: input.localDate,
							old: existing.note,
							new: note,
						},
						ip: input.actorIp ?? null,
					});
					return;
				}
				const result = insert.run(
					input.userId,
					input.localDate,
					note,
					input.actorId,
					atUtc,
					input.actorId,
					atUtc,
				);
				writeAuditLog(db, {
					atUtc,
					actorId: input.actorId,
					action: "day_note.create",
					entity: "day_notes",
					entityId: Number(result.lastInsertRowid),
					detail: { userId: input.userId, localDate: input.localDate, note },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return read(input.userId, input.localDate);
		},

		setHandled(input: HandleDayNoteInput): DayNoteRecord {
			requireDate(input.localDate);
			const existing = read(input.userId, input.localDate);
			if (!existing) {
				throw new NotFoundError(`day note of ${input.localDate} not found`);
			}
			const atUtc = input.now ?? Math.floor(Date.now() / 1000);
			const wanted = input.handled ? atUtc : null;
			if (existing.handledAt === wanted) {
				return existing;
			}

			const run = db.transaction((): void => {
				updateHandled.run(wanted, wanted === null ? null : input.actorId, input.actorId, atUtc, existing.id);
				writeAuditLog(db, {
					atUtc,
					actorId: input.actorId,
					action: "day_note.handled",
					entity: "day_notes",
					entityId: existing.id,
					detail: { userId: input.userId, localDate: input.localDate, handled: input.handled },
					ip: input.actorIp ?? null,
				});
			});
			run();

			return read(input.userId, input.localDate) ?? existing;
		},
	};
}
