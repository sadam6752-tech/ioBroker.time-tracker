/// <reference types="mocha" />
import { expect } from "chai";
import {
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

	describe("punching", () => {
		it("stores a punch and refreshes the day", async () => {
			const first = await send("POST", "/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(first.status).to.equal(201);
			const stored = bodyOf<{ entry: { id: number; tsUtc: number; source: string; period: string } }>(first);
			expect(stored.entry.tsUtc).to.equal(1000);
			expect(stored.entry.source).to.equal("web");
			expect(first.headers.location).to.equal(`/entries/${stored.entry.id}`);

			// a browser (the session cookie is present) writes nothing without a CSRF token
			const denied = await send("POST", "/punch", {
				body: { tsUtc: 2000 },
				headers: { cookie: `zt_session=${annaToken}` },
			});
			expect(denied.status).to.equal(403);
			expect(bodyOf(denied).code).to.equal("csrf_rejected");
		});

		it("accepts a bearer client without a CSRF token", async () => {
			// `x-session-token` is a header a foreign page cannot set, so integration clients (the load sample
			// T17, scripts) must get through without the token that only the browser holds
			const accepted = await send("POST", "/punch", {
				body: { tsUtc: 3000 },
				headers: { "x-session-token": annaToken },
			});

			expect(accepted.status, JSON.stringify(bodyOf(accepted))).to.equal(201);
		});

		it("is idempotent for a repeated punch and requires the permission", async () => {
			const payload = { tsUtc: 1000, idempotencyKey: "offline-1" };
			const first = await send("POST", "/punch", { body: payload, headers: headers(annaToken, annaCsrf) });
			const second = await send("POST", "/punch", { body: payload, headers: headers(annaToken, annaCsrf) });

			expect(first.status).to.equal(201);
			expect(bodyOf<{ created: boolean }>(first).created).to.equal(true);
			expect(bodyOf<{ created: boolean }>(second).created).to.equal(false);
			expect(bodyOf<{ entry: { id: number } }>(second).entry.id).to.equal(
				bodyOf<{ entry: { id: number } }>(first).entry.id,
			);

			// the employee may punch, but may not correct the punches of others
			const other = await send("PATCH", "/entries/1", {
				body: { revision: 1, note: "x" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(other.status).to.equal(200);
		});

		it("rounds the quick punch and reports the daily status", async () => {
			// the instance rounds to fifteen minutes, which the route reads from the settings
			settings.set("quick_round_minutes", "15");

			const quick = await send("POST", "/punch/quick", {
				body: { tsUtc: 1420 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(quick.status).to.equal(201);
			const rounded = bodyOf<{
				entry: { tsUtc: number };
				rounded: { from: number; to: number; roundMinutes: number };
			}>(quick);
			// 01:23:40 local time is rounded to the nearest quarter hour
			expect(rounded.rounded).to.deep.equal({ from: 1420, to: 1800, roundMinutes: 15 });
			expect(rounded.entry.tsUtc).to.equal(1800);

			// without the setting the instant is stored unchanged
			settings.set("quick_round_minutes", "0");
			const plain = await send("POST", "/punch/quick", {
				body: { tsUtc: 2000 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(bodyOf<{ entry: { tsUtc: number } }>(plain).entry.tsUtc).to.equal(2000);
			expect(bodyOf(plain)).to.not.have.property("rounded");

			// two punches form a pair, so the day is closed and the next punch would be a clock-in
			const closed = await send("GET", "/punch/status", { headers: headers(annaToken) });
			expect(closed.status).to.equal(200);
			expect(bodyOf(closed)).to.deep.include({ date: "1970-01-01", nextDirection: "in" });
			expect(bodyOf<{ hasOpenEntry: boolean }>(closed).hasOpenEntry).to.equal(false);

			await send("POST", "/punch", { body: { tsUtc: 7200 }, headers: headers(annaToken, annaCsrf) });
			const open = bodyOf<{ hasOpenEntry: boolean; nextDirection: string; lastEntry: { tsUtc: number } }>(
				await send("GET", "/punch/status", { headers: headers(annaToken) }),
			);
			expect(open.hasOpenEntry).to.equal(true);
			expect(open.nextDirection).to.equal("out");
			expect(open.lastEntry.tsUtc).to.equal(7200);

			// another employee is only visible with the matching permission
			expect(
				(
					await send("GET", "/punch/status", {
						headers: headers(annaToken),
						query: { userId: String(adminId) },
					})
				).status,
			).to.equal(403);
		});

		it("accepts an offline batch and reports conflicts", async () => {
			const batch = await send("POST", "/entries/sync", {
				body: {
					punches: [
						{ idempotencyKey: "a", tsUtc: 1000 },
						{ idempotencyKey: "b", tsUtc: 1000 + 4 * 3600, clientTsUtc: 1000 },
					],
				},
				headers: headers(annaToken, annaCsrf),
			});

			expect(batch.status).to.equal(200);
			const result = bodyOf<{
				accepted: { idempotencyKey: string }[];
				conflicts: { reason: string }[];
				recalculated: string[];
			}>(batch);
			expect(result.accepted.map(entry => entry.idempotencyKey)).to.deep.equal(["a"]);
			expect(result.conflicts.map(entry => entry.reason)).to.deep.equal(["clock_skew"]);
			expect(result.recalculated).to.deep.equal(["1970-01-01"]);

			const broken = await send("POST", "/entries/sync", {
				body: { punches: "no" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.equal("punches must be an array");
		});

		it("resolves conflicts with the matching permission", async () => {
			// the conflict is written by the employee (the offline queue is the only place that still accepts a
			// punch of one's own) and decided by the administration
			const batch = await send("POST", "/entries/sync", {
				body: { punches: [{ idempotencyKey: "a", tsUtc: 1000, clientTsUtc: 1000 - 3600 }] },
				headers: headers(annaToken, annaCsrf),
			});
			const entryId = bodyOf<{ conflicts: { entryId: number }[] }>(batch).conflicts[0].entryId;

			// the employee has no permission for the conflict queue
			expect((await send("GET", "/entries/conflicts", { headers: headers(annaToken) })).status).to.equal(403);

			const listed = await send("GET", "/entries/conflicts", {
				headers: headers(adminToken),
				query: { userId: String(annaId) },
			});
			expect(bodyOf<{ conflicts: { id: number }[] }>(listed).conflicts.map(entry => entry.id)).to.deep.equal([
				entryId,
			]);

			const resolved = await send("POST", `/entries/${entryId}/resolve`, {
				body: { action: "accept", tsUtc: 500 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(resolved.status).to.equal(200);
			expect(bodyOf<{ entry: { tsUtc: number; syncState: string } }>(resolved).entry).to.deep.include({
				tsUtc: 500,
				syncState: "synced",
			});

			const invalid = await send("POST", `/entries/${entryId}/resolve`, {
				body: { action: "later" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(invalid.status).to.equal(400);
		});
	});
});
