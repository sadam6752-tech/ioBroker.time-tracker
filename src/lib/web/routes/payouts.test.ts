/// <reference types="mocha" />
import { expect } from "chai";
import {
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

	describe("payouts, bulk import and statistics", () => {
		it("records, changes and deletes payouts", async () => {
			// `payout.view`/`payout.create` are administrative rights
			expect(
				(await send("GET", "/payouts", { headers: headers(annaToken), query: { year: "2026" } })).status,
			).to.equal(403);

			const created = await send("POST", "/payouts", {
				body: { userId: annaId, year: 2026, month: 1, minutes: 120, amount: 150.5, note: "Auszahlung Januar" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const payoutId = bodyOf<{ payout: { id: number } }>(created).payout.id;
			expect(created.headers.location).to.equal(`/payouts/${payoutId}`);

			const listed = await send("GET", "/payouts", {
				headers: headers(adminToken),
				query: { userId: String(annaId), year: "2026" },
			});
			expect(listed.status).to.equal(200);
			expect(bodyOf<{ totalMinutes: number }>(listed).totalMinutes).to.equal(120);
			expect(bodyOf<{ payouts: unknown[] }>(listed).payouts).to.have.lengthOf(1);

			// the sum follows the filter
			expect(
				bodyOf<{ totalMinutes: number }>(
					await send("GET", "/payouts", {
						headers: headers(adminToken),
						query: { userId: String(annaId), year: "2026", month: "2" },
					}),
				).totalMinutes,
			).to.equal(0);

			const changed = await send("PATCH", `/payouts/${payoutId}`, {
				body: { minutes: 90, amount: null },
				headers: headers(adminToken, adminCsrf),
			});
			expect(changed.status).to.equal(200);
			expect(bodyOf<{ payout: { minutes: number; amount: number | null } }>(changed).payout).to.deep.include({
				minutes: 90,
				amount: null,
			});

			// impossible values are client errors
			expect(
				(
					await send("POST", "/payouts", {
						body: { userId: annaId, year: 2026, minutes: 0 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("POST", "/payouts", {
						body: { userId: annaId, year: 2026, month: 13, minutes: 60 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("POST", "/payouts", {
						body: { userId: 999, year: 2026, minutes: 60 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			expect(
				(await send("DELETE", `/payouts/${payoutId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(204);
			expect(
				(await send("DELETE", `/payouts/${payoutId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(404);
		});

		it("imports punches in bulk and reports failures per row", async () => {
			expect(
				(
					await send("POST", "/entries/bulk", {
						body: { entries: [{ tsUtc: 1000 }] },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const imported = await send("POST", "/entries/bulk", {
				body: {
					entries: [
						{ userId: annaId, tsUtc: 1000, note: "Liste" },
						{ userId: annaId, tsUtc: 1000 + 8 * 3600 },
						{ userId: annaId, note: "ohne Zeitstempel" },
						{ userId: 999, tsUtc: 2000 },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(imported.status).to.equal(200);
			const result = bodyOf<{
				imported: number;
				failed: number;
				recalculatedDays: number;
				results: { index: number; entryId?: number; error?: string }[];
			}>(imported);
			expect(result).to.deep.include({ imported: 2, failed: 2, recalculatedDays: 1 });
			expect(result.results[0].entryId).to.be.greaterThan(0);
			expect(result.results[2].error).to.equal("bad_request");
			expect(result.results[3].error).to.equal("not_found");

			// the imported punches keep their own origin and have refreshed the day
			const stored = entries.listByRange(annaId, "1970-01-01", "1970-01-01");
			expect(stored).to.have.lengthOf(2);
			expect(stored.every(entry => entry.source === "import")).to.equal(true);

			const day = await send("GET", "/aggregates/day", {
				headers: headers(adminToken),
				query: { date: "1970-01-01", userId: String(annaId) },
			});
			expect(bodyOf<{ day: { workedMin: number } }>(day).day.workedMin).to.equal(480);

			expect(
				(
					await send("POST", "/entries/bulk", {
						body: { entries: "nein" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
		});

		it("aggregates statistics over several employees", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });
			await send("POST", "/punch", {
				body: { tsUtc: 1000 + 8 * 3600 },
				headers: headers(annaToken, annaCsrf),
			});

			// employees have no access to the team overview
			expect(
				(
					await send("GET", "/reports/statistics", {
						headers: headers(annaToken),
						query: { from: "1970-01-01", to: "1970-01-02" },
					})
				).status,
			).to.equal(403);

			const statistics = await send("GET", "/reports/statistics", {
				headers: headers(adminToken),
				query: { from: "1970-01-01", to: "1970-01-02" },
			});
			expect(statistics.status).to.equal(200);
			const payload = bodyOf<{
				users: { userId: number; displayName: string; workedMin: number }[];
				totals: { workedMin: number; balanceMin: number; openDays: number };
			}>(statistics);
			expect(payload.users.map(user => user.userId)).to.include(annaId);
			expect(payload.users.find(user => user.userId === annaId)?.workedMin).to.equal(480);
			expect(payload.totals.workedMin).to.equal(480);

			// a single employee can be asked for as well
			const single = await send("GET", "/reports/statistics", {
				headers: headers(adminToken),
				query: { from: "1970-01-01", to: "1970-01-02", userId: String(adminId) },
			});
			expect(bodyOf<{ users: unknown[] }>(single).users).to.have.lengthOf(1);

			// client errors: missing range, inverted range and a range that is too long
			expect((await send("GET", "/reports/statistics", { headers: headers(adminToken) })).status).to.equal(400);
			expect(
				(
					await send("GET", "/reports/statistics", {
						headers: headers(adminToken),
						query: { from: "1970-01-02", to: "1970-01-01" },
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("GET", "/reports/statistics", {
						headers: headers(adminToken),
						query: { from: "1970-01-01", to: "1972-01-01" },
					})
				).status,
			).to.equal(400);
		});
	});
});
