/**
 * Payout repository (`payouts`).
 *
 * A payout records overtime that was paid out instead of being taken as time off. It is attached to a year
 * and optionally to a month: the aggregation service subtracts the payouts of a year from the overtime
 * balance. Positive minutes mean “paid out”, negative ones are corrections (e.g. a repayment).
 */

import type { Db } from "../database";
import { diffFields, writeAuditLog } from "./audit";

/** A payout as stored in the database. */
export interface PayoutRecord {
	/** Primary key */
	id: number;
	/** Employee the payout belongs to */
	userId: number;
	/** Four digit year the payout belongs to */
	year: number;
	/** Month (1 to 12) or `null` for a payout of the whole year */
	month: number | null;
	/** Paid out overtime in minutes */
	minutes: number;
	/** Paid amount in the currency of the instance, informational only */
	amount: number | null;
	/** Free-form note (e.g. the closing of a month) */
	note: string | null;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
	/** Who recorded the payout */
	createdBy: number | null;
}

/** Input for creating a payout. */
export interface CreatePayoutInput {
	/** Employee the payout belongs to */
	userId: number;
	/** Four digit year */
	year: number;
	/** Month (1 to 12) or `null` for the whole year */
	month?: number | null;
	/** Paid out overtime in minutes (negative values are corrections) */
	minutes: number;
	/** Paid amount, informational only */
	amount?: number | null;
	/** Free-form note */
	note?: string | null;
	/** Who records the payout */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of creation, defaults to now */
	now?: number;
}

