/**
 * Trigger rules (`trigger_rules`).
 *
 * A rule turns a write on a state of another adapter into a punch or a presence change. That is the ioBroker way
 * of connecting a fingerprint reader, a button or a door contact: configure the rule once in the administration
 * and the adapter keeps watching the state — no script, no second app, no HTTP call.
 *
 * Mode `condition`: the rule fires when the value of `sourceState` equals `condition`, and the punch goes to
 * `userId`. Mode `user`: the value itself names the employee (user id, login or display name), which fits a
 * reader that reports *who* touched it instead of a plain button.
 *
 * `cooldownSec` and `lastFiredAt` keep a chatty reader in check: a rule that fired less than the configured
 * seconds ago ignores the next write.
 */

import type { Db } from "../database";
import { NotFoundError, ValidationError } from "../../errors";
import { diffFields, writeAuditLog } from "./audit";

/** How a rule decides which employee it fires for. */
export type TriggerMode = "condition" | "user";

/** What a rule does when it fires. */
export type TriggerAction = "punch" | "quickPunch" | "present" | "absent";

/** A trigger rule as it is stored. */
export interface TriggerRuleRecord {
	/** Primary key */
	id: number;
	/** Free-form label, shown in the administration */
	label: string | null;
	/** State of another adapter that is watched */
	sourceState: string;
	/** How the employee is resolved */
	mode: TriggerMode;
	/** Value the state has to carry to fire the rule (mode `condition`) */
	condition: string | null;
	/** Employee the rule fires for (mode `condition`) */
	userId: number | null;
	/** What happens when the rule fires */
	action: TriggerAction;
	/** Inactive rules are ignored but keep their history */
	isActive: boolean;
	/** Seconds that have to pass between two fires, `0` = no limit */
	cooldownSec: number;
	/** Instant the rule fired last, `null` when it never fired */
	lastFiredAt: number | null;
}

/** Input for creating or changing a rule. */
export interface SaveTriggerRuleInput {
	/** Id of an existing rule, omitted when a new rule is created */
	id?: number;
	/** Free-form label */
	label?: string | null;
	/** State of another adapter that is watched */
	sourceState: string;
	/** How the employee is resolved, defaults to `condition` */
	mode?: TriggerMode;
	/** Value the state has to carry (mode `condition`) */
	condition?: string | null;
	/** Employee the rule fires for (mode `condition`) */
	userId?: number | null;
	/** What happens when the rule fires, defaults to `punch` */
	action?: TriggerAction;
	/** `false` disables the rule without deleting it */
	isActive?: boolean;
	/** Seconds that have to pass between two fires */
	cooldownSec?: number;
	/** Who changes the rule */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Rule storage operations. */
export interface TriggersRepository {
	/** All rules, optionally including the disabled ones */
	list(options?: { includeInactive?: boolean }): TriggerRuleRecord[];
	/** Reads one rule */
	findById(id: number): TriggerRuleRecord | null;
	/** Creates or updates a rule */
	save(input: SaveTriggerRuleInput): TriggerRuleRecord;
	/** Deletes a rule */
	remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
	/** Records a fire (leaves `updatedAt` alone: the configuration did not change) */
	markFired(input: { id: number; now?: number }): void;
}

/** Raw database row of a rule. */
interface TriggerRuleRow {
	id: number;
	label: string | null;
	source_state: string;
	mode: string;
	condition: string | null;
	user_id: number | null;
	action: string;
	is_active: number;
	cooldown_sec: number;
	last_fired_at: number | null;
}

const TRIGGER_COLUMNS =
	"id, label, source_state, mode, condition, user_id, action, is_active, cooldown_sec, last_fired_at";

/** Field names of a rule that are compared for the audit trail. */
const AUDITED_TRIGGER_FIELDS: (keyof TriggerRuleRecord)[] = [
	"label",
	"sourceState",
	"mode",
	"condition",
	"userId",
	"action",
	"isActive",
	"cooldownSec",
];

/** Modes a rule may use. */
const MODES: TriggerMode[] = ["condition", "user"];

/** Actions a rule may perform. */
const ACTIONS: TriggerAction[] = ["punch", "quickPunch", "present", "absent"];

/**
 * Maps a database row to a rule record.
 *
 * @param row - raw database row
 * @returns rule record
 */
export function mapTriggerRuleRow(row: TriggerRuleRow): TriggerRuleRecord {
	return {
		id: row.id,
		label: row.label,
		sourceState: row.source_state,
		mode: row.mode === "user" ? "user" : "condition",
		condition: row.condition,
		userId: row.user_id,
		action: ACTIONS.includes(row.action as TriggerAction) ? (row.action as TriggerAction) : "punch",
		isActive: row.is_active !== 0,
		cooldownSec: row.cooldown_sec,
		lastFiredAt: row.last_fired_at,
	};
}

/**
 * Validates the state id a rule watches.
 *
 * @param value - state id from the request
 * @returns the trimmed state id
 */
function requireSourceState(value: string): string {
	const state = (value ?? "").trim();
	if (!state) {
		throw new ValidationError("sourceState is required");
	}
	if (/\s/.test(state)) {
		throw new ValidationError(`sourceState must not contain whitespace (got "${value}")`);
	}
	return state;
}

/**
 * Validates a mode, falling back to `condition`.
 *
 * @param value - mode from the request
 * @returns the validated mode
 */
function requireMode(value: string | undefined): TriggerMode {
	if (value === undefined) {
		return "condition";
	}
	if (!MODES.includes(value as TriggerMode)) {
		throw new ValidationError(`mode must be one of ${MODES.join(", ")} (got ${value})`);
	}
	return value as TriggerMode;
}

/**
 * Validates an action, falling back to `punch`.
 *
 * @param value - action from the request
 * @returns the validated action
 */
function requireAction(value: string | undefined): TriggerAction {
	if (value === undefined) {
		return "punch";
	}
	if (!ACTIONS.includes(value as TriggerAction)) {
		throw new ValidationError(`action must be one of ${ACTIONS.join(", ")} (got ${value})`);
	}
	return value as TriggerAction;
}

/**
 * Validates the seconds that have to pass between two fires.
 *
 * @param value - cooldown from the request
 * @returns the validated cooldown
 */
function requireCooldown(value: number | undefined): number {
	const cooldown = value ?? 0;
	if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 86400) {
		throw new ValidationError(`cooldownSec must be a whole number of seconds between 0 and 86400 (got ${value})`);
	}
	return cooldown;
}

