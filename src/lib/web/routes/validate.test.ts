/// <reference types="mocha" />
import { expect } from "chai";
import { ValidationError } from "../../errors";
import {
	bodySchema,
	check,
	employeeRef,
	type FieldRule,
	lenientText,
	numberish,
	numberishList,
	requiredNumber,
	keepMissing,
	optionalChoice,
	optionalFlag,
	optionalIdList,
	optionalMonth,
	optionalNumber,
	optionalText,
	optionalTextList,
	parseBody,
	punchDirection,
	requiredChoice,
	requiredFlag,
	requiredText,
	year,
} from "./validate";

/**
 * Runs a function and returns the validation error it throws.
 *
 * @param run - function under test
 * @returns the thrown error
 */
function failure(run: () => unknown): ValidationError {
	try {
		run();
	} catch (error) {
		expect(error).to.be.instanceOf(ValidationError);
		return error as ValidationError;
	}
	throw new Error("expected a validation error");
}

describe("request body checks (zod)", () => {
	const schema = bodySchema({
		login: requiredText(8),
		note: optionalText(5),
		amount: optionalNumber(),
		active: requiredFlag(),
		archived: optionalFlag(),
	});

	it("returns trimmed, normalised values and ignores unknown fields", () => {
		expect(parseBody(schema, { login: "  anna ", note: "  ", active: false, extra: 1 })).to.deep.equal({
			login: "anna",
			note: null,
			amount: null,
			active: false,
			archived: null,
		});
		expect(parseBody(schema, { login: "a", note: " hi ", amount: 2.5, active: true, archived: null })).to.include({
			note: "hi",
			amount: 2.5,
			archived: null,
		});
	});

	it("reports every invalid field and leads with the first one", () => {
		const error = failure(() => parseBody(schema, { login: " ", amount: "3", active: "yes" }));
		expect(error.message).to.equal("login is required");
		expect(error.fields.map(issue => issue.path)).to.deep.equal(["login", "amount", "active"]);
	});

	it("words every message as the hand-written readers did", () => {
		// the wording of the readers the rules replaced: clients and tests rely on it
		const cases: [Record<string, unknown>, string][] = [
			[{ login: 5 }, "login is required"],
			[{ login: "" }, "login is required"],
			[{ login: "123456789" }, "login is too long (at most 8 characters)"],
			[{ login: "a", note: 3 }, "note must be a string"],
			[{ login: "a", note: "123456" }, "note is too long (at most 5 characters)"],
			[{ login: "a", amount: "1" }, "amount must be a number"],
			[{ login: "a", active: "x" }, "active must be a boolean"],
			[{ login: "a", active: undefined }, "active is required"],
			[{ login: "a", active: true, archived: 1 }, "archived must be a boolean"],
		];
		for (const [body, expected] of cases) {
			expect(failure(() => parseBody(schema, { active: true, ...body })).message, JSON.stringify(body)).to.equal(
				expected,
			);
		}
	});

	it("checks choices, ids, years, months, lists and fields that were not sent", () => {
		const rules = bodySchema({
			action: requiredChoice(["accept", "dismiss"]),
			status: optionalChoice(["taken", "planned"]),
			direction: punchDirection(),
			userId: employeeRef({ nullIsMissing: true }),
			year: year(),
			month: optionalMonth(),
			userIds: optionalIdList(),
			roleKeys: optionalTextList(),
			label: keepMissing(optionalText()),
			ttlDays: check(
				optionalNumber(),
				value => value === null || value > 0,
				(field, value) => `${field} must be positive (got ${value})`,
			),
		});
		const ok = parseBody(rules, {
			action: "accept",
			direction: " out ",
			userId: "7",
			year: "2026",
			month: "",
			userIds: [3, 3, 4],
			roleKeys: [" admin ", ""],
		});
		expect(ok).to.deep.equal({
			action: "accept",
			status: null,
			direction: "out",
			userId: 7,
			year: 2026,
			month: null,
			userIds: [3, 4],
			roleKeys: ["admin"],
			ttlDays: null,
		});
		expect(ok.label).to.equal(undefined);
		// `null` is a value that was sent: it clears the label, a missing label keeps it
		expect(parseBody(rules, { action: "dismiss", year: 2026, label: null }).label).to.equal(null);

		const error = failure(() =>
			parseBody(rules, {
				action: "maybe",
				status: "lost",
				direction: "sideways",
				userId: "x",
				year: 1999,
				month: 13,
				userIds: [1, "2"],
				roleKeys: "admin",
				label: 4,
				ttlDays: -1,
			}),
		);
		expect(error.fields.map(issue => issue.message)).to.deep.equal([
			"action must be accept or dismiss (got maybe)",
			"status must be taken or planned (got lost)",
			"direction must be in, out or auto (got sideways)",
			"userId must reference an existing employee",
			"year must be a four digit year between 2000 and 2100 (got 1999)",
			"month must be between 1 and 12 (got 13)",
			"userIds must be an array of whole numbers",
			"roleKeys must be an array of strings",
			"label must be a string",
			"ttlDays must be positive (got -1)",
		]);
	});

	it("knows what a field that was not sent means for every rule", () => {
		// zod refuses a missing key for some kinds of schema; every rule must decide it on its own
		const missing = (rule: FieldRule): { ok: boolean; value: unknown; message?: string } => {
			const result = bodySchema({ f: rule }).safeParse({});
			return result.success
				? { ok: true, value: (result.data as { f?: unknown }).f }
				: { ok: false, value: undefined, message: result.error.issues[0]?.message };
		};
		expect(missing(optionalText())).to.deep.equal({ ok: true, value: null });
		expect(missing(optionalNumber())).to.deep.equal({ ok: true, value: null });
		expect(missing(optionalFlag())).to.deep.equal({ ok: true, value: null });
		expect(missing(punchDirection())).to.deep.equal({ ok: true, value: "auto" });
		expect(missing(optionalChoice(["a", "b"]))).to.deep.equal({ ok: true, value: null });
		expect(missing(lenientText())).to.deep.equal({ ok: true, value: "" });
		expect(missing(keepMissing(optionalText()))).to.deep.equal({ ok: true, value: undefined });
		expect(missing(employeeRef())).to.deep.equal({ ok: true, value: undefined });
		expect(missing(optionalMonth())).to.deep.equal({ ok: true, value: null });
		expect(missing(optionalIdList())).to.deep.equal({ ok: true, value: null });
		expect(missing(optionalTextList())).to.deep.equal({ ok: true, value: null });
		expect(missing(numberishList())).to.deep.equal({ ok: true, value: undefined });
		expect(Number.isNaN(missing(numberish()).value)).to.equal(true);
		expect(missing(requiredText()).message).to.equal("f is required");
		expect(missing(requiredNumber()).message).to.equal("f is required");
		expect(missing(requiredFlag()).message).to.equal("f is required");
		expect(missing(requiredChoice(["a", "b"])).message).to.equal("f is required");
		expect(missing(year()).message).to.equal("f must be a four digit year between 2000 and 2100 (got undefined)");
	});

	it("writes nested paths the way the API reports them", () => {
		const nested = bodySchema({
			entries: () =>
				// a nested list keeps its own field names
				bodySchema({ tsUtc: optionalNumber() }).array(),
		});
		const error = failure(() => parseBody(nested, { entries: [{ tsUtc: 1 }, { tsUtc: "x" }] }));
		expect(error.fields[0]?.path).to.equal("entries[1].tsUtc");
	});
});
