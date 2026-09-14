/// <reference types="mocha" />
import { expect } from "chai";
import { RevisionConflictError, type EntryRecord } from "../db/repositories/entries";
import { UnknownAbsenceTypeError } from "../db/repositories/absences";
import { LoginExistsError, UnknownRoleError } from "../db/repositories/users";
import { NotFoundError, ValidationError } from "../errors";
import { HttpProblem, problem, toProblem } from "./problem";

describe("web problem responses", () => {
	it("builds a problem document", () => {
		const error = problem(400, "bad_request", "date is required");

		expect(error.status).to.equal(400);
		expect(error.code).to.equal("bad_request");
		expect(error.problemTitle).to.equal("Bad Request");
		expect(error.toProblem("/reports/day")).to.deep.equal({
			type: "about:blank",
			title: "Bad Request",
			status: 400,
			code: "bad_request",
			detail: "date is required",
			instance: "/reports/day",
		});
		// without a detail the field is omitted
		expect(new HttpProblem(404, "not_found").toProblem()).to.not.have.property("detail");
	});

	it("keeps known problems as they are", () => {
		const { problem: details, unexpected } = toProblem(problem(403, "csrf_rejected", "missing"), "/punch");

		expect(unexpected).to.equal(false);
		expect(details).to.deep.include({ status: 403, code: "csrf_rejected", instance: "/punch" });
	});

	it("maps domain errors onto the matching status", () => {
		const conflictRevision = new RevisionConflictError(7, { revision: 4 } as unknown as EntryRecord);
		expect(toProblem(conflictRevision, "/time/entries/7")).to.deep.include({
			unexpected: false,
		});
		expect(toProblem(conflictRevision).problem).to.deep.include({ status: 409, code: "revision_conflict" });
		expect(toProblem(conflictRevision).problem.detail).to.contain("current revision 4");

		expect(toProblem(new LoginExistsError("anna")).problem).to.deep.include({ status: 409, code: "conflict" });
		expect(toProblem(new UnknownRoleError("boss")).problem).to.deep.include({ status: 409, code: "conflict" });
		expect(toProblem(new UnknownAbsenceTypeError("X")).problem).to.deep.include({
			status: 400,
			code: "bad_request",
		});
	});

	it("maps the typed errors of the storage layer", () => {
		expect(toProblem(new ValidationError("minutes must be a whole number and not 0")).problem).to.deep.include({
			status: 400,
			code: "bad_request",
			detail: "minutes must be a whole number and not 0",
		});
		expect(toProblem(new NotFoundError("entry 5 not found")).problem).to.deep.include({
			status: 404,
			code: "not_found",
			detail: "entry 5 not found",
		});
	});

	it("treats every other error as an internal error", () => {
		// plain errors and built-in types are never client errors, whatever their text says
		const plain = toProblem(new Error("entry 5 not found"), "/x");
		expect(plain.unexpected).to.equal(true);
		expect(plain.problem).to.deep.include({ status: 500, code: "internal_error" });

		const typed = toProblem(new TypeError("cannot read properties of undefined"));
		expect(typed.unexpected).to.equal(true);
		expect(typed.problem.status).to.equal(500);
	});

	it("masks unexpected errors", () => {
		const { problem: details, unexpected } = toProblem(new TypeError("cannot read properties of undefined"), "/x");

		expect(unexpected).to.equal(true);
		expect(details).to.deep.include({ status: 500, code: "internal_error" });
		expect(details.detail).to.equal("the request could not be processed");
		expect(JSON.stringify(details)).to.not.contain("cannot read properties");
	});
});