/**
 * Creates the trigger rule repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createTriggersRepository(db: Db): TriggersRepository {
	const selectById = db.prepare(`SELECT ${TRIGGER_COLUMNS} FROM trigger_rules WHERE id = ?`);
	const selectAll = db.prepare(`SELECT ${TRIGGER_COLUMNS} FROM trigger_rules ORDER BY id`);
	const selectActive = db.prepare(`SELECT ${TRIGGER_COLUMNS} FROM trigger_rules WHERE is_active = 1 ORDER BY id`);
	const insertRule = db.prepare(
		`INSERT INTO trigger_rules
		 (label, source_state, mode, condition, user_id, action, is_active, cooldown_sec, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateRule = db.prepare(
		`UPDATE trigger_rules
		 SET label = ?, source_state = ?, mode = ?, condition = ?, user_id = ?, action = ?, is_active = ?,
		     cooldown_sec = ?, updated_at = ?
		 WHERE id = ?`,
	);
	const deleteRule = db.prepare("DELETE FROM trigger_rules WHERE id = ?");
	const touchFired = db.prepare("UPDATE trigger_rules SET last_fired_at = ? WHERE id = ?");

	/**
	 * Reads one rule.
	 *
	 * @param id - rule id
	 * @returns the rule or `null`
	 */
	const read = (id: number): TriggerRuleRecord | null => {
		const row = selectById.get(id) as TriggerRuleRow | undefined;
		return row ? mapTriggerRuleRow(row) : null;
	};

	return {
		list(options?: { includeInactive?: boolean }): TriggerRuleRecord[] {
			const rows = (options?.includeInactive === true ? selectAll : selectActive).all() as TriggerRuleRow[];
			return rows.map(mapTriggerRuleRow);
		},

		findById: read,

		save(input: SaveTriggerRuleInput): TriggerRuleRecord {
			const sourceState = requireSourceState(input.sourceState);
			const mode = requireMode(input.mode);
			const action = requireAction(input.action);
			const cooldownSec = requireCooldown(input.cooldownSec);
			const label = (input.label ?? "").trim() || null;
			const isActive = input.isActive !== false;
			const now = input.now ?? Math.floor(Date.now() / 1000);

			// a rule of mode `condition` needs both: the value that fires it and the employee it fires for
			const condition = mode === "condition" ? (input.condition ?? "").trim() : null;
			if (mode === "condition" && !condition) {
				throw new ValidationError("condition is required for mode condition");
			}
			const userId = mode === "condition" ? (input.userId ?? null) : null;
			if (mode === "condition" && (!Number.isInteger(userId) || (userId ?? 0) <= 0)) {
				throw new ValidationError(`userId must reference an existing employee (got ${input.userId})`);
			}

			const current = input.id === undefined ? null : read(input.id);
			if (input.id !== undefined && !current) {
				throw new NotFoundError(`trigger rule ${input.id} not found`);
			}

			const next: TriggerRuleRecord = {
				id: current?.id ?? 0,
				label,
				sourceState,
				mode,
				condition,
				userId,
				action,
				isActive,
				cooldownSec,
				lastFiredAt: current?.lastFiredAt ?? null,
			};
			const changes = current
				? diffFields(
						current as unknown as Record<string, unknown>,
						next as unknown as Record<string, unknown>,
						AUDITED_TRIGGER_FIELDS as unknown as (keyof Record<string, unknown>)[],
					)
				: null;
			if (current && Object.keys(changes ?? {}).length === 0) {
				return current;
			}

			let ruleId = current?.id ?? 0;
			const run = db.transaction((): void => {
				if (current) {
					updateRule.run(
						label,
						sourceState,
						mode,
						condition,
						userId,
						action,
						isActive ? 1 : 0,
						cooldownSec,
						now,
						current.id,
					);
				} else {
					ruleId = Number(
						insertRule.run(
							label,
							sourceState,
							mode,
							condition,
							userId,
							action,
							isActive ? 1 : 0,
							cooldownSec,
							now,
							now,
						).lastInsertRowid,
					);
				}
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: current ? "trigger_rule.update" : "trigger_rule.create",
					entity: "trigger_rule",
					entityId: ruleId,
					detail: current
						? { changes }
						: { sourceState, mode, condition, userId, action, isActive, cooldownSec },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const saved = read(ruleId);
			if (!saved) {
				throw new Error(`trigger rule ${ruleId} disappeared right after the write`);
			}
			return saved;
		},

		remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const current = read(input.id);
			if (!current) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deleteRule.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "trigger_rule.delete",
					entity: "trigger_rule",
					entityId: input.id,
					detail: { sourceState: current.sourceState, mode: current.mode, action: current.action },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},

		markFired(input: { id: number; now?: number }): void {
			touchFired.run(input.now ?? Math.floor(Date.now() / 1000), input.id);
		},
	};
}
