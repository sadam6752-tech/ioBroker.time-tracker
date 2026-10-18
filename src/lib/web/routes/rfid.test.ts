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

	describe("rfid tags", () => {
		it("creates a signed tag link and punches by scanning it", async () => {
			// managing tags is an administrative right
			expect((await send("GET", "/rfid/tags", { headers: headers(annaToken) })).status).to.equal(403);
			expect(
				(
					await send("POST", "/rfid/tags", {
						body: { userId: annaId },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("POST", "/rfid/tags", {
				body: { userId: annaId, label: "Schlüsselbund" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const payload = bodyOf<{ tag: { id: number; uid: string }; token: string; url: string }>(created);
			expect(payload.url).to.contain(`/?tag=${payload.token}`);
			// the link uses the scheme of the request: a fixed https pointed nowhere on a plain HTTP instance
			expect(payload.url.startsWith("http://"), payload.url).to.equal(true);
			expect(created.headers.location).to.equal(`/rfid/tags/${payload.tag.id}`);

			// the list never contains the signature
			const listed = await send("GET", "/rfid/tags", { headers: headers(adminToken) });
			expect(listed.status).to.equal(200);
			expect(JSON.stringify(bodyOf(listed))).to.not.contain(payload.token);

			// scanning needs no session: the signature is the credential
			const scanned = await send("POST", "/rfid/scan", { body: { token: payload.token, tsUtc: 1000 } });
			expect(scanned.status).to.equal(201);
			expect(bodyOf<{ user: { id: number; displayName: string } }>(scanned).user).to.deep.equal({
				id: annaId,
				displayName: "Anna",
			});
			expect(bodyOf<{ day: { hasOpenEntry: boolean } }>(scanned).day.hasOpenEntry).to.equal(true);

			// the scan is recorded on the tag
			const after = bodyOf<{ tags: { lastUsedAt: number | null }[] }>(
				await send("GET", "/rfid/tags", { headers: headers(adminToken) }),
			);
			expect(after.tags[0].lastUsedAt).to.equal(1000);

			// a tampered token (another user, another expiry) fails the signature
			const parts = payload.token.split(".");
			const forOtherUser = [parts[0], String(adminId), parts[2], parts[3]].join(".");
			const otherExpiry = [parts[0], parts[1], String(Number(parts[2]) + 9999), parts[3]].join(".");
			for (const token of [forOtherUser, otherExpiry, `${payload.token}x`, "quatsch"]) {
				const response = await send("POST", "/rfid/scan", { body: { token } });
				expect(response.status, token).to.be.oneOf([400, 401]);
			}

			// revoking ends the tag
			expect(
				(await send("DELETE", `/rfid/tags/${payload.tag.id}`, { headers: headers(adminToken, adminCsrf) }))
					.status,
			).to.equal(204);
			expect((await send("POST", "/rfid/scan", { body: { token: payload.token } })).status).to.equal(401);
			expect(
				(await send("DELETE", `/rfid/tags/${payload.tag.id}`, { headers: headers(adminToken, adminCsrf) }))
					.status,
			).to.equal(404);

			// a revoked badge can be removed from the list for good, which is what the tab offers for old badges
			expect(
				(
					await send("DELETE", `/rfid/tags/${payload.tag.id}/permanent`, {
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(204);
			const withoutTag = bodyOf<{ tags: { id: number }[] }>(
				await send("GET", "/rfid/tags", { headers: headers(adminToken) }),
			);
			expect(withoutTag.tags.some(tag => tag.id === payload.tag.id)).to.equal(false);
			// and removing it twice is a not found, not a silent success
			expect(
				(
					await send("DELETE", `/rfid/tags/${payload.tag.id}/permanent`, {
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(404);
		});

		it("changes a badge, gives it a new link and brings a revoked one back", async () => {
			const created = await send("POST", "/rfid/tags", {
				body: { userId: annaId, label: "Werkstatt" },
				headers: headers(adminToken, adminCsrf),
			});
			const first = bodyOf<{ tag: { id: number }; token: string }>(created);
			expect(created.status).to.equal(201);
			expect((await send("POST", "/rfid/scan", { body: { token: first.token, tsUtc: 1000 } })).status).to.equal(
				201,
			);

			// a label on its own leaves the link alone — the signature does not know about it
			const relabelled = await send("PATCH", `/rfid/tags/${first.tag.id}`, {
				body: { label: "Werkstatt (neu)" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(relabelled.status).to.equal(200);
			expect(bodyOf<{ tag: { label: string; userId: number } }>(relabelled).tag).to.deep.include({
				label: "Werkstatt (neu)",
				userId: annaId,
			});
			expect(bodyOf<{ token?: string }>(relabelled).token).to.equal(undefined);
			expect((await send("POST", "/rfid/scan", { body: { token: first.token, tsUtc: 2000 } })).status).to.equal(
				201,
			);

			// a new validity signs a new link, the one handed out before is dead
			const renewed = await send("PATCH", `/rfid/tags/${first.tag.id}`, {
				body: { ttlDays: 30 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(renewed.status).to.equal(200);
			const second = bodyOf<{ tag: { expiresAt: number }; token: string; url: string }>(renewed);
			expect(second.token).to.be.a("string");
			expect(second.url).to.contain(`/?tag=${second.token}`);
			expect((await send("POST", "/rfid/scan", { body: { token: first.token, tsUtc: 2500 } })).status).to.equal(
				401,
			);
			expect((await send("POST", "/rfid/scan", { body: { token: second.token, tsUtc: 3000 } })).status).to.equal(
				201,
			);

			// a new owner needs a new signature as well, because the link carries the owner
			const moved = await send("PATCH", `/rfid/tags/${first.tag.id}`, {
				body: { userId: adminId },
				headers: headers(adminToken, adminCsrf),
			});
			expect(moved.status).to.equal(200);
			const third = bodyOf<{ tag: { userId: number }; token: string }>(moved);
			expect(third.tag.userId).to.equal(adminId);
			expect((await send("POST", "/rfid/scan", { body: { token: second.token, tsUtc: 3500 } })).status).to.equal(
				401,
			);
			expect((await send("POST", "/rfid/scan", { body: { token: third.token, tsUtc: 4000 } })).status).to.equal(
				201,
			);

			// revoking kills the link, a new link brings the badge back into use
			expect(
				(await send("DELETE", `/rfid/tags/${first.tag.id}`, { headers: headers(adminToken, adminCsrf) }))
					.status,
			).to.equal(204);
			expect((await send("POST", "/rfid/scan", { body: { token: third.token, tsUtc: 4500 } })).status).to.equal(
				401,
			);
			const again = await send("POST", `/rfid/tags/${first.tag.id}/link`, {
				body: { ttlDays: 10 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(again.status).to.equal(200);
			const fourth = bodyOf<{ tag: { isActive: boolean }; token: string }>(again);
			expect(fourth.tag.isActive).to.equal(true);
			expect((await send("POST", "/rfid/scan", { body: { token: fourth.token, tsUtc: 5000 } })).status).to.equal(
				201,
			);

			// nonsense is refused instead of silently changing something
			expect(
				(
					await send("PATCH", `/rfid/tags/${first.tag.id}`, {
						body: { userId: 9999 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("POST", `/rfid/tags/${first.tag.id}/link`, {
						body: { ttlDays: 0 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(await send("POST", "/rfid/tags/9999/link", { body: {}, headers: headers(adminToken, adminCsrf) }))
					.status,
			).to.equal(404);
			expect(
				(await send("PATCH", "/rfid/tags/9999", { body: {}, headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(404);
			// a badge answers only to an administrator
			expect(
				(
					await send("PATCH", `/rfid/tags/${first.tag.id}`, {
						body: { label: "x" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);
		});

		it("refuses tag links without a configured secret", async () => {
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
			});
			const response = await withoutSecret.router.handle({
				method: "POST",
				path: "/rfid/scan",
				query: {},
				headers: {
					"content-type": "application/json",
					"x-session-token": adminToken,
					"x-csrf-token": adminCsrf,
				},
				body: JSON.stringify({ token: "a.1.2.b" }),
				remoteAddress: "127.0.0.1",
			});
			expect(response.status).to.equal(403);
			expect(JSON.parse(response.body.toString())).to.deep.include({ code: "not_configured" });
		});
	});
});
