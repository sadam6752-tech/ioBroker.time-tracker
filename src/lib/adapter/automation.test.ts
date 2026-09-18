/// <reference types="mocha" />
import { expect } from "chai";
import type { AutomationRuleRecord } from "../db/repositories/automations";
import { evaluateAutomation, workBlock, type AutomationContext } from "./automation";

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
