/**
 * Trigger rules of the adapter.
 *
 * A rule watches a state of another adapter and turns a write on it into a punch or a presence change — the
 * ioBroker way of connecting a fingerprint reader, a button or a door contact. This module only *decides*:
 * the adapter subscribes to the states and runs the decision, so the logic itself stays free of ioBroker.
 *
 * A rule fires on a **change** of the value (a reader that repeats itself is harmless) and only after the
 * configured cooldown. In mode `condition` the value has to equal the stored one and the punch goes to the
 * stored employee; in mode `user` the value names the employee — as id, login or display name.
 */

import type { TriggerRuleRecord } from "../db/repositories/triggers";
import type { UserRecord, UsersRepository } from "../db/repositories/users";

/** Users the trigger logic resolves employees with. */
export type TriggerUsers = Pick<UsersRepository, "findById" | "findByLogin" | "list">;

/** What the adapter knows about a write on a watched state. */
export interface TriggerContext {
	/** Value that was written */
	value: ioBroker.StateValue;
	/** Value seen before, `null` on the first look after the start */
	previous: string | null;
	/** Instant of the write, UTC epoch seconds */
	now: number;
}

/** Outcome of a rule check. */
export interface TriggerDecision {
	/** True when the action has to run */
	fire: boolean;
	/** Employee the action applies to, `null` when the rule did not fire */
	userId: number | null;
	/** Why the rule fired or not — goes to the log and to the tests */
	reason: string;
}

/**
 * Normalises a state value for the comparison with a rule.
 *
 * @param value - value written on a state
 * @returns the text form without surrounding blanks
 */
export function triggerText(value: ioBroker.StateValue): string {
	return value === null ? "" : String(value).trim();
}

/**
 * Resolves the employee a value of mode `user` names.
 *
 * @param value - value written on the watched state
 * @param users - user storage
 * @returns the employee or `null` when nothing matches
 */
export function resolveTriggerUser(value: ioBroker.StateValue, users: TriggerUsers): UserRecord | null {
	const text = triggerText(value);
	if (!text) {
		return null;
	}

	if (/^\d+$/.test(text)) {
		const byId = users.findById(Number(text));
		if (byId) {
			return byId;
		}
	}

	const byLogin = users.findByLogin(text);
	if (byLogin) {
		return byLogin;
	}

	const lower = text.toLowerCase();
	return users.list().find(user => user.displayName.toLowerCase() === lower) ?? null;
}

/**
 * Decides whether a rule fires for a write and for which employee.
 *
 * @param rule - rule to check
 * @param context - value, previous value and instant of the write
 * @param users - user storage
 * @returns the decision, including the reason for the log
 */
export function evaluateTrigger(
	rule: TriggerRuleRecord,
	context: TriggerContext,
	users: TriggerUsers,
): TriggerDecision {
	const text = triggerText(context.value);
	if (!text) {
		return { fire: false, userId: null, reason: "empty value" };
	}
	if (context.previous !== null && context.previous === text) {
		return { fire: false, userId: null, reason: `value ${text} did not change` };
	}
	if (rule.cooldownSec > 0 && rule.lastFiredAt !== null && rule.lastFiredAt + rule.cooldownSec > context.now) {
		return { fire: false, userId: null, reason: `cooldown of ${rule.cooldownSec} s is still running` };
	}

	let user: UserRecord | null = null;
	if (rule.mode === "user") {
		user = resolveTriggerUser(context.value, users);
		if (!user) {
			return { fire: false, userId: null, reason: `no employee matches "${text}"` };
		}
	} else {
		if (text !== (rule.condition ?? "")) {
			return { fire: false, userId: null, reason: `value ${text} does not match ${rule.condition ?? "?"}` };
		}
		user = rule.userId === null ? null : users.findById(rule.userId);
		if (!user) {
			return { fire: false, userId: null, reason: `employee ${rule.userId ?? "?"} does not exist` };
		}
	}

	if (!user.isActive) {
		return { fire: false, userId: user.id, reason: `${user.displayName} is deactivated` };
	}

	return { fire: true, userId: user.id, reason: `${rule.action} for ${user.displayName}` };
}
