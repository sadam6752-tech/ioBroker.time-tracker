/// <reference types="mocha" />
import { expect } from "chai";
import { ValidationError } from "../../errors";
import {
	bodySchema,
	optionalFlag,
	optionalNumber,
	optionalText,
	parseBody,
	requiredFlag,
	requiredText,
} from "./validate";
import {
	optionalBoolean as readOptionalBoolean,
	optionalNumber as readOptionalNumber,
	optionalString as readOptionalString,
	requireBoolean as readRequiredBoolean,
	requireString as readRequiredString,
} from "./shared";

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
		// the same input through the old reader and through the rule must give the same message
		const cases: [Record<string, unknown>, () => unknown][] = [
			[{ login: 5 }, () => readRequiredString({ login: 5 }, "login", 8)],
			[{ login: "" }, () => readRequiredString({ login: "" }, "login", 8)],
			[{ login: "123456789" }, () => readRequiredString({ login: "123456789" }, "login", 8)],
			[{ login: "a", note: 3 }, () => readOptionalString({ note: 3 }, "note", 5)],
			[{ login: "a", note: "123456" }, () => readOptionalString({ note: "123456" }, "note", 5)],
			[{ login: "a", amount: "1" }, () => readOptionalNumber({ amount: "1" }, "amount")],
			[{ login: "a", active: "x" }, () => readRequiredBoolean({ active: "x" }, "active")],
			[{ login: "a", active: undefined }, () => readRequiredBoolean({}, "active")],
			[{ login: "a", active: true, archived: 1 }, () => readOptionalBoolean({ archived: 1 }, "archived")],
		];
		for (const [body, old] of cases) {
			const expected = failure(old).message;
			const actual = failure(() => parseBody(schema, { active: true, ...body })).message;
			expect(actual, JSON.stringify(body)).to.equal(expected);
		}
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
