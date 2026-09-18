/**
 * Automation rules (`automation_rules`, `automation_runs`).
 *
 * The rules of the adapter itself — not of a foreign state like the trigger rules. Three kinds are supported:
 *
 *  - `clockOut`: at a certain local time the adapter punches out an employee who is still clocked in. The punch is
 *    written like any other one (`source: "api"`, note `auto.clock_out`), so it appears in the day, in the report
 *    and in the audit trail — the employee can correct it afterwards like any other punch.
 *  - `missingPunch`: the same moment, but the adapter only reports it. Nothing is written, so a shop that wants to
 *    decide case by case gets a warning instead of a silent correction.
 *  - `breakReminder`: an employee whose running work block reached the configured length gets a reminder — after a
 *    break, the block starts again.
 *
 * `user_id` is `NULL` for a company rule and set for a rule of one employee. A rule runs at most once per employee
 * and local date: `automation_runs` holds that decision, which also gives the administration a small log (`action`
 * and `fired_at`) to look at.
 */

import type { Db } from "../database";
import { NotFoundError, ValidationError } from "../../errors";
import { diffFields, writeAuditLog } from "./audit";

/** Kinds an automation rule can have. */
export type AutomationKind = "clockOut" | "missingPunch" | "breakReminder";

/** An automation rule as it is stored. */
export interface AutomationRuleRecord {
	/** Primary key */
	id: number;
	/** Free-form label, shown in the administration */
	label: string | null;
	/** What the rule does */
	kind: AutomationKind;
	/** Employee the rule applies to, `null` for every employee */
	userId: number | null;
	/** Minute of the local day the rule acts at (kinds `clockOut` and `missingPunch`) */
	atMinute: number | null;
	/** Length of the running work block in minutes (kind `breakReminder`) */
	afterMinutes: number | null;
	/** Inactive rules are ignored but keep their history */
	isActive: boolean;
}

