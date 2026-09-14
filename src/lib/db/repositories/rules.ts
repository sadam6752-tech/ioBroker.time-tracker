/**
 * Rule repository (`pause_rules`, `shift_rules`).
 *
 * Rules exist globally (`user_id IS NULL`) or for a single employee. For the break rules the user specific
 * rule replaces the global rule with the same `fromMin`, so an employee can deviate from the company
 * default. Shift rules describe surcharges per weekday and time window; they are pure master data for the
 * reports (they never change the balance).
 */

import type { Db } from "../database";
import { NotFoundError, ValidationError } from "../../errors";
import { diffFields, writeAuditLog } from "./audit";

/** A graduated break rule. */
export interface PauseRuleRecord {
	/** Primary key */
	id: number;
	/** Owner, `null` for the company default */
	userId: number | null;
	/** Rule applies from this pair duration in minutes (inclusive) */
	fromMin: number;
	/** Rule applies below this pair duration in minutes (exclusive), `null` = open end */
	toMin: number | null;
	/** Minutes deducted from the pair */
	pauseMin: number;
	/** Inactive rules are ignored but keep their history */
	isActive: boolean;
}

/** A surcharge rule for a shift window. */
export interface ShiftRuleRecord {
	/** Primary key */
	id: number;
	/** Owner, `null` for the company default */
	userId: number | null;
	/** Weekday the rule applies to (0 = Sunday), `null` = every day */
	dayOfWeek: number | null;
	/** Start of the window in minutes since midnight, `null` = open start */
	fromMin: number | null;
	/** End of the window in minutes since midnight, `null` = open end */
	toMin: number | null;
	/** Surcharge in percent */
	surcharge: number;
	/** Inactive rules are ignored but keep their history */
	isActive: boolean;
}

