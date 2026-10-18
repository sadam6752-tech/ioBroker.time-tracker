/// <reference types="mocha" />
import { expect } from "chai";
import {
	users,
	rules,
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

	describe("users and roles", () => {
		it("lists users without leaking the password hash", async () => {
			// `user.view` is an administrative right
			expect((await send("GET", "/users", { headers: headers(annaToken) })).status).to.equal(403);

			const listed = await send("GET", "/users", { headers: headers(adminToken) });
			expect(listed.status).to.equal(200);
			const payload = bodyOf<{
				total: number;
				users: { login: string; roles: string[]; passwordHash?: string }[];
			}>(listed);
			expect(payload.total).to.equal(2);
			expect(payload.users.map(user => user.login).sort()).to.deep.equal(["admin", "anna"]);
			expect(payload.users.find(user => user.login === "anna")?.roles).to.deep.equal(["employee"]);
			const raw = JSON.stringify(payload);
			expect(raw).to.not.contain("passwordHash");
			expect(raw).to.not.contain(users.findByLogin("anna")?.passwordHash ?? "scrypt");

			// search and pagination
			const filtered = await send("GET", "/users", { headers: headers(adminToken), query: { q: "ann" } });
			expect(bodyOf<{ users: unknown[] }>(filtered).users).to.have.lengthOf(1);

			const page = await send("GET", "/users", {
				headers: headers(adminToken),
				query: { limit: "1", offset: "1" },
			});
			expect(bodyOf<{ users: unknown[]; total: number }>(page).users).to.have.lengthOf(1);
			expect(bodyOf<{ total: number }>(page).total).to.equal(2);

			expect(
				(await send("GET", "/users", { headers: headers(adminToken), query: { limit: "-1" } })).status,
			).to.equal(400);
		});

		it("serves the role catalogue", async () => {
			expect((await send("GET", "/roles", { headers: headers(annaToken) })).status).to.equal(403);

			const catalog = await send("GET", "/roles", { headers: headers(adminToken) });
			expect(catalog.status).to.equal(200);
			const roles = bodyOf<{ roles: { key: string; permissions: string[] }[] }>(catalog).roles;
			expect(roles.map(role => role.key)).to.deep.equal(["admin", "employee", "manager"]);
			expect(roles.find(role => role.key === "employee")?.permissions).to.include("time.punch");
		});

		it("creates a user and refuses weak passwords", async () => {
			expect(
				(
					await send("POST", "/users", {
						body: { login: "bob", displayName: "Bob", password: "Zeit-2026-klar" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("POST", "/users", {
				body: {
					login: "bob",
					displayName: "Bob",
					password: "Zeit-2026-klar",
					email: "bob@example.org",
					roleKeys: ["employee"],
					timezone: "Europe/Berlin",
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const bob = bodyOf<{ user: { id: number; login: string; roles: string[]; timezone: string } }>(
				created,
			).user;
			expect(bob).to.deep.include({ login: "bob", roles: ["employee"], timezone: "Europe/Berlin" });
			expect(created.headers.location).to.equal(`/users/${bob.id}`);

			// a new account speaks the language of the instance (English here), unless the request names one
			expect(users.findByLogin("bob")?.locale).to.equal("en");
			settings.set("default_language", "pl", adminId);
			await send("POST", "/users", {
				body: { login: "carla", displayName: "Carla", password: "Zeit-2026-klar", roleKeys: ["employee"] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(users.findByLogin("carla")?.locale).to.equal("pl");
			await send("POST", "/users", {
				body: {
					login: "dora",
					displayName: "Dora",
					password: "Zeit-2026-klar",
					locale: "it",
					roleKeys: ["employee"],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(users.findByLogin("dora")?.locale).to.equal("it");
			settings.set("default_language", "en", adminId);

			// the same login is a conflict, a weak password a client error
			expect(
				(
					await send("POST", "/users", {
						body: { login: "BoB", displayName: "Bob 2", password: "Zeit-2026-klar" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(409);
			expect(
				(
					await send("POST", "/users", {
						body: { login: "carol", displayName: "Carol", password: "kurz" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			// the new account can sign in
			expect(
				(await send("POST", "/auth/login", { body: { login: "bob", password: "Zeit-2026-klar" } })).status,
			).to.equal(200);
		});

		it("changes a user, its roles and deactivates it", async () => {
			const bob = bodyOf<{ user: { id: number } }>(
				await send("POST", "/users", {
					body: { login: "bob", displayName: "Bob", password: "Zeit-2026-klar" },
					headers: headers(adminToken, adminCsrf),
				}),
			).user;

			const changed = await send("PATCH", `/users/${bob.id}`, {
				body: { displayName: "Bob Zweit", email: "bob@example.org", roleKeys: ["employee", "manager"] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(changed.status).to.equal(200);
			expect(bodyOf<{ user: { displayName: string; roles: string[] } }>(changed).user).to.deep.include({
				displayName: "Bob Zweit",
				roles: ["employee", "manager"],
			});

			// an invalid time zone would break every later calculation
			expect(
				(
					await send("PATCH", `/users/${bob.id}`, {
						body: { timezone: "Mars/Olympus" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			// nobody deactivates the own account, a missing user is a 404
			expect(
				(
					await send("PATCH", `/users/${adminId}`, {
						body: { isActive: false },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("PATCH", "/users/999", {
						body: { displayName: "X" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(404);

			// deleting means deactivating
			expect(
				(await send("DELETE", `/users/${bob.id}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(204);
			const read = await send("GET", `/users/${bob.id}`, { headers: headers(adminToken) });
			expect(bodyOf<{ user: { isActive: boolean } }>(read).user.isActive).to.equal(false);
			expect(
				(await send("DELETE", `/users/${bob.id}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(404);
			expect(
				(await send("DELETE", `/users/${adminId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(400);
		});

		it("keeps the last active administrator in place", async () => {
			// a second administrator may be added and demoted again
			const second = bodyOf<{ user: { id: number } }>(
				await send("POST", "/users", {
					body: { login: "chef", displayName: "Chef", password: "Zeit-2026-klar", roleKeys: ["admin"] },
					headers: headers(adminToken, adminCsrf),
				}),
			).user;
			expect(
				(
					await send("PATCH", `/users/${second.id}`, {
						body: { roleKeys: ["manager"] },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(200);

			// the last active one keeps the role: without it the installation could not be administered any more
			for (const body of [{ roleKeys: ["manager"] }, { roleKeys: [] }]) {
				const refused = await send("PATCH", `/users/${adminId}`, {
					body,
					headers: headers(adminToken, adminCsrf),
				});
				expect(refused.status).to.equal(409);
				expect(bodyOf<{ code: string }>(refused).code).to.equal("last_administrator");
			}
			expect(users.roles(adminId)).to.deep.equal(["admin"]);

			// as soon as somebody else carries the role the change goes through (deactivating the own account stays
			// refused by its own rule — the test above checks that)
			await send("PATCH", `/users/${second.id}`, {
				body: { roleKeys: ["admin"] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(
				(
					await send("PATCH", `/users/${adminId}`, {
						body: { roleKeys: ["manager"] },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(200);
			expect(users.roles(adminId)).to.deep.equal(["manager"]);
		});
	});

	describe("work profiles and shift rules", () => {
		it("reads and changes the work profile", async () => {
			expect((await send("GET", `/users/${annaId}/profile`, { headers: headers(annaToken) })).status).to.equal(
				403,
			);

			const read = await send("GET", `/users/${annaId}/profile`, { headers: headers(adminToken) });
			expect(read.status).to.equal(200);
			expect(bodyOf<{ profile: { percent: number; workdays: string } }>(read).profile).to.include({
				percent: 100,
			});

			const changed = await send("PUT", `/users/${annaId}/profile`, {
				body: {
					percent: 80,
					weeklyHours: 42,
					workdays: "1;2;3;4;5",
					overtimeModel: "yearly",
					vacationPerYear: 25,
					pausePaidMinutes: 15,
					reason: "Anpassung Arbeitspensum",
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(changed.status).to.equal(200);
			expect(bodyOf<{ profile: Record<string, unknown> }>(changed).profile).to.deep.include({
				percent: 80,
				weeklyHours: 42,
				workdays: "1;2;3;4;5",
				overtimeModel: "yearly",
				vacationPerYear: 25,
				pausePaidMinutes: 15,
			});

			// impossible values and unknown fields never reach the database
			expect(
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body: { percent: 130 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body: { workdays: "1;9" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body: { overtimeModel: "irgendwas" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			// `pausePaidMinutes` is a number of minutes, not a switch
			expect(
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body: { pausePaidMinutes: "viel" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body: { pausePaidMinutes: 2000 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("PUT", `/users/${annaId}/profile`, {
						body: { unbekannt: 1 },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(await send("PUT", "/users/999/profile", { body: {}, headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(404);
		});

		it("replaces the shift rules of a user", async () => {
			const empty = await send("GET", `/users/${annaId}/shift-rules`, { headers: headers(adminToken) });
			expect(empty.status).to.equal(200);
			expect(bodyOf<{ shiftRules: unknown[] }>(empty).shiftRules).to.have.lengthOf(0);
			expect(
				(await send("GET", `/users/${annaId}/shift-rules`, { headers: headers(annaToken) })).status,
			).to.equal(403);

			const first = await send("PUT", `/users/${annaId}/shift-rules`, {
				body: { shiftRules: [{ dayOfWeek: 6, fromMin: 0, toMin: 360, surcharge: 25 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(first.status).to.equal(200);
			const created = bodyOf<{ shiftRules: { id: number; surcharge: number }[] }>(first).shiftRules;
			expect(created).to.have.lengthOf(1);
			expect(created[0].surcharge).to.equal(25);

			// a second rule is added, both stay
			const second = await send("PUT", `/users/${annaId}/shift-rules`, {
				body: {
					shiftRules: [
						{ id: created[0].id, dayOfWeek: 6, fromMin: 0, toMin: 360, surcharge: 30 },
						{ dayOfWeek: 0, fromMin: 360, toMin: 1440, surcharge: 50 },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(second.status).to.equal(200);
			const both = bodyOf<{ shiftRules: { id: number; surcharge: number }[] }>(second).shiftRules;
			expect(both).to.have.lengthOf(2);
			expect(both[0].surcharge).to.equal(30);

			// the payload replaces the set: the second rule is gone again
			const reduced = await send("PUT", `/users/${annaId}/shift-rules`, {
				body: { shiftRules: [{ id: created[0].id, dayOfWeek: 6, fromMin: 0, toMin: 360, surcharge: 30 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(reduced.status).to.equal(200);
			expect(bodyOf<{ shiftRules: unknown[] }>(reduced).shiftRules).to.have.lengthOf(1);
			expect(rules.shiftRules(annaId, { includeInactive: true })).to.have.lengthOf(1);

			expect(
				(
					await send("PUT", `/users/${annaId}/shift-rules`, {
						body: { shiftRules: "nein" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
		});
	});
});
