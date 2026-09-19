/**
 * Automation rules of the adapter.
 *
 * The adapter checks every minute whether one of the configured rules is due. This module only *decides* — the
 * adapter loads the punches and runs the decision — so the rules stay testable without ioBroker and without a
 * clock, exactly like the trigger rules.
 *
 * The three kinds:
 *  - `clockOut`: at the configured local time an employee who is still clocked in is punched out.
 *  - `missingPunch`: the same moment, but only reported — nothing is written.
 *  - `breakReminder`: an employee whose running work block reached the configured length is reminded.
 *
 * Every rule runs at most once per employee and period — a local date, or an ISO week for a weekly rule; the adapter
 * asks `automation_runs` before it acts. A rule can also be limited to certain weekdays.
 */

import type { AutomationRepeat, AutomationRuleRecord } from "../db/repositories/automations";

/** What the adapter knows about one employee at the moment of a check. */
export interface AutomationContext {
	/** Local date of the employee, e.g. `2026-09-18` */
	localDate: string;
	/** Weekday of that date, ISO counting (1 = Monday … 7 = Sunday) */
	weekday: number;
	/** Minutes since local midnight */
	minuteOfDay: number;
	/** True when the employee is clocked in */
	hasOpenEntry: boolean;
	/** Minutes of the running work block, `null` when the employee is not clocked in */
	blockMinutes: number | null;
	/** True when the rule already ran for this employee today */
	alreadyRan: boolean;
}

/** Outcome of a check. */
export interface AutomationDecision {
	/** True when the rule is due */
	fire: boolean;
	/** Why it fires or not — goes to the log and to the tests */
	reason: string;
}

/**
 * Decides whether a rule is due for one employee.
 *
 * @param rule - rule to check
 * @param context - what the adapter knows about the employee
 * @returns the decision, including the reason for the log
 */
export function evaluateAutomation(rule: AutomationRuleRecord, context: AutomationContext): AutomationDecision {
	if (!rule.isActive) {
		return { fire: false, reason: "the rule is disabled" };
	}
	if (context.alreadyRan) {
		return { fire: false, reason: "it already ran for this employee today" };
	}
	// the weekday is checked before the kind: a rule for Monday to Friday stays quiet at the weekend
	if (!rule.weekdays.includes(context.weekday)) {
		return { fire: false, reason: `the rule does not run on weekday ${context.weekday}` };
	}

	if (rule.kind === "breakReminder") {
		if (!context.hasOpenEntry) {
			return { fire: false, reason: "the employee is not clocked in" };
		}
		const length = context.blockMinutes ?? 0;
		const wanted = rule.afterMinutes ?? 0;
		return length >= wanted
			? { fire: true, reason: `working for ${length} minutes without a break` }
			: { fire: false, reason: `working for ${length} of ${wanted} minutes` };
	}

	const wanted = rule.atMinute ?? 0;
	if (context.minuteOfDay < wanted) {
		return { fire: false, reason: `waiting for minute ${wanted} of the day` };
	}
	if (!context.hasOpenEntry) {
		return { fire: false, reason: "the employee is not clocked in" };
	}
	return {
		fire: true,
		reason: rule.kind === "clockOut" ? "still clocked in, punching out" : "still clocked in",
	};
}

/**
 * Weekday of a local date in ISO counting.
 *
 * @param localDate - date as `YYYY-MM-DD`
 * @returns 1 for Monday … 7 for Sunday
 */
export function isoWeekday(localDate: string): number {
	const [year, month, day] = localDate.split("-").map(Number);
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return weekday === 0 ? 7 : weekday;
}

/**
 * ISO week of a local date, e.g. `2026-W38`.
 *
 * The week belongs to the year of its Thursday, which is what makes the turn of the year come out right.
 *
 * @param localDate - date as `YYYY-MM-DD`
 * @returns year and week
 */
export function isoWeek(localDate: string): string {
	const [year, month, day] = localDate.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	const thursday = new Date(date);
	thursday.setUTCDate(date.getUTCDate() + (4 - isoWeekday(localDate)));
	// the 4th of January is always in the first ISO week, so its Thursday is the reference point
	const januaryFourth = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const firstThursday = new Date(januaryFourth);
	firstThursday.setUTCDate(januaryFourth.getUTCDate() + (4 - isoWeekday(januaryFourth.toISOString().slice(0, 10))));
	const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
	return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Period a rule counts in.
 *
 * @param repeat - whether the rule may act once a day or once a week
 * @param localDate - date as `YYYY-MM-DD`
 * @returns the local date, or the ISO week for a weekly rule
 */
export function runPeriod(repeat: AutomationRepeat, localDate: string): string {
	return repeat === "week" ? isoWeek(localDate) : localDate;
}

/**
 * Reads the running work block of an employee from the punches of the day.
 *
 * The direction hints of the punches are used, which is what the day view shows as well; the authoritative pairing
 * of a day (and therefore the punch the adapter writes) stays with `domain/punch`. A reminder is advisory, so the
 * hint is good enough here — and an employee who is not clocked in has no block at all.
 *
 * @param punches - punches of the local day, any order
 * @param nowUtc - instant of the check, UTC epoch seconds
 * @returns true when the employee is clocked in, plus the minutes of the running block
 */
export function workBlock(
	punches: { tsUtc: number; direction: string }[],
	nowUtc: number,
): { hasOpenEntry: boolean; blockMinutes: number | null } {
	const sorted = [...punches].sort((left, right) => left.tsUtc - right.tsUtc);
	let start: number | null = null;
	for (const punch of sorted) {
		start = punch.direction === "in" ? punch.tsUtc : null;
	}
	if (start === null) {
		return { hasOpenEntry: false, blockMinutes: null };
	}
	return { hasOpenEntry: true, blockMinutes: Math.max(0, Math.floor((nowUtc - start) / 60)) };
}