/** Input for creating or changing a break rule. */
export interface SavePauseRuleInput {
	/** Id of an existing rule, omitted when a new rule is created */
	id?: number;
	/** Owner, `null` for the company default */
	userId?: number | null;
	/** Rule applies from this pair duration in minutes (inclusive) */
	fromMin: number;
	/** Rule applies below this pair duration in minutes (exclusive) */
	toMin?: number | null;
	/** Minutes deducted from the pair */
	pauseMin: number;
	/** `false` disables the rule without deleting it */
	isActive?: boolean;
	/** Who changes the rule */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Input for creating or changing a surcharge rule. */
export interface SaveShiftRuleInput {
	/** Id of an existing rule, omitted when a new rule is created */
	id?: number;
	/** Owner, `null` for the company default */
	userId?: number | null;
	/** Weekday (0 = Sunday), `null` for every day */
	dayOfWeek?: number | null;
	/** Start of the window in minutes since midnight */
	fromMin?: number | null;
	/** End of the window in minutes since midnight */
	toMin?: number | null;
	/** Surcharge in percent */
	surcharge: number;
	/** `false` disables the rule without deleting it */
	isActive?: boolean;
	/** Who changes the rule */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Rule storage operations. */
export interface RulesRepository {
	/** Effective break rules for an employee (user specific rules win), sorted by `fromMin` */
	pauseRules(userId?: number | null, options?: { includeInactive?: boolean }): PauseRuleRecord[];
	/** All break rules of one scope without merging */
	listPauseRules(input?: { userId?: number | null; includeInactive?: boolean }): PauseRuleRecord[];
	/** Creates or updates a break rule */
	savePauseRule(input: SavePauseRuleInput): PauseRuleRecord;
	/** Deletes a break rule */
	removePauseRule(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
	/** Effective surcharge rules for an employee */
	shiftRules(userId?: number | null, options?: { includeInactive?: boolean }): ShiftRuleRecord[];
	/** Creates or updates a surcharge rule */
	saveShiftRule(input: SaveShiftRuleInput): ShiftRuleRecord;
	/** Deletes a surcharge rule */
	removeShiftRule(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
}

interface PauseRuleRow {
	id: number;
	user_id: number | null;
	from_min: number;
	to_min: number | null;
	pause_min: number;
	is_active: number;
}

interface ShiftRuleRow {
	id: number;
	user_id: number | null;
	day_of_week: number | null;
	from_min: number | null;
	to_min: number | null;
	surcharge: number;
	is_active: number;
}

const PAUSE_COLUMNS = "id, user_id, from_min, to_min, pause_min, is_active";
const SHIFT_COLUMNS = "id, user_id, day_of_week, from_min, to_min, surcharge, is_active";

/** Field names of a break rule that are compared for the audit trail. */
const AUDITED_PAUSE_FIELDS: (keyof PauseRuleRecord)[] = ["userId", "fromMin", "toMin", "pauseMin", "isActive"];

/** Field names of a surcharge rule that are compared for the audit trail. */
const AUDITED_SHIFT_FIELDS: (keyof ShiftRuleRecord)[] = [
	"userId",
	"dayOfWeek",
	"fromMin",
	"toMin",
	"surcharge",
	"isActive",
];

/**
 * Maps a database row to a break rule record.
 *
 * @param row - raw database row
 * @returns break rule record
 */
export function mapPauseRuleRow(row: PauseRuleRow): PauseRuleRecord {
	return {
		id: row.id,
		userId: row.user_id,
		fromMin: row.from_min,
		toMin: row.to_min,
		pauseMin: row.pause_min,
		isActive: row.is_active !== 0,
	};
}

/**
 * Maps a database row to a surcharge rule record.
 *
 * @param row - raw database row
 * @returns surcharge rule record
 */
export function mapShiftRuleRow(row: ShiftRuleRow): ShiftRuleRecord {
	return {
		id: row.id,
		userId: row.user_id,
		dayOfWeek: row.day_of_week,
		fromMin: row.from_min,
		toMin: row.to_min,
		surcharge: row.surcharge,
		isActive: row.is_active !== 0,
	};
}

/**
 * Validates the duration window of a break rule.
 *
 * @param fromMin - lower bound in minutes
 * @param toMin - upper bound in minutes or `null`
 * @returns the validated values
 */
function requirePauseWindow(fromMin: number, toMin: number | null): { fromMin: number; toMin: number | null } {
	if (!Number.isInteger(fromMin) || fromMin < 0) {
		throw new ValidationError(`fromMin must be a whole number of minutes, 0 or more (got ${fromMin})`);
	}
	if (toMin !== null) {
		if (!Number.isInteger(toMin) || toMin <= fromMin) {
			throw new ValidationError(`toMin must be greater than fromMin (got ${toMin} and ${fromMin})`);
		}
	}
	return { fromMin, toMin };
}

/**
 * Validates the window of a surcharge rule.
 *
 * @param fromMin - start of the window in minutes or `null`
 * @param toMin - end of the window in minutes or `null`
 * @returns the validated values
 */
function requireShiftWindow(
	fromMin: number | null,
	toMin: number | null,
): { fromMin: number | null; toMin: number | null } {
	const check = (value: number | null, label: string): void => {
		if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1440)) {
			throw new ValidationError(`${label} must be between 0 and 1440 minutes (got ${value})`);
		}
	};
	check(fromMin, "fromMin");
	check(toMin, "toMin");
	if (fromMin !== null && toMin !== null && toMin <= fromMin) {
		throw new ValidationError(`toMin must be greater than fromMin (got ${toMin} and ${fromMin})`);
	}
	return { fromMin, toMin };
}

/**
 * Validates a surcharge percentage.
 *
 * @param surcharge - surcharge in percent
 * @returns the validated value
 */
function requireSurcharge(surcharge: number): number {
	if (!Number.isFinite(surcharge) || surcharge < 0) {
		throw new ValidationError(`surcharge must be 0 or more (got ${surcharge})`);
	}
	return surcharge;
}

/**
 * Creates the rule repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createRulesRepository(db: Db): RulesRepository {
	const selectPauseById = db.prepare(`SELECT ${PAUSE_COLUMNS} FROM pause_rules WHERE id = ?`);
	const selectPauseScope = db.prepare(
		`SELECT ${PAUSE_COLUMNS} FROM pause_rules
		 WHERE (user_id IS NULL OR user_id = ?)
		 ORDER BY from_min, id`,
	);
	const insertPause = db.prepare(
		"INSERT INTO pause_rules (user_id, from_min, to_min, pause_min, is_active) VALUES (?, ?, ?, ?, ?)",
	);
	const updatePause = db.prepare(
		"UPDATE pause_rules SET user_id = ?, from_min = ?, to_min = ?, pause_min = ?, is_active = ? WHERE id = ?",
	);
	const deletePause = db.prepare("DELETE FROM pause_rules WHERE id = ?");

	const selectShiftById = db.prepare(`SELECT ${SHIFT_COLUMNS} FROM shift_rules WHERE id = ?`);
	const selectShiftScope = db.prepare(
		`SELECT ${SHIFT_COLUMNS} FROM shift_rules
		 WHERE (user_id IS NULL OR user_id = ?)
		 ORDER BY (day_of_week IS NULL), day_of_week, (from_min IS NULL), from_min, id`,
	);
	const insertShift = db.prepare(
		`INSERT INTO shift_rules (user_id, day_of_week, from_min, to_min, surcharge, is_active)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const updateShift = db.prepare(
		`UPDATE shift_rules SET user_id = ?, day_of_week = ?, from_min = ?, to_min = ?, surcharge = ?, is_active = ?
		 WHERE id = ?`,
	);
	const deleteShift = db.prepare("DELETE FROM shift_rules WHERE id = ?");

	const readPause = (id: number): PauseRuleRecord | null => {
		const row = selectPauseById.get(id) as PauseRuleRow | undefined;
		return row ? mapPauseRuleRow(row) : null;
	};

	const readShift = (id: number): ShiftRuleRecord | null => {
		const row = selectShiftById.get(id) as ShiftRuleRow | undefined;
		return row ? mapShiftRuleRow(row) : null;
	};

	/**
	 * Reads the break rules of one scope.
	 *
	 * @param userId - owner of the user specific rules
	 * @param includeInactive - true to keep disabled rules
	 * @returns rules of the scope
	 */
	const scopePauseRules = (userId: number | null, includeInactive: boolean): PauseRuleRecord[] =>
		(selectPauseScope.all(userId) as PauseRuleRow[])
			.map(mapPauseRuleRow)
			.filter(rule => (userId === null ? rule.userId === null : rule.userId === userId))
			.filter(rule => includeInactive || rule.isActive);

