/// <reference types="mocha" />
import { expect } from "chai";
import {
	users,
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

	describe("absences", () => {
		it("creates and lists absences", async () => {
			const created = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-07-06", dateTo: "2026-07-10", status: "planned" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(created.status).to.equal(201);
			const absence = bodyOf<{ absence: { id: number; status: string; dayPortion: number } }>(created).absence;
			expect(absence).to.deep.include({ status: "planned", dayPortion: 1 });
			expect(created.headers.location).to.equal(`/absences/${absence.id}`);

			const listed = await send("GET", "/absences", { headers: headers(annaToken), query: { year: "2026" } });
			expect(bodyOf<{ absences: unknown[] }>(listed).absences).to.have.lengthOf(1);

			const invalidDate = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "06.07.2026" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(invalidDate.status).to.equal(400);

			const unknownType = await send("POST", "/absences", {
				body: { typeCode: "X", dateFrom: "2026-07-06" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(unknownType.status).to.equal(400);
			expect(bodyOf(unknownType).detail).to.contain("unknown absence type");
		});

		it("lets an administrator approve an absence", async () => {
			const created = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-07-06" },
				headers: headers(annaToken, annaCsrf),
			});
			const absenceId = bodyOf<{ absence: { id: number } }>(created).absence.id;

			// the employee may request, but not approve
			const denied = await send("POST", `/absences/${absenceId}/status`, {
				body: { status: "taken" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			const approved = await send("POST", `/absences/${absenceId}/status`, {
				body: { status: "taken" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(approved.status).to.equal(200);
			expect(bodyOf<{ absence: { status: string } }>(approved).absence.status).to.equal("taken");
		});

		it("carries a request through the decision of the administration", async () => {
			// an employee requests: the answer names the request as such
			const created = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-08-10", dateTo: "2026-08-14" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(created.status).to.equal(201);
			const requested = bodyOf<{ absence: { id: number; approval: string; decidedAt: number | null } }>(created);
			expect(requested.absence.approval).to.equal("requested");
			expect(requested.absence.decidedAt).to.equal(null);

			// the administration finds it in its overview
			const overview = await send("GET", "/absences", {
				query: { scope: "all", from: "2026-08-01", to: "2026-08-31" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(overview.status).to.equal(200);
			const seen = bodyOf<{ absences: { id: number; userId: number; approval: string }[] }>(overview).absences;
			expect(seen.some(absence => absence.id === requested.absence.id)).to.equal(true);
			expect(seen.every(absence => typeof absence.approval === "string")).to.equal(true);

			// the employee may not decide about the own request
			const denied = await send("POST", `/absences/${requested.absence.id}/approval`, {
				body: { approval: "approved" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			// the administration rejects it and hands the reason over
			const rejected = await send("POST", `/absences/${requested.absence.id}/approval`, {
				body: { approval: "rejected", note: "Betriebsferien" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(rejected.status).to.equal(200);
			const decided = bodyOf<{ absence: { approval: string; decisionNote: string; decidedAt: number } }>(
				rejected,
			);
			expect(decided.absence.approval).to.equal("rejected");
			expect(decided.absence.decisionNote).to.equal("Betriebsferien");
			expect(decided.absence.decidedAt).to.be.a("number");

			// an unknown decision is refused
			const invalid = await send("POST", `/absences/${requested.absence.id}/approval`, {
				body: { approval: "vielleicht" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(invalid.status).to.equal(400);
			expect(bodyOf(invalid).detail).to.contain("approval must be requested, approved or rejected");
		});

		it("carries a cancellation of an approved absence through the decision", async () => {
			// the administration books the days: they count right away, so the employee cannot cancel them alone
			const created = await send("POST", "/absences", {
				body: { userId: annaId, typeCode: "F", dateFrom: "2026-10-05", dateTo: "2026-10-09" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const booked = bodyOf<{ absence: { id: number; approval: string } }>(created).absence;
			expect(booked.approval).to.equal("approved");

			const asked = await send("POST", `/absences/${booked.id}/cancellation`, {
				body: { note: "Doch lieber im November" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(asked.status).to.equal(200);
			const pending = bodyOf<{
				absence: { approval: string; cancelRequestedAt: number; cancelNote: string };
			}>(asked).absence;
			expect(pending.approval).to.equal("approved");
			expect(pending.cancelRequestedAt).to.be.a("number");
			expect(pending.cancelNote).to.equal("Doch lieber im November");

			// deciding about the cancellation needs the permission of the administration
			const denied = await send("POST", `/absences/${booked.id}/cancellation/decline`, {
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			// the employee takes the request back …
			const withdrawn = await send("DELETE", `/absences/${booked.id}/cancellation`, {
				headers: headers(annaToken, annaCsrf),
			});
			expect(withdrawn.status).to.equal(200);
			expect(
				bodyOf<{ absence: { cancelRequestedAt: number | null } }>(withdrawn).absence.cancelRequestedAt,
			).to.equal(null);

			// … asks again, and this time the administration declines: the days stay booked
			await send("POST", `/absences/${booked.id}/cancellation`, { headers: headers(annaToken, annaCsrf) });
			const declined = await send("POST", `/absences/${booked.id}/cancellation/decline`, {
				body: { note: "Betriebsferien" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(declined.status).to.equal(200);
			expect(
				bodyOf<{ absence: { cancelRequestedAt: number | null } }>(declined).absence.cancelRequestedAt,
			).to.equal(null);

			// a request of the employee is withdrawn instead — the server says so
			const requested = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-11-02" },
				headers: headers(annaToken, annaCsrf),
			});
			const requestId = bodyOf<{ absence: { id: number } }>(requested).absence.id;
			const tooEarly = await send("POST", `/absences/${requestId}/cancellation`, {
				headers: headers(annaToken, annaCsrf),
			});
			expect(tooEarly.status).to.equal(400);
			expect(bodyOf(tooEarly).detail).to.contain("only an approved absence can be cancelled");
		});

		it("removes an unused absence type and lists the inactive ones for the administration", async () => {
			// the administration creates a type and switches it off: employees do not see it any more
			const created = await send("POST", "/absence-types", {
				body: { code: "S", name: "Sabbatical", isActive: false },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const typeId = bodyOf<{ type: { id: number } }>(created).type.id;

			const forEmployee = await send("GET", "/absence-types", { headers: headers(annaToken, annaCsrf) });
			const hidden = bodyOf<{ types: { id: number }[] }>(forEmployee).types;
			expect(hidden.some(type => type.id === typeId)).to.equal(false);

			const forAdmin = await send("GET", "/absence-types", {
				query: { includeInactive: "true" },
				headers: headers(adminToken, adminCsrf),
			});
			const seen = bodyOf<{ types: { id: number; isActive: boolean }[] }>(forAdmin).types;
			expect(seen.some(type => type.id === typeId && type.isActive === false)).to.equal(true);

			// an employee may not remove a type
			const denied = await send("DELETE", `/absence-types/${typeId}`, { headers: headers(annaToken, annaCsrf) });
			expect(denied.status).to.equal(403);

			const removed = await send("DELETE", `/absence-types/${typeId}`, {
				headers: headers(adminToken, adminCsrf),
			});
			expect(removed.status).to.equal(204);
			const gone = await send("GET", "/absence-types", {
				query: { includeInactive: "true" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(bodyOf<{ types: { id: number }[] }>(gone).types.some(type => type.id === typeId)).to.equal(false);
		});

		it("lets an employee request only the types that are visible for everybody", async () => {
			// “K” (sickness) belongs to the administration: an employee neither sees nor requests it
			const own = await send("GET", "/absence-types", { headers: headers(annaToken, annaCsrf) });
			const visible = bodyOf<{ types: { code: string }[] }>(own).types.map(type => type.code);
			expect(visible).to.not.include("K");
			expect(visible).to.include("F");

			const denied = await send("POST", "/absences", {
				body: { typeCode: "K", dateFrom: "2026-09-15" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);
			expect(bodyOf(denied).detail).to.contain("absence type is not public");

			// the administration books the sickness herself
			const booked = await send("POST", "/absences", {
				body: { userId: annaId, typeCode: "K", dateFrom: "2026-09-15" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(booked.status).to.equal(201);
			expect(bodyOf<{ absence: { typeCode: string } }>(booked).absence.typeCode).to.equal("K");
		});

		it("serves the calendar feed of an employee and rotates its token", async () => {
			// the test clock sits at 1970, and the feed looks a year back and to the end of next year
			const requested = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "1970-03-02", dateTo: "1970-03-05" },
				headers: headers(annaToken, annaCsrf),
			});
			const absenceId = bodyOf<{ absence: { id: number } }>(requested).absence.id;

			// the employee asks for her subscription link
			const created = await send("POST", "/calendar/token", { body: {}, headers: headers(annaToken, annaCsrf) });
			expect(created.status).to.equal(200);
			const token = bodyOf<{ token: string }>(created).token;
			expect(token).to.be.a("string");
			expect(token.length).to.be.greaterThan(20);

			// asking again keeps the token, rotating replaces it
			const kept = bodyOf<{ token: string }>(
				await send("POST", "/calendar/token", { body: {}, headers: headers(annaToken, annaCsrf) }),
			).token;
			expect(kept).to.equal(token);
			const rotated = bodyOf<{ token: string }>(
				await send("POST", "/calendar/token", {
					body: { rotate: true },
					headers: headers(annaToken, annaCsrf),
				}),
			).token;
			expect(rotated).to.not.equal(token);

			// the old link is dead, the new one works without a session
			expect((await send("GET", "/calendar.ics", { query: { token } })).status).to.equal(401);

			const feed = await send("GET", "/calendar.ics", { query: { token: rotated } });
			expect(feed.status).to.equal(200);
			expect(feed.headers["content-type"]).to.contain("text/calendar");
			const document = feed.body.toString();
			expect(document).to.contain("BEGIN:VCALENDAR");
			expect(document).to.contain(`UID:absence-${absenceId}@time-tracker`);
			// DTEND is exclusive, so the day after the last one ends the event
			expect(document).to.contain("DTSTART;VALUE=DATE:19700302");
			expect(document).to.contain("DTEND;VALUE=DATE:19700306");
			// a request that waits for its decision stays tentative
			expect(document).to.contain("STATUS:TENTATIVE");
			expect(document).to.contain("SUMMARY:Vacation (F)");

			// a token nobody owns opens nothing
			expect((await send("GET", "/calendar.ics", { query: { token: "nope" } })).status).to.equal(401);
		});

		it("serves the calendar of the whole company with the token of the instance", async () => {
			// two employees with different types, so the feed has to bring both together and name them
			const first = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "1970-03-02", dateTo: "1970-03-05", userId: annaId },
				headers: headers(adminToken, adminCsrf),
			});
			expect(first.status, bodyOf<{ detail?: string }>(first).detail ?? "").to.equal(201);
			const second = await send("POST", "/absences", {
				body: { typeCode: "W", dateFrom: "1970-04-06", dateTo: "1970-04-06", userId: adminId },
				headers: headers(adminToken, adminCsrf),
			});
			expect(second.status, bodyOf<{ detail?: string }>(second).detail ?? "").to.equal(201);

			// without the token of the instance there is no company calendar at all
			expect((await send("GET", "/calendar.ics", { query: { token: "" } })).status).to.equal(401);

			// the command state of the adapter creates it; here the setting is written directly
			settings.set("calendar_token", "company-token", adminId);

			const feed = await send("GET", "/calendar.ics", { query: { token: "company-token" } });
			expect(feed.status).to.equal(200);
			const document = feed.body.toString();
			expect(document).to.contain("X-WR-CALNAME:Absences (Company)");
			// both employees are in one document and the company calendar says who is away
			expect(document).to.contain("SUMMARY:Anna: Vacation (F)");
			expect(document).to.contain("SUMMARY:Admin: Further training (W)");
			expect((document.match(/BEGIN:VEVENT/g) ?? []).length).to.equal(2);

			// the personal link of an employee keeps showing only that employee
			const own = bodyOf<{ token: string }>(
				await send("POST", "/calendar/token", { body: {}, headers: headers(annaToken, annaCsrf) }),
			).token;
			const personal = (await send("GET", "/calendar.ics", { query: { token: own } })).body.toString();
			expect(personal).to.contain("SUMMARY:Vacation (F)");
			expect(personal).to.not.contain("Further training");
			// the calendars are named in the language of their owner: the employee (English until it is changed) and
			// the instance
			expect(personal).to.contain("X-WR-CALNAME:Absences Anna");
			users.update({ id: annaId, patch: { locale: "de-DE" }, actorId: adminId });
			const german = (await send("GET", "/calendar.ics", { query: { token: own } })).body.toString();
			expect(german).to.contain("X-WR-CALNAME:Abwesenheiten Anna");
			settings.set("default_language", "fr", adminId);
			const french = (await send("GET", "/calendar.ics", { query: { token: "company-token" } })).body.toString();
			expect(french).to.contain("X-WR-CALNAME:Absences (entreprise)");

			// a replaced token makes the old link useless at once
			settings.set("calendar_token", "company-token-2", adminId);
			expect((await send("GET", "/calendar.ics", { query: { token: "company-token" } })).status).to.equal(401);
			expect((await send("GET", "/calendar.ics", { query: { token: "company-token-2" } })).status).to.equal(200);
		});

		it("carries the colour of an absence type and refuses a broken one", async () => {
			const created = await send("POST", "/absence-types", {
				body: { code: "S", name: "Sabbatical", color: "#123456" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			expect(bodyOf<{ type: { color: string } }>(created).type.color).to.equal("#123456");

			const broken = await send("POST", "/absence-types", {
				body: { code: "S", name: "Sabbatical", color: "rot" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("color must be a hex value");
		});
	});
});
