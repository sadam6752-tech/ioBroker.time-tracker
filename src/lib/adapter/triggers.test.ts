/// <reference types="mocha" />
import { expect } from "chai";
import type { TriggerRuleRecord } from "../db/repositories/triggers";
import type { UserRecord } from "../db/repositories/users";
import { evaluateTrigger, isToggleCondition, resolveTriggerUser, triggerText, type TriggerUsers } from "./triggers";

/**
 * Builds a rule with sensible defaults.
 *
 * @param overrides - fields to change
 * @returns the rule
 */
function rule(overrides: Partial<TriggerRuleRecord> = {}): TriggerRuleRecord {
	return {
		id: 1,
		label: null,
		sourceState: "fingerprint.0.lastMatch",
		mode: "condition",
		condition: "1",
		userId: 2,
		action: "punch",
		isActive: true,
		cooldownSec: 0,
		lastFiredAt: null,
		...overrides,
	};
}

/**
 * Builds an employee record (only the fields the trigger logic reads).
 *
 * @param id - user id
 * @param login - login name
 * @param displayName - shown name
 * @param isActive - false for a deactivated employee
 * @returns the employee
 */
function employee(id: number, login: string, displayName: string, isActive = true): UserRecord {
	return { id, login, displayName, isActive, timezone: "Europe/Berlin" } as unknown as UserRecord;
}

/** Employee storage with two active employees and one deactivated. */
const users: TriggerUsers = {
	findById: id =>
		[employee(2, "anna", "Anna Weber"), employee(3, "bo", "Bo Schmidt", false)].find(u => u.id === id) ?? null,
	findByLogin: login =>
		[employee(2, "anna", "Anna Weber"), employee(3, "bo", "Bo Schmidt", false)].find(
			u => u.login.toLowerCase() === login.trim().toLowerCase(),
		) ?? null,
	list: () => [employee(2, "anna", "Anna Weber"), employee(3, "bo", "Bo Schmidt", false)],
};

describe("trigger rules", () => {
	it("normalises state values for the comparison", () => {
		expect(triggerText(true)).to.equal("true");
		expect(triggerText(1)).to.equal("1");
		expect(triggerText("  x  ")).to.equal("x");
		expect(triggerText(null)).to.equal("");
	});

	it("fires in mode condition only for the stored value", () => {
		const fired = evaluateTrigger(rule(), { value: 1, previous: "0", now: 1000 }, users);
		expect(fired).to.deep.equal({ fire: true, userId: 2, reason: "punch for Anna Weber" });

		expect(evaluateTrigger(rule(), { value: 0, previous: "1", now: 1000 }, users).fire).to.equal(false);
		expect(evaluateTrigger(rule(), { value: 0, previous: "1", now: 1000 }, users).reason).to.contain(
			"does not match",
		);
	});

	it("ignores a repeated value, an empty one and the cooldown window", () => {
		expect(evaluateTrigger(rule(), { value: "1", previous: "1", now: 1000 }, users).reason).to.contain(
			"did not change",
		);
		expect(evaluateTrigger(rule(), { value: "", previous: "0", now: 1000 }, users).reason).to.equal("empty value");

		const cooling = rule({ cooldownSec: 60, lastFiredAt: 1000 });
		expect(evaluateTrigger(cooling, { value: "1", previous: "0", now: 1030 }, users).reason).to.contain("cooldown");
		expect(evaluateTrigger(cooling, { value: "1", previous: "0", now: 1060 }, users).fire).to.equal(true);
	});

	it("finds the employee in mode user by id, login and name", () => {
		expect(resolveTriggerUser(2, users)?.login).to.equal("anna");
		expect(resolveTriggerUser("ANNA", users)?.id).to.equal(2);
		expect(resolveTriggerUser("anna weber", users)?.id).to.equal(2);
		expect(resolveTriggerUser("nobody", users)).to.equal(null);
		expect(resolveTriggerUser("", users)).to.equal(null);

		const byLogin = evaluateTrigger(
			rule({ mode: "user", condition: null, userId: null, action: "present" }),
			{ value: "anna", previous: null, now: 1000 },
			users,
		);
		expect(byLogin).to.deep.equal({ fire: true, userId: 2, reason: "present for Anna Weber" });
	});

	it("fires for every change when the value is toggle or a star", () => {
		expect(isToggleCondition("toggle")).to.equal(true);
		expect(isToggleCondition(" TOGGLE ")).to.equal(true);
		expect(isToggleCondition("*")).to.equal(true);
		expect(isToggleCondition("true")).to.equal(false);
		expect(isToggleCondition(null)).to.equal(false);

		// a switch that goes on and off again: both directions fire, a repeated value still does not
		const switchRule = rule({ condition: "toggle" });
		expect(evaluateTrigger(switchRule, { value: false, previous: "true", now: 1000 }, users).fire).to.equal(true);
		expect(evaluateTrigger(switchRule, { value: 1, previous: "false", now: 1000 }, users).fire).to.equal(true);
		expect(evaluateTrigger(switchRule, { value: false, previous: "false", now: 1000 }, users).reason).to.contain(
			"did not change",
		);

		// a fixed value keeps refusing the other direction
		const fixed = rule({ condition: "true" });
		expect(evaluateTrigger(fixed, { value: false, previous: "true", now: 1 }, users).fire).to.equal(false);
	});

	it("refuses an unknown or deactivated employee", () => {
		expect(
			evaluateTrigger(
				rule({ mode: "user", condition: null, userId: null }),
				{ value: "ghost", previous: null, now: 1 },
				users,
			).reason,
		).to.contain("no employee matches");

		expect(evaluateTrigger(rule({ userId: 99 }), { value: "1", previous: "0", now: 1 }, users).reason).to.contain(
			"does not exist",
		);
		expect(evaluateTrigger(rule({ userId: 3 }), { value: "1", previous: "0", now: 1 }, users).reason).to.contain(
			"deactivated",
		);
	});
});
