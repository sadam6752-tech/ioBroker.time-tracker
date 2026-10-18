/// <reference types="mocha" />
import { expect } from "chai";
import { createApi } from "../api";
import {
	db,
	users,
	entries,
	absences,
	dayNotes,
	holidays,
	rules,
	payouts,
	terminals,
	rfid,
	triggers,
	automations,
	aggregation,
	sync,
	auth,
	settings,
	annaId,
	adminId,
	annaToken,
	annaCsrf,
	adminToken,
	adminCsrf,
	send,
	bodyOf,
	headers,
	useApiFixture,
} from "./apiFixture.test";

describe("web api", () => {
	useApiFixture();

	describe("field validation and negative cases", () => {
		it("refuses an unknown punch direction", async () => {
			const response = await send("POST", "/punch", {
				body: { tsUtc: 1000, direction: "seitwaerts" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(response.status).to.equal(400);
			expect(bodyOf(response).detail).to.contain("direction must be in, out or auto");
		});

		it("reports invalid fields of a work profile", async () => {
			const statusOf = async (body: Record<string, unknown>): Promise<number> =>
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body,
						headers: headers(adminToken, adminCsrf),
					})
				).status;

			// the period is an instant in seconds or null, the flags are a JSON string or null
			expect(await statusOf({ startDate: "irgendwann" })).to.equal(400);
			expect(await statusOf({ holidayFlags: 5 })).to.equal(400);
			// minutes are whole numbers, a fraction never reaches the database
			expect(await statusOf({ vacationPerYear: 2.5 })).to.equal(400);
		});

		it("refuses settings that cannot be changed and takes structured ones", async () => {
			const unknown = await send("PUT", "/settings", {
				body: { gibt_es_nicht: 1 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(unknown.status).to.equal(400);
			expect(bodyOf(unknown).detail).to.contain("cannot be changed through the API");

			const empty = await send("PUT", "/settings", { body: {}, headers: headers(adminToken, adminCsrf) });
			expect(empty.status).to.equal(400);
			expect(bodyOf(empty).detail).to.equal("no settings given");

			const color = await send("PUT", "/settings", {
				body: { brand_color: "rot" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(color.status).to.equal(400);
			expect(bodyOf(color).detail).to.contain("hex colour");

			// `pause_staffel` is a JSON setting: a list of objects is its shape, a bare number is not
			const list = await send("PUT", "/settings", {
				body: { pause_staffel: [{ fromMin: 360, pauseMin: 30 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(list.status).to.equal(200);
			expect(bodyOf<{ settings: Record<string, unknown> }>(list).settings.pause_staffel).to.deep.equal([
				{ fromMin: 360, pauseMin: 30 },
			]);
		});

		it("protects the picture route and reports a missing picture", async () => {
			// the kiosk and the presence screen have no user session: they authenticate with the device token
			expect((await send("GET", `/users/${annaId}/avatar`)).status).to.equal(401);
			expect(
				(await send("GET", `/users/${annaId}/avatar`, { query: { terminalSession: "quatsch" } })).status,
			).to.equal(401);

			// a signed in user without a picture gets 404 instead of an empty image
			const missing = await send("GET", `/users/${annaId}/avatar`, { headers: headers(annaToken) });
			expect(missing.status).to.equal(404);
			expect(bodyOf(missing).detail).to.contain("has no picture");
		});

		it("refuses a picture that is not a data URL and a missing switch", async () => {
			const broken = await send("PATCH", `/users/${annaId}`, {
				body: { avatar: "kein-data-url", reason: "Test" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("data URL");

			// `mustChangePw` is a switch: a string is not a value at all, `null` is no value either
			const flag = await send("PATCH", `/users/${annaId}`, {
				body: { mustChangePw: "vielleicht", reason: "Test" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(flag.status).to.equal(400);
			expect(bodyOf(flag).detail).to.contain("mustChangePw must be a boolean");

			const nothing = await send("PATCH", `/users/${annaId}`, {
				body: { mustChangePw: null, reason: "Test" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(nothing.status).to.equal(400);
			expect(bodyOf(nothing).detail).to.contain("mustChangePw is required");
		});

		it("refuses a foreign absence and reports a missing one", async () => {
			const foreign = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-08-03", userId: adminId },
				headers: headers(adminToken, adminCsrf),
			});
			expect(foreign.status).to.equal(201);
			const absenceId = bodyOf<{ absence: { id: number } }>(foreign).absence.id;

			// an employee may request for their own account, not for somebody else's
			const denied = await send("PATCH", `/absences/${absenceId}`, {
				body: { note: "geht mich nichts an" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);
			expect(bodyOf(denied).code).to.equal("permission_denied");

			const missing = await send("PATCH", "/absences/999999", {
				body: { note: "gibt es nicht" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(missing.status).to.equal(404);
		});

		it("reports a payout query with a broken employee id", async () => {
			const broken = await send("GET", "/payouts", { headers: headers(adminToken), query: { userId: "anna" } });
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("userId must be a whole number");
		});

		it("refuses a tag link for an unknown employee and a broken lifetime", async () => {
			const unknown = await send("POST", "/rfid/tags", {
				body: { userId: 999 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(unknown.status).to.equal(400);
			expect(bodyOf(unknown).detail).to.contain("must reference an existing employee");

			const broken = await send("POST", "/rfid/tags", {
				body: { ttlDays: 0 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("positive whole number");
		});

		it("refuses a tag link when no HMAC secret is configured", async () => {
			// without the secret the links cannot be signed: the route says so instead of writing a broken tag
			const withoutSecret = createApi({
				db,
				auth,
				users,
				entries,
				absences,
				dayNotes,
				holidays,
				rules,
				payouts,
				terminals,
				rfid,
				triggers,
				automations,
				aggregation,
				sync,
				settings,
				kioskEnabled: true,
				now: () => 1000,
				version: "9.9.9",
			});
			const response = await withoutSecret.router.handle({
				method: "POST",
				path: "/rfid/tags",
				headers: {
					"content-type": "application/json",
					"x-session-token": adminToken,
					"x-csrf-token": adminCsrf,
				},
				body: JSON.stringify({}),
				remoteAddress: "127.0.0.1",
			});
			expect(response.status).to.equal(403);
			expect(bodyOf(response).code).to.equal("not_configured");
		});
	});

	describe("rate limits and field errors", () => {
		it("answers too many requests with 429 and a retry-after header", async () => {
			// `/rfid/scan` allows 30 scans per minute and client; a bad token still counts
			let last = 0;
			for (let attempt = 1; attempt <= 30; attempt++) {
				const response = await send("POST", "/rfid/scan", { body: { token: "quatsch" } });
				expect(response.status, `attempt ${attempt}`).to.equal(400);
				last = response.status;
			}
			expect(last).to.equal(400);

			const blocked = await send("POST", "/rfid/scan", { body: { token: "quatsch" } });
			expect(blocked.status).to.equal(429);
			expect(bodyOf(blocked)).to.deep.include({ status: 429, code: "rate_limited" });
			expect(Number(blocked.headers["retry-after"])).to.be.greaterThan(0);

			// another route class of the same client is not affected by the counting
			const otherClass = await send("POST", "/terminal/session", { body: { deviceToken: "egal" } });
			expect(otherClass.status).to.equal(401);
		});

		it("reports invalid fields of a request in errors[]", async () => {
			const response = await send("PUT", `/users/${annaId}/profile`, {
				body: { percent: 130, workdays: "1;9", overtimeModel: "taeglich", unbekannt: 1 },
				headers: headers(adminToken, adminCsrf),
			});

			expect(response.status).to.equal(400);
			const problem = bodyOf<{
				code: string;
				detail: string;
				errors?: { path: string; message: string }[];
			}>(response);
			expect(problem.code).to.equal("bad_request");
			expect(problem.detail).to.equal("4 field(s) of the work profile are not valid");
			expect(problem.errors?.map(issue => issue.path).sort()).to.deep.equal([
				"overtimeModel",
				"percent",
				"unbekannt",
				"workdays",
			]);
			expect(problem.errors?.find(issue => issue.path === "percent")?.message).to.contain("between 0 and 100");

			// a valid request carries no `errors[]` at all
			const ok = await send("PUT", `/users/${annaId}/profile`, {
				body: { percent: 80 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(ok.status).to.equal(200);
		});
	});
});
