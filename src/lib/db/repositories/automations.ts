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
export type AutomationKind = "clockIn" | "clockOut" | "missingPunch" | "breakReminder";

/** How often a rule may act for one employee. */
export type AutomationRepeat = "day" | "week";

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
	/** Days of the week the rule runs on, ISO numbers 1 (Monday) to 7 (Sunday) */
	weekdays: number[];
	/** Whether the rule may act once a day or once an ISO week per employee */
	repeat: AutomationRepeat;
	/** Inactive rules are ignored but keep their history */
	isActive: boolean;
	/** First local day the rule is valid on (`YYYY-MM-DD`), `null` for “from now on” */
	activeFrom: string | null;
	/** Last local day the rule is valid on (`YYYY-MM-DD`, inclusive), `null` for “without an end” */
	activeUntil: string | null;
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
	/** Days of the week the rule runs on (ISO 1..7), omitted keeps the stored selection */
	weekdays?: number[];
	/** How often the rule may act, omitted keeps the stored value */
	repeat?: AutomationRepeat;
	/** `false` disables the rule without deleting it */
	isActive?: boolean;
	/** First local day the rule is valid on, omitted keeps the stored value, `null`/empty clears it */
	activeFrom?: string | null;
	/** Last local day the rule is valid on (inclusive), omitted keeps the stored value, `null`/empty clears it */
	activeUntil?: string | null;
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
	/** Period it ran in: the local date, or the ISO week (`2026-W38`) for a weekly rule */
	period: string;
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
	/** Runs of the rules, newest first — the log behind the overview */
	runs(input?: { ruleId?: number; period?: string; limit?: number }): AutomationRunRecord[];
	/** The newest run of every rule, newest first — one line per rule for the overview */
	latestRuns(): AutomationRunRecord[];
	/** True when the rule already ran for that employee in that period */
	hasRun(input: { ruleId: number; userId: number; period: string }): boolean;
	/** Notes a run; a second call for the same rule, employee and period changes nothing and returns `false` */
	recordRun(input: { ruleId: number; userId: number; period: string; action: string; now?: number }): boolean;
	/** Forgets a run again — used when an action failed, so the next check can retry it */
	forgetRun(input: { ruleId: number; userId: number; period: string }): boolean;
}

/** Raw database row of a rule. */
interface AutomationRuleRow {
	id: number;
	label: string | null;
	kind: string;
	user_id: number | null;
	at_minute: number | null;
	after_minutes: number | null;
	weekdays: number;
	repeat: string;
	is_active: number;
	active_from: string | null;
	active_until: string | null;
}

/** Raw database row of a run. */
interface AutomationRunRow {
	rule_id: number;
	user_id: number;
	period: string;
	fired_at: number;
	action: string;
}

const RULE_COLUMNS =
	"id, label, kind, user_id, at_minute, after_minutes, weekdays, repeat, is_active, active_from, active_until";
const RUN_COLUMNS = "rule_id, user_id, period, fired_at, action";

/**
 * Fields of a rule that are compared for the audit trail.
 *
 * `weekdays` is not in here: it is a list, and the comparison of the audit trail works on single values. The saved
 * selection is written to the audit detail separately.
 */
const AUDITED_FIELDS: (keyof AutomationRuleRecord)[] = [
	"label",
	"kind",
	"userId",
	"atMinute",
	"afterMinutes",
	"repeat",
	"isActive",
	"activeFrom",
	"activeUntil",
];

/** Kinds a rule may use. */
const KINDS: AutomationKind[] = ["clockIn", "clockOut", "missingPunch", "breakReminder"];

/** Kinds that act at a fixed local time. */
const TIMED_KINDS: AutomationKind[] = ["clockIn", "clockOut", "missingPunch"];

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
		// a row written before the migration has no selection: every day is the sensible default
		weekdays: maskToWeekdays(row.weekdays ?? 127),
		repeat: row.repeat === "week" ? "week" : "day",
		isActive: row.is_active !== 0,
		activeFrom: row.active_from ?? null,
		activeUntil: row.active_until ?? null,
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
		period: row.period,
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
 * Validates one end of the validity period of a rule.
 *
 * `undefined` keeps the stored value, an empty string or `null` clears the limit (that is the “from now on” and
 * “without an end” of the dialog), anything else has to be a real calendar date in `YYYY-MM-DD`.
 *
 * @param value - value from the request
 * @param fallback - value to keep when the request says nothing
 * @param field - field name for the error message
 * @returns the validated date or `null`
 */