	return {
		pauseRules(userId?: number | null, options?: { includeInactive?: boolean }): PauseRuleRecord[] {
			const includeInactive = options?.includeInactive === true;
			const owner = userId ?? null;
			const merged = new Map<number, PauseRuleRecord>();

			// company defaults first, then the user specific rules replace them by `fromMin`
			for (const rule of scopePauseRules(null, includeInactive)) {
				merged.set(rule.fromMin, rule);
			}
			if (owner !== null) {
				for (const rule of scopePauseRules(owner, includeInactive)) {
					merged.set(rule.fromMin, rule);
				}
			}
			return [...merged.values()].sort((a, b) => a.fromMin - b.fromMin || a.id - b.id);
		},

		listPauseRules(input?: { userId?: number | null; includeInactive?: boolean }): PauseRuleRecord[] {
			return scopePauseRules(input?.userId ?? null, input?.includeInactive === true);
		},

		savePauseRule(input: SavePauseRuleInput): PauseRuleRecord {
			const window = requirePauseWindow(input.fromMin, input.toMin ?? null);
			const pauseMin = Math.round(input.pauseMin);
			if (!Number.isFinite(input.pauseMin) || pauseMin <= 0) {
				throw new ValidationError(`pauseMin must be greater than 0 (got ${input.pauseMin})`);
			}
			const userId = input.userId ?? null;
			const isActive = input.isActive !== false;
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const current = input.id === undefined ? null : readPause(input.id);
			if (input.id !== undefined && !current) {
				throw new NotFoundError(`pause rule ${input.id} not found`);
			}

			const next: PauseRuleRecord = {
				id: current?.id ?? 0,
				userId,
				fromMin: window.fromMin,
				toMin: window.toMin,
				pauseMin,
				isActive,
			};
			const changes = current
				? diffFields(
						current as unknown as Record<string, unknown>,
						next as unknown as Record<string, unknown>,
						AUDITED_PAUSE_FIELDS as unknown as (keyof Record<string, unknown>)[],
					)
				: null;
			if (current && Object.keys(changes ?? {}).length === 0) {
				return current;
			}

			let ruleId = current?.id ?? 0;
			const run = db.transaction((): void => {
				if (current) {
					updatePause.run(userId, next.fromMin, next.toMin, next.pauseMin, isActive ? 1 : 0, current.id);
				} else {
					ruleId = Number(
						insertPause.run(userId, next.fromMin, next.toMin, next.pauseMin, isActive ? 1 : 0)
							.lastInsertRowid,
					);
				}
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: current ? "pause_rule.update" : "pause_rule.create",
					entity: "pause_rule",
					entityId: ruleId,
					detail: current
						? { changes }
						: { userId, fromMin: next.fromMin, toMin: next.toMin, pauseMin: next.pauseMin },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const saved = readPause(ruleId);
			if (!saved) {
				throw new Error(`pause rule ${ruleId} disappeared right after the write`);
			}
			return saved;
		},

		removePauseRule(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const current = readPause(input.id);
			if (!current) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deletePause.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "pause_rule.delete",
					entity: "pause_rule",
					entityId: input.id,
					detail: { userId: current.userId, fromMin: current.fromMin, pauseMin: current.pauseMin },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},

		shiftRules(userId?: number | null, options?: { includeInactive?: boolean }): ShiftRuleRecord[] {
			const includeInactive = options?.includeInactive === true;
			const owner = userId ?? null;
			const merged = new Map<string, ShiftRuleRecord>();
			const keyOf = (rule: ShiftRuleRecord): string => `${rule.dayOfWeek ?? "*"}:${rule.fromMin ?? "*"}`;

			const scope = (scopeUserId: number | null): ShiftRuleRecord[] =>
				(selectShiftScope.all(scopeUserId) as ShiftRuleRow[])
					.map(mapShiftRuleRow)
					.filter(rule => (scopeUserId === null ? rule.userId === null : rule.userId === scopeUserId))
					.filter(rule => includeInactive || rule.isActive);

			for (const rule of scope(null)) {
				merged.set(keyOf(rule), rule);
			}
			if (owner !== null) {
				for (const rule of scope(owner)) {
					merged.set(keyOf(rule), rule);
				}
			}
			return [...merged.values()].sort(
				(a, b) =>
					(a.dayOfWeek ?? 7) - (b.dayOfWeek ?? 7) || (a.fromMin ?? -1) - (b.fromMin ?? -1) || a.id - b.id,
			);
		},

		saveShiftRule(input: SaveShiftRuleInput): ShiftRuleRecord {
			const dayOfWeek = input.dayOfWeek ?? null;
			if (dayOfWeek !== null && (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) {
				throw new ValidationError(`dayOfWeek must be between 0 and 6 (got ${dayOfWeek})`);
			}
			const window = requireShiftWindow(input.fromMin ?? null, input.toMin ?? null);
			const surcharge = requireSurcharge(input.surcharge);
			const userId = input.userId ?? null;
			const isActive = input.isActive !== false;
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const current = input.id === undefined ? null : readShift(input.id);
			if (input.id !== undefined && !current) {
				throw new NotFoundError(`shift rule ${input.id} not found`);
			}

			const next: ShiftRuleRecord = {
				id: current?.id ?? 0,
				userId,
				dayOfWeek,
				fromMin: window.fromMin,
				toMin: window.toMin,
				surcharge,
				isActive,
			};
			const changes = current
				? diffFields(
						current as unknown as Record<string, unknown>,
						next as unknown as Record<string, unknown>,
						AUDITED_SHIFT_FIELDS as unknown as (keyof Record<string, unknown>)[],
					)
				: null;
			if (current && Object.keys(changes ?? {}).length === 0) {
				return current;
			}

			let ruleId = current?.id ?? 0;
			const run = db.transaction((): void => {
				if (current) {
					updateShift.run(
						userId,
						next.dayOfWeek,
						next.fromMin,
						next.toMin,
						next.surcharge,
						isActive ? 1 : 0,
						current.id,
					);
				} else {
					ruleId = Number(
						insertShift.run(
							userId,
							next.dayOfWeek,
							next.fromMin,
							next.toMin,
							next.surcharge,
							isActive ? 1 : 0,
						).lastInsertRowid,
					);
				}
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: current ? "shift_rule.update" : "shift_rule.create",
					entity: "shift_rule",
					entityId: ruleId,
					detail: current
						? { changes }
						: { userId, dayOfWeek, fromMin: next.fromMin, toMin: next.toMin, surcharge },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const saved = readShift(ruleId);
			if (!saved) {
				throw new Error(`shift rule ${ruleId} disappeared right after the write`);
			}
			return saved;
		},

		removeShiftRule(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const current = readShift(input.id);
			if (!current) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deleteShift.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "shift_rule.delete",
					entity: "shift_rule",
					entityId: input.id,
					detail: { userId: current.userId, dayOfWeek: current.dayOfWeek, surcharge: current.surcharge },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},
	};
}