/** Input for creating or changing a rule. */
export interface SaveAutomationRuleInput {
	/** Id of an existing rule, omitted when a new rule is created */
	id?: number;
	/** Free-form label */
	label?: string | null;
	/** What the rule does */
	kind: AutomationKind;
	/** Employee the rule applies to, `null` or omitted for every employee */
	userId?: number | null;
	/** Minute of the local day (kinds `clockOut` and `missingPunch`) */
	atMinute?: number | null;
	/** Length of the running work block in minutes (kind `breakReminder`) */
	afterMinutes?: number | null;
	/** `false` disables the rule without deleting it */
	isActive?: boolean;
	/** Who changes the rule */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** One run of a rule. */
export interface AutomationRunRecord {
	/** Rule that ran */
	ruleId: number;
	/** Employee it ran for */
	userId: number;
	/** Local date it ran on */
	localDate: string;
	/** Instant it ran */
	firedAt: number;
	/** Short description of what happened */
	action: string;
}

/** Automation rule storage operations. */
export interface AutomationsRepository {
	/** All rules, optionally including the disabled ones */
	list(options?: { includeInactive?: boolean }): AutomationRuleRecord[];
	/** Reads one rule */
	findById(id: number): AutomationRuleRecord | null;
	/** Creates or updates a rule */
	save(input: SaveAutomationRuleInput): AutomationRuleRecord;
	/** Deletes a rule (its runs go with it) */
	remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
	/** Runs of the rules, newest first */
	runs(input?: { ruleId?: number; localDate?: string; limit?: number }): AutomationRunRecord[];
	/** True when the rule already ran for that employee on that local date */
	hasRun(input: { ruleId: number; userId: number; localDate: string }): boolean;
	/** Notes a run; a second call for the same rule, employee and date changes nothing and returns `false` */
	recordRun(input: { ruleId: number; userId: number; localDate: string; action: string; now?: number }): boolean;
	/** Forgets a run again — used when an action failed, so the next check can retry it */
	forgetRun(input: { ruleId: number; userId: number; localDate: string }): boolean;
}

/** Raw database row of a rule. */
interface AutomationRuleRow {
	id: number;
	label: string | null;
	kind: string;
	user_id: number | null;
	at_minute: number | null;
	after_minutes: number | null;
	is_active: number;
}

/** Raw database row of a run. */
interface AutomationRunRow {
	rule_id: number;
	user_id: number;
	local_date: string;
	fired_at: number;
	action: string;
}

const RULE_COLUMNS = "id, label, kind, user_id, at_minute, after_minutes, is_active";
const RUN_COLUMNS = "rule_id, user_id, local_date, fired_at, action";

/** Fields of a rule that are compared for the audit trail. */
const AUDITED_FIELDS: (keyof AutomationRuleRecord)[] = [
	"label",
	"kind",
	"userId",
	"atMinute",
	"afterMinutes",
	"isActive",
];

/** Kinds a rule may use. */
const KINDS: AutomationKind[] = ["clockOut", "missingPunch", "breakReminder"];

/** Kinds that act at a fixed local time. */
const TIMED_KINDS: AutomationKind[] = ["clockOut", "missingPunch"];

/**
 * Maps a database row to a rule record.
 *
 * @param row - raw database row
 * @returns rule record
 */
export function mapAutomationRuleRow(row: AutomationRuleRow): AutomationRuleRecord {
	return {
		id: row.id,
		label: row.label,
		kind: KINDS.includes(row.kind as AutomationKind) ? (row.kind as AutomationKind) : "clockOut",
		userId: row.user_id,
		atMinute: row.at_minute,
		afterMinutes: row.after_minutes,
		isActive: row.is_active !== 0,
	};
}

/**
 * Maps a database row to a run record.
 *
 * @param row - raw database row
 * @returns run record
 */
export function mapAutomationRunRow(row: AutomationRunRow): AutomationRunRecord {
	return {
		ruleId: row.rule_id,
		userId: row.user_id,
		localDate: row.local_date,
		firedAt: row.fired_at,
		action: row.action,
	};
}

/**
 * Validates the kind of a rule.
 *
 * @param value - kind from the request
 * @returns the validated kind
 */
function requireKind(value: string): AutomationKind {
	if (!KINDS.includes(value as AutomationKind)) {
		throw new ValidationError(`kind must be one of ${KINDS.join(", ")} (got ${value})`);
	}
	return value as AutomationKind;
}

/**
 * Validates the time of a rule: a timed kind needs a minute of the day, the reminder needs a length.
 *
 * @param kind - kind of the rule
 * @param atMinute - minute of the local day
 * @param afterMinutes - length of the running work block
 * @returns the validated values
 */
function requireWindow(
	kind: AutomationKind,
	atMinute: number | null,
	afterMinutes: number | null,
): { atMinute: number | null; afterMinutes: number | null } {
	if (TIMED_KINDS.includes(kind)) {
		if (atMinute === null || !Number.isInteger(atMinute) || atMinute < 0 || atMinute > 1439) {
			throw new ValidationError(`atMinute must be a minute of the day between 0 and 1439 (got ${atMinute})`);
		}
		return { atMinute, afterMinutes: null };
	}

	if (afterMinutes === null || !Number.isInteger(afterMinutes) || afterMinutes < 1 || afterMinutes > 1440) {
		throw new ValidationError(`afterMinutes must be between 1 and 1440 (got ${afterMinutes})`);
	}
	return { atMinute: null, afterMinutes };
}

/**
 * Creates the automation rule repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createAutomationsRepository(db: Db): AutomationsRepository {
	const selectById = db.prepare(`SELECT ${RULE_COLUMNS} FROM automation_rules WHERE id = ?`);
	const selectAll = db.prepare(`SELECT ${RULE_COLUMNS} FROM automation_rules ORDER BY id`);
	const selectActive = db.prepare(`SELECT ${RULE_COLUMNS} FROM automation_rules WHERE is_active = 1 ORDER BY id`);
	const insertRule = db.prepare(
		`INSERT INTO automation_rules (label, kind, user_id, at_minute, after_minutes, is_active, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateRule = db.prepare(
		`UPDATE automation_rules
		 SET label = ?, kind = ?, user_id = ?, at_minute = ?, after_minutes = ?, is_active = ?, updated_at = ?
		 WHERE id = ?`,
	);
	const deleteRule = db.prepare("DELETE FROM automation_rules WHERE id = ?");
	const selectRuns = db.prepare(
		`SELECT ${RUN_COLUMNS} FROM automation_runs
		 WHERE rule_id = ? AND (? IS NULL OR local_date = ?)
		 ORDER BY local_date DESC, rule_id LIMIT ?`,
	);
	const selectAllRuns = db.prepare(
		`SELECT ${RUN_COLUMNS} FROM automation_runs ORDER BY fired_at DESC, rule_id LIMIT ?`,
	);
	const selectRun = db.prepare(
		"SELECT 1 AS found FROM automation_runs WHERE rule_id = ? AND user_id = ? AND local_date = ?",
	);
	const insertRun = db.prepare(
		`INSERT OR IGNORE INTO automation_runs (rule_id, user_id, local_date, fired_at, action)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	const deleteRun = db.prepare("DELETE FROM automation_runs WHERE rule_id = ? AND user_id = ? AND local_date = ?");

	/**
	 * Reads one rule.
	 *
	 * @param id - rule id
	 * @returns the rule or `null`
	 */
	const read = (id: number): AutomationRuleRecord | null => {
		const row = selectById.get(id) as AutomationRuleRow | undefined;
		return row ? mapAutomationRuleRow(row) : null;
	};