function requireValidityDate(value: string | null | undefined, fallback: string | null, field: string): string | null {
	if (value === undefined) {
		return fallback;
	}
	const text = (value ?? "").trim();
	if (text === "") {
		return null;
	}
	const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	const date = parts ? new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))) : null;
	if (
		!parts ||
		!date ||
		date.getUTCFullYear() !== Number(parts[1]) ||
		date.getUTCMonth() !== Number(parts[2]) - 1 ||
		date.getUTCDate() !== Number(parts[3])
	) {
		throw new ValidationError(`${field} must be a date like 2026-10-01 (got ${text})`);
	}
	return text;
}

/** Days a rule runs on when nothing else is chosen. */
export const ALL_WEEKDAYS: number[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Turns the stored bitmask into ISO weekdays.
 *
 * @param mask - bits 0..6, bit 0 is Monday
 * @returns the days, at least every day when the mask is empty
 */
export function maskToWeekdays(mask: number): number[] {
	const days: number[] = [];
	for (let day = 1; day <= 7; day += 1) {
		if ((mask & (1 << (day - 1))) !== 0) {
			days.push(day);
		}
	}
	return days.length > 0 ? days : [...ALL_WEEKDAYS];
}

/**
 * Turns ISO weekdays into the stored bitmask.
 *
 * @param days - the days, ISO numbers 1..7
 * @returns the mask
 */
export function weekdaysToMask(days: number[]): number {
	let mask = 0;
	for (const day of days) {
		mask |= 1 << (day - 1);
	}
	return mask;
}

/**
 * Validates the weekday selection of a rule.
 *
 * @param value - selection from the request, `undefined` keeps the stored one
 * @param fallback - the stored selection
 * @returns the validated, sorted selection
 */
function requireWeekdays(value: number[] | undefined, fallback: number[]): number[] {
	const days = value ?? fallback;
	if (!Array.isArray(days) || days.length === 0) {
		throw new ValidationError("weekdays must name at least one day (1 = Monday … 7 = Sunday)");
	}
	for (const day of days) {
		if (!Number.isInteger(day) || day < 1 || day > 7) {
			throw new ValidationError(`weekdays must be ISO days 1..7 (got ${day})`);
		}
	}
	return [...new Set(days)].sort((left, right) => left - right);
}

/**
 * Validates how often a rule may act.
 *
 * @param value - value from the request, `undefined` keeps the stored one
 * @param fallback - the stored value
 * @returns the validated value
 */
function requireRepeat(value: AutomationRepeat | undefined, fallback: AutomationRepeat): AutomationRepeat {
	const repeat = value ?? fallback;
	if (repeat !== "day" && repeat !== "week") {
		// the type already rules it out, this is for a caller that is not TypeScript
		throw new ValidationError(`repeat must be "day" or "week" (got ${String(value)})`);
	}
	return repeat;
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
		`INSERT INTO automation_rules (label, kind, user_id, at_minute, after_minutes, weekdays, repeat, is_active, active_from, active_until, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateRule = db.prepare(
		`UPDATE automation_rules
		 SET label = ?, kind = ?, user_id = ?, at_minute = ?, after_minutes = ?, weekdays = ?, repeat = ?,
		     is_active = ?, active_from = ?, active_until = ?, updated_at = ?
		 WHERE id = ?`,
	);
	const deleteRule = db.prepare("DELETE FROM automation_rules WHERE id = ?");
	// the runs are deleted with their rule: the rebuilt table of migration 18 has no foreign key for that
	const deleteRunsOfRule = db.prepare("DELETE FROM automation_runs WHERE rule_id = ?");
	const selectRuns = db.prepare(
		`SELECT ${RUN_COLUMNS} FROM automation_runs
		 WHERE rule_id = ? AND (? IS NULL OR period = ?)
		 ORDER BY period DESC, rule_id LIMIT ?`,
	);
	const selectAllRuns = db.prepare(
		`SELECT ${RUN_COLUMNS} FROM automation_runs ORDER BY fired_at DESC, rule_id LIMIT ?`,
	);
	// one line per rule: SQLite takes the bare columns of the row that carries the `MAX()` when a query has exactly
	// one aggregate, so `user_id` and `period` belong to the newest run of their rule
	const selectLatestRuns = db.prepare(
		`SELECT rule_id, user_id, period, MAX(fired_at) AS fired_at, action
		 FROM automation_runs GROUP BY rule_id ORDER BY fired_at DESC, rule_id`,
	);
	const selectRun = db.prepare(
		"SELECT 1 AS found FROM automation_runs WHERE rule_id = ? AND user_id = ? AND period = ?",
	);
	const insertRun = db.prepare(
		`INSERT OR IGNORE INTO automation_runs (rule_id, user_id, period, fired_at, action)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	const deleteRun = db.prepare("DELETE FROM automation_runs WHERE rule_id = ? AND user_id = ? AND period = ?");

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
			const weekdays = requireWeekdays(input.weekdays, current?.weekdays ?? ALL_WEEKDAYS);
			const repeat = requireRepeat(input.repeat, current?.repeat ?? "day");
			const activeFrom = requireValidityDate(input.activeFrom, current?.activeFrom ?? null, "activeFrom");
			const activeUntil = requireValidityDate(input.activeUntil, current?.activeUntil ?? null, "activeUntil");
			if (activeFrom !== null && activeUntil !== null && activeUntil < activeFrom) {
				throw new ValidationError(`activeUntil must not be before activeFrom (${activeFrom} … ${activeUntil})`);
			}

			const next: AutomationRuleRecord = {
				id: current?.id ?? 0,
				label,
				kind,
				userId,
				atMinute: window.atMinute,
				afterMinutes: window.afterMinutes,
				weekdays,
				repeat,
				isActive,
				activeFrom,
				activeUntil,
			};
			const changes = current
				? diffFields(
						current as unknown as Record<string, unknown>,
						next as unknown as Record<string, unknown>,
						AUDITED_FIELDS as unknown as (keyof Record<string, unknown>)[],
					)
				: null;
			// the days are a list, so they are compared by their mask — that is also what the audit trail shows
			if (changes && weekdaysToMask(current?.weekdays ?? ALL_WEEKDAYS) !== weekdaysToMask(weekdays)) {
				changes.weekdays = { old: current?.weekdays ?? [], new: weekdays };
			}
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
						weekdaysToMask(weekdays),
						repeat,
						isActive ? 1 : 0,
						activeFrom,
						activeUntil,
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
							weekdaysToMask(weekdays),
							repeat,
							isActive ? 1 : 0,
							activeFrom,
							activeUntil,
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
						: {
								kind,
								userId,
								atMinute: window.atMinute,
								afterMinutes: window.afterMinutes,
								weekdays,
								repeat,
								isActive,
							},
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
				deleteRunsOfRule.run(input.id);
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

		runs(input?: { ruleId?: number; period?: string; limit?: number }): AutomationRunRecord[] {
			const limit = Math.min(Math.max(input?.limit ?? 50, 1), 500);
			if (input?.ruleId === undefined) {
				return (selectAllRuns.all(limit) as AutomationRunRow[]).map(mapAutomationRunRow);
			}
			const rows = selectRuns.all(
				input.ruleId,
				input.period ?? null,
				input.period ?? null,
				limit,
			) as AutomationRunRow[];
			return rows.map(mapAutomationRunRow);
		},

		latestRuns(): AutomationRunRecord[] {
			return (selectLatestRuns.all() as AutomationRunRow[]).map(mapAutomationRunRow);
		},

		hasRun(input: { ruleId: number; userId: number; period: string }): boolean {
			return selectRun.get(input.ruleId, input.userId, input.period) !== undefined;
		},

		recordRun(input: { ruleId: number; userId: number; period: string; action: string; now?: number }): boolean {
			const result = insertRun.run(
				input.ruleId,
				input.userId,
				input.period,
				input.now ?? Math.floor(Date.now() / 1000),
				input.action,
			);
			return result.changes > 0;
		},

		forgetRun(input: { ruleId: number; userId: number; period: string }): boolean {
			return deleteRun.run(input.ruleId, input.userId, input.period).changes > 0;
		},
	};
}
