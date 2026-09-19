/// <reference types="mocha" />
import { expect } from "chai";
import type { AutomationRuleRecord } from "../db/repositories/automations";
import { evaluateAutomation, isoWeek, isoWeekday, runPeriod, workBlock, type AutomationContext } from "./automation";

/**
 * Builds a rule with sensible defaults.
 *
 * @param overrides - fields to change
 * @returns the rule
 */
function rule(overrides: Partial<AutomationRuleRecord> = {}): AutomationRuleRecord {
	return {
		id: 1,
		label: null,
		kind: "clockOut",
		userId: null,
		atMinute: 1200,
		afterMinutes: null,
		weekdays: [1, 2, 3, 4, 5, 6, 7],
		repeat: "day",
		isActive: true,
		...overrides,
	};
}

/**
 * Builds the context of a check.
 *
 * @param overrides - fields to change
 * @returns the context
 */
function context(overrides: Partial<AutomationContext> = {}): AutomationContext {
	return {
		localDate: "2026-09-18",
		// the 18th of September 2026 is a Friday
		weekday: 5,
		minuteOfDay: 1200,
		hasOpenEntry: true,
		blockMinutes: 480,
		alreadyRan: false,
		...overrides,
	};
}

describe("automation rules", () => {
	it("punches out at the configured time and reports the kind", () => {
		expect(evaluateAutomation(rule(), context())).to.deep.equal({
			fire: true,
			reason: "still clocked in, punching out",
		});
		expect(evaluateAutomation(rule({ kind: "missingPunch" }), context()).reason).to.equal("still clocked in");

		// before the minute has arrived nothing happens
		expect(evaluateAutomation(rule(), context({ minuteOfDay: 1199 })).reason).to.contain("waiting for minute 1200");
	});

	it("reminds after a long work block", () => {
		const reminder = rule({ kind: "breakReminder", atMinute: null, afterMinutes: 360 });
		expect(evaluateAutomation(reminder, context({ blockMinutes: 360 })).fire).to.equal(true);
		expect(evaluateAutomation(reminder, context({ blockMinutes: 359 })).reason).to.contain(
			"working for 359 of 360",
		);
	});

	it("keeps quiet when the employee is not clocked in, the rule already ran or is disabled", () => {
		expect(evaluateAutomation(rule(), context({ hasOpenEntry: false })).reason).to.equal(
			"the employee is not clocked in",
		);
		expect(evaluateAutomation(rule(), context({ alreadyRan: true })).reason).to.contain("already ran");
		expect(evaluateAutomation(rule({ isActive: false }), context()).reason).to.equal("the rule is disabled");
		expect(
			evaluateAutomation(
				rule({ kind: "breakReminder", atMinute: null, afterMinutes: 60 }),
				context({ hasOpenEntry: false }),
			).fire,
		).to.equal(false);
	});

	it("reads the running work block from the punches of the day", () => {
		const start = 1000;
		expect(workBlock([{ tsUtc: start, direction: "in" }], start + 90 * 60)).to.deep.equal({
			hasOpenEntry: true,
			blockMinutes: 90,
		});

		// a break ends the block, the next in starts a new one
		expect(
			workBlock(
				[
					{ tsUtc: start, direction: "in" },
					{ tsUtc: start + 3600, direction: "out" },
					{ tsUtc: start + 4200, direction: "in" },
				],
				start + 4200 + 30 * 60,
			),
		).to.deep.equal({ hasOpenEntry: true, blockMinutes: 30 });

		// after the last out nobody is clocked in
		expect(
			workBlock(
				[
					{ tsUtc: start, direction: "in" },
					{ tsUtc: start + 60, direction: "out" },
				],
				start + 120,
			),
		).to.deep.equal({ hasOpenEntry: false, blockMinutes: null });
		expect(workBlock([], start)).to.deep.equal({ hasOpenEntry: false, blockMinutes: null });
	});
});

describe("weekdays and periods of an automation rule", () => {
	it("keeps quiet on a weekday the rule does not name", () => {
		// the 19th of September 2026 is a Saturday
		const saturday: Partial<AutomationContext> = { localDate: "2026-09-19", weekday: 6 };
		const workdays = rule({ weekdays: [1, 2, 3, 4, 5] });
		const decision = evaluateAutomation(workdays, context(saturday));
		expect(decision.fire).to.equal(false);
		expect(decision.reason).to.contain("weekday 6");
		expect(evaluateAutomation(rule({ weekdays: [6] }), context(saturday)).fire).to.equal(true);
	});

	it("counts weekdays in ISO order", () => {
		expect(isoWeekday("2026-09-18")).to.equal(5);
		expect(isoWeekday("2026-09-19")).to.equal(6);
		expect(isoWeekday("2026-09-20")).to.equal(7);
		expect(isoWeekday("2026-09-21")).to.equal(1);
	});

	it("names the ISO week of a date", () => {
		expect(isoWeek("2026-09-18")).to.equal("2026-W38");
		expect(isoWeek("2026-01-01")).to.equal("2026-W01");
		// the turn of the year: the 1st of January 2027 belongs to the last week of 2026
		expect(isoWeek("2027-01-01")).to.equal("2026-W53");
	});

	it("guards a daily rule by date and a weekly one by week", () => {
		expect(runPeriod("day", "2026-09-18")).to.equal("2026-09-18");
		expect(runPeriod("week", "2026-09-18")).to.equal("2026-W38");
		expect(runPeriod("week", "2026-09-19")).to.equal("2026-W38");
	});
});