	return {
		list(options?: { includeInactive?: boolean }): AutomationRuleRecord[] {
			const rows = (options?.includeInactive === true ? selectAll : selectActive).all() as AutomationRuleRow[];
			return rows.map(mapAutomationRuleRow);
		},

		findById: read,

		save(input: SaveAutomationRuleInput): AutomationRuleRecord {
			const kind = requireKind(input.kind);
			const window = requireWindow(kind, input.atMinute ?? null, input.afterMinutes ?? null);
			const label = (input.label ?? "").trim() || null;
			const userId = input.userId ?? null;
			if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
				throw new ValidationError(`userId must reference an existing employee (got ${input.userId})`);
			}
			const isActive = input.isActive !== false;
			const now = input.now ?? Math.floor(Date.now() / 1000);

			const current = input.id === undefined ? null : read(input.id);
			if (input.id !== undefined && !current) {
				throw new NotFoundError(`automation rule ${input.id} not found`);
			}

			const next: AutomationRuleRecord = {
				id: current?.id ?? 0,
				label,
				kind,
				userId,
				atMinute: window.atMinute,
				afterMinutes: window.afterMinutes,
				isActive,
			};
			const changes = current
				? diffFields(
						current as unknown as Record<string, unknown>,
						next as unknown as Record<string, unknown>,
						AUDITED_FIELDS as unknown as (keyof Record<string, unknown>)[],
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
						kind,
						userId,
						window.atMinute,
						window.afterMinutes,
						isActive ? 1 : 0,
						now,
						current.id,
					);
				} else {
					ruleId = Number(
						insertRule.run(
							label,
							kind,
							userId,
							window.atMinute,
							window.afterMinutes,
							isActive ? 1 : 0,
							now,
							now,
						).lastInsertRowid,
					);
				}
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: current ? "automation_rule.update" : "automation_rule.create",
					entity: "automation_rule",
					entityId: ruleId,
					detail: current
						? { changes }
						: { kind, userId, atMinute: window.atMinute, afterMinutes: window.afterMinutes, isActive },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const saved = read(ruleId);
			if (!saved) {
				throw new Error(`automation rule ${ruleId} disappeared right after the write`);
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
					action: "automation_rule.delete",
					entity: "automation_rule",
					entityId: input.id,
					detail: { kind: current.kind, userId: current.userId, label: current.label },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},

		runs(input?: { ruleId?: number; localDate?: string; limit?: number }): AutomationRunRecord[] {
			const limit = Math.min(Math.max(input?.limit ?? 50, 1), 500);
			if (input?.ruleId === undefined) {
				return (selectAllRuns.all(limit) as AutomationRunRow[]).map(mapAutomationRunRow);
			}
			const rows = selectRuns.all(
				input.ruleId,
				input.localDate ?? null,
				input.localDate ?? null,
				limit,
			) as AutomationRunRow[];
			return rows.map(mapAutomationRunRow);
		},

		hasRun(input: { ruleId: number; userId: number; localDate: string }): boolean {
			return selectRun.get(input.ruleId, input.userId, input.localDate) !== undefined;
		},

		recordRun(input: { ruleId: number; userId: number; localDate: string; action: string; now?: number }): boolean {
			const result = insertRun.run(
				input.ruleId,
				input.userId,
				input.localDate,
				input.now ?? Math.floor(Date.now() / 1000),
				input.action,
			);
			return result.changes > 0;
		},

		forgetRun(input: { ruleId: number; userId: number; localDate: string }): boolean {
			return deleteRun.run(input.ruleId, input.userId, input.localDate).changes > 0;
		},
	};
}