/** Input for changing a payout. */
export interface UpdatePayoutInput {
	/** Id of the changed payout */
	id: number;
	/** Fields to change */
	patch: {
		minutes?: number;
		amount?: number | null;
		note?: string | null;
	};
	/** Who performs the change */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Payout storage operations. */
export interface PayoutsRepository {
	/** Payouts of a user, filtered by year and/or month, newest first */
	list(userId: number, options?: { year?: number; month?: number }): PayoutRecord[];
	/** Reads a payout by id */
	findById(id: number): PayoutRecord | null;
	/** Records a payout */
	create(input: CreatePayoutInput): PayoutRecord;
	/** Changes a payout and audits the changed fields */
	update(input: UpdatePayoutInput): PayoutRecord;
	/** Deletes a payout */
	remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
	/** Sum of the paid out minutes of a year (or of one month inside it) */
	sumMinutes(userId: number, year: number, month?: number): number;
}

interface PayoutRow {
	id: number;
	user_id: number;
	year: number;
	month: number | null;
	minutes: number;
	amount: number | null;
	note: string | null;
	created_at: number;
	created_by: number | null;
}

const COLUMNS = "id, user_id, year, month, minutes, amount, note, created_at, created_by";

/** Field names of a payout that are compared for the audit trail. */
const AUDITED_FIELDS: (keyof PayoutRecord)[] = ["minutes", "amount", "note"];

/**
 * Maps a database row to a payout record.
 *
 * @param row - raw database row
 * @returns payout record
 */
export function mapPayoutRow(row: PayoutRow): PayoutRecord {
	return {
		id: row.id,
		userId: row.user_id,
		year: row.year,
		month: row.month,
		minutes: row.minutes,
		amount: row.amount,
		note: row.note,
		createdAt: row.created_at,
		createdBy: row.created_by,
	};
}

/**
 * Validates the year of a payout.
 *
 * @param year - four digit year
 * @returns the validated year
 */
function requireYear(year: number): number {
	if (!Number.isInteger(year) || year < 2000 || year > 2100) {
		throw new Error(`year must be a four digit year between 2000 and 2100 (got ${year})`);
	}
	return year;
}

/**
 * Validates the month of a payout.
 *
 * @param month - month (1 to 12) or `null`
 * @returns the validated month
 */
function requireMonth(month: number | null): number | null {
	if (month === null) {
		return null;
	}
	if (!Number.isInteger(month) || month < 1 || month > 12) {
		throw new Error(`month must be between 1 and 12 or null (got ${month})`);
	}
	return month;
}

/**
 * Validates the paid out minutes.
 *
 * @param minutes - minutes to validate
 * @returns the validated minutes
 */
function requireMinutes(minutes: number): number {
	if (!Number.isInteger(minutes) || minutes === 0) {
		throw new Error(`minutes must be a whole number and not 0 (got ${minutes})`);
	}
	return minutes;
}

/**
 * Validates the paid amount.
 *
 * @param amount - amount to validate
 * @returns the validated amount
 */
function requireAmount(amount: number | null): number | null {
	if (amount === null) {
		return null;
	}
	if (!Number.isFinite(amount)) {
		throw new Error(`amount must be a number or null (got ${amount})`);
	}
	return amount;
}

/**
 * Creates the payout repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createPayoutsRepository(db: Db): PayoutsRepository {
	const selectById = db.prepare(`SELECT ${COLUMNS} FROM payouts WHERE id = ?`);
	const selectByUser = db.prepare(
		`SELECT ${COLUMNS} FROM payouts
		 WHERE user_id = ? AND (? IS NULL OR year = ?) AND (? IS NULL OR month = ?)
		 ORDER BY year DESC, COALESCE(month, 0) DESC, id DESC`,
	);
	const selectSum = db.prepare(
		`SELECT COALESCE(SUM(minutes), 0) AS minutes FROM payouts
		 WHERE user_id = ? AND year = ? AND (? IS NULL OR month = ?)`,
	);
	const insertPayout = db.prepare(
		`INSERT INTO payouts (user_id, year, month, minutes, amount, note, created_at, created_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updatePayout = db.prepare("UPDATE payouts SET minutes = ?, amount = ?, note = ? WHERE id = ?");
	const deletePayout = db.prepare("DELETE FROM payouts WHERE id = ?");

	const read = (id: number): PayoutRecord | null => {
		const row = selectById.get(id) as PayoutRow | undefined;
		return row ? mapPayoutRow(row) : null;
	};

	return {
		list(userId: number, options?: { year?: number; month?: number }): PayoutRecord[] {
			const year = options?.year ?? null;
			const month = options?.month ?? null;
			const rows = selectByUser.all(userId, year, year, month, month) as PayoutRow[];
			return rows.map(mapPayoutRow);
		},

		findById: read,

		create(input: CreatePayoutInput): PayoutRecord {
			const year = requireYear(input.year);
			const month = requireMonth(input.month ?? null);
			const minutes = requireMinutes(input.minutes);
			const amount = requireAmount(input.amount ?? null);
			const now = input.now ?? Math.floor(Date.now() / 1000);

			let payoutId = 0;
			const run = db.transaction((): void => {
				const result = insertPayout.run(
					input.userId,
					year,
					month,
					minutes,
					amount,
					input.note ?? null,
					now,
					input.actorId,
				);
				payoutId = Number(result.lastInsertRowid);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "payout.create",
					entity: "payout",
					entityId: payoutId,
					detail: { userId: input.userId, year, month, minutes, amount },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const created = read(payoutId);
			if (!created) {
				throw new Error(`payout ${payoutId} disappeared right after creation`);
			}
			return created;
		},

		update(input: UpdatePayoutInput): PayoutRecord {
			const current = read(input.id);
			if (!current) {
				throw new Error(`payout ${input.id} not found`);
			}

			const next: PayoutRecord = {
				...current,
				minutes: input.patch.minutes === undefined ? current.minutes : requireMinutes(input.patch.minutes),
				amount: input.patch.amount === undefined ? current.amount : requireAmount(input.patch.amount),
				note: input.patch.note === undefined ? current.note : input.patch.note,
			};
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
				updatePayout.run(next.minutes, next.amount, next.note, input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "payout.update",
					entity: "payout",
					entityId: input.id,
					detail: { changes },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`payout ${input.id} disappeared right after the update`);
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
				deletePayout.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "payout.delete",
					entity: "payout",
					entityId: input.id,
					detail: {
						userId: current.userId,
						year: current.year,
						month: current.month,
						minutes: current.minutes,
					},
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},

		sumMinutes(userId: number, year: number, month?: number): number {
			const value = month ?? null;
			const row = selectSum.get(userId, requireYear(year), value, value) as { minutes: number };
			return row.minutes;
		},
	};
}
