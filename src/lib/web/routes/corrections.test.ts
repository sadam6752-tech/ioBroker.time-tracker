/// <reference types="mocha" />
import { expect } from "chai";
import {
	db,
	entries,
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

	describe("day notes", () => {
		it("lets an employee comment his day and the administration handle it", async () => {
			// the employee leaves a message instead of changing a time
			const saved = await send("PUT", "/day-notes", {
				body: { note: "Habe vergessen auszustempeln" },
				headers: headers(annaToken, annaCsrf),
				query: { date: "2026-01-07" },
			});
			expect(saved.status).to.equal(200);
			expect(
				bodyOf<{ note: { note: string; userId: number; handledAt: number | null } }>(saved).note,
			).to.deep.include({ note: "Habe vergessen auszustempeln", userId: annaId, handledAt: null });

			const listed = await send("GET", "/day-notes", {
				headers: headers(annaToken),
				query: { from: "2026-01-01", to: "2026-01-31" },
			});
			expect(listed.status).to.equal(200);
			expect(bodyOf<{ notes: { localDate: string }[] }>(listed).notes.map(note => note.localDate)).to.deep.equal([
				"2026-01-07",
			]);

			// the administration reads the note of the employee …
			const asAdmin = await send("GET", "/day-notes", {
				headers: headers(adminToken),
				query: { from: "2026-01-01", to: "2026-01-31", userId: String(annaId) },
			});
			expect(asAdmin.status).to.equal(200);
			expect(bodyOf<{ notes: unknown[] }>(asAdmin).notes).to.have.lengthOf(1);

			// … marks it as handled (and can open it again)
			const handled = await send("POST", "/day-notes/handled", {
				body: { handled: true },
				headers: headers(adminToken, adminCsrf),
				query: { date: "2026-01-07", userId: String(annaId) },
			});
			expect(handled.status).to.equal(200);
			expect(
				bodyOf<{ note: { handledAt: number | null; handledBy: number | null } }>(handled).note,
			).to.deep.include({ handledBy: adminId });
			expect(bodyOf<{ note: { handledAt: number | null } }>(handled).note.handledAt).to.be.a("number");

			// an empty text is how the note is taken back
			const cleared = await send("PUT", "/day-notes", {
				body: { note: "" },
				headers: headers(annaToken, annaCsrf),
				query: { date: "2026-01-07" },
			});
			expect(cleared.status).to.equal(200);
			expect(bodyOf<{ note: unknown }>(cleared).note).to.equal(null);
		});

		it("refuses a note for somebody else without the administration right", async () => {
			const denied = await send("PUT", "/day-notes", {
				body: { note: "fremd" },
				headers: headers(annaToken, annaCsrf),
				query: { date: "2026-01-07", userId: String(adminId) },
			});
			expect(denied.status).to.equal(403);
			expect(bodyOf<{ code: string }>(denied).code).to.equal("permission_denied");

			// reading the queue of somebody else is refused as well
			const read = await send("GET", "/day-notes", {
				headers: headers(annaToken),
				query: { from: "2026-01-01", to: "2026-01-31", userId: String(adminId) },
			});
			expect(read.status).to.equal(403);
		});
	});

	describe("corrections", () => {
		it("corrects a punch with optimistic locking", async () => {
			const created = await send("POST", "/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			const entry = bodyOf<{ entry: { id: number; revision: number } }>(created).entry;

			// the employee comments his punch, the time itself is booked by the administration
			const commented = await send("PATCH", `/entries/${entry.id}`, {
				body: { revision: entry.revision, note: "habe vergessen auszustempeln" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(commented.status).to.equal(200);
			expect(
				bodyOf<{ entry: { tsUtc: number; revision: number; note: string } }>(commented).entry,
			).to.deep.include({
				tsUtc: 1000,
				revision: 2,
				note: "habe vergessen auszustempeln",
			});

			const movedByEmployee = await send("PATCH", `/entries/${entry.id}`, {
				body: { revision: 2, tsUtc: 700 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(movedByEmployee.status).to.equal(403);
			expect(bodyOf<{ code: string }>(movedByEmployee).code).to.equal("permission_denied");

			const updated = await send("PATCH", `/entries/${entry.id}`, {
				body: { revision: 2, tsUtc: 700, note: "korrigiert", reason: "vertippt" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(updated.status).to.equal(200);
			expect(bodyOf<{ entry: { tsUtc: number; revision: number; note: string } }>(updated).entry).to.deep.include(
				{
					tsUtc: 700,
					revision: 3,
					note: "korrigiert",
				},
			);

			// a stale revision is a conflict
			const stale = await send("PATCH", `/entries/${entry.id}`, {
				body: { revision: 2, note: "nochmal" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(stale.status).to.equal(409);
			expect(bodyOf(stale).code).to.equal("revision_conflict");

			const unknown = await send("PATCH", "/entries/999", {
				body: { revision: 1 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(unknown.status).to.equal(404);
		});

		it("lets the administration add a punch and refuses it to an employee", async () => {
			// the employee does not write his own times: he comments the day (see the day note tests)
			expect(
				(
					await send("POST", "/entries", {
						body: { tsUtc: 3600, direction: "in", note: "Nachtrag" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const asAdmin = await send("POST", "/entries", {
				body: { tsUtc: 3600, direction: "in", note: "Nachtrag", reason: "vergessen" },
				headers: headers(adminToken, adminCsrf),
				query: { userId: String(annaId) },
			});
			expect(asAdmin.status).to.equal(201);
			expect(
				bodyOf<{ entry: { source: string; userId: number; direction: string } }>(asAdmin).entry,
			).to.deep.include({ source: "admin", userId: annaId, direction: "in" });

			// the reason of the correction is part of the audit trail of that punch
			const audit = db
				.prepare("SELECT reason FROM time_entry_audit WHERE entry_id = ? AND action = 'create'")
				.get(bodyOf<{ entry: { id: number } }>(asAdmin).entry.id) as { reason: string | null };
			expect(audit.reason).to.equal("vergessen");

			// an instant is mandatory, an unknown employee is a 404
			expect(
				(await send("POST", "/entries", { body: {}, headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(400);
			expect(
				(
					await send("POST", "/entries", {
						body: { tsUtc: 3600 },
						headers: headers(adminToken, adminCsrf),
						query: { userId: "999" },
					})
				).status,
			).to.equal(404);
		});

		it("deletes a punch with the delete permission", async () => {
			const created = await send("POST", "/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			const entryId = bodyOf<{ entry: { id: number } }>(created).entry.id;

			// the employee role has no `time.delete`
			const denied = await send("DELETE", `/entries/${entryId}`, {
				body: { reason: "doppelt" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			const removed = await send("DELETE", `/entries/${entryId}`, {
				body: { reason: "doppelt" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(removed.status).to.equal(204);
			expect(entries.findById(entryId)).to.equal(null);
		});

		it("shows the audit trail of a punch to an administrator", async () => {
			const created = await send("POST", "/entries", {
				body: { tsUtc: 3600, reason: "vergessen" },
				headers: headers(adminToken, adminCsrf),
				query: { userId: String(annaId) },
			});
			const entryId = bodyOf<{ entry: { id: number } }>(created).entry.id;

			// an employee has no `audit.view`
			expect((await send("GET", `/entries/${entryId}/audit`, { headers: headers(annaToken) })).status).to.equal(
				403,
			);

			const trail = await send("GET", `/entries/${entryId}/audit`, { headers: headers(adminToken) });
			expect(trail.status).to.equal(200);
			const rows = bodyOf<{ audit: { action: string; reason: string | null; actorName: string | null }[] }>(
				trail,
			).audit;
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]).to.deep.include({ action: "create", reason: "vergessen", actorName: "Admin" });

			// an unknown punch is a 404
			expect((await send("GET", "/entries/999/audit", { headers: headers(adminToken) })).status).to.equal(404);
		});
	});
});
