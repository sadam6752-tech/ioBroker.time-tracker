/// <reference types="mocha" />
import { expect } from "chai";
import {
	password,
	db,
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

	describe("authentication", () => {
		it("serves public metadata without a session", async () => {
			const health = await send("GET", "/health");
			expect(health.status).to.equal(200);
			expect(bodyOf(health)).to.deep.equal({ status: "ok", holidayCountry: "DE", time: 1000 });

			const routes = await send("GET", "/routes");
			expect(
				bodyOf<{ routes: { method: string; path: string; permission?: string }[] }>(routes).routes,
			).to.deep.include({ method: "POST", path: "/punch", permission: "time.punch" });
		});

		it("logs in and rejects wrong credentials", async () => {
			const ok = await send("POST", "/auth/login", {
				body: { login: "anna", password },
				headers: { "user-agent": "test-agent" },
			});
			expect(ok.status).to.equal(200);
			const payload = bodyOf<{ user: { login: string }; expiresAt: number }>(ok);
			expect(payload.user.login).to.equal("anna");
			expect(payload.expiresAt).to.equal(1000 + 720 * 60);

			const wrong = await send("POST", "/auth/login", { body: { login: "anna", password: "falsch-1234" } });
			expect(wrong.status).to.equal(401);
			expect(bodyOf(wrong)).to.deep.include({ status: 401, code: "invalid_credentials" });

			const missing = await send("POST", "/auth/login", { body: { login: "anna" } });
			expect(missing.status).to.equal(400);
			expect(bodyOf(missing).detail).to.equal("password is required");
		});

		it("answers a locked login with 423", async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				await send("POST", "/auth/login", { body: { login: "anna", password: "falsch-1234" } });
			}

			const locked = await send("POST", "/auth/login", { body: { login: "anna", password } });
			expect(locked.status).to.equal(423);
			expect(bodyOf(locked).code).to.equal("locked_out");
		});

		it("returns the caller and ends the session on logout", async () => {
			const me = await send("GET", "/auth/me", { headers: headers(annaToken) });
			expect(me.status).to.equal(200);
			expect(bodyOf<{ user: { login: string } }>(me).user.login).to.equal("anna");

			expect((await send("GET", "/auth/me")).status).to.equal(401);

			const logout = await send("POST", "/auth/logout", { headers: headers(annaToken, annaCsrf) });
			expect(logout.status).to.equal(204);
			expect((await send("GET", "/auth/me", { headers: headers(annaToken) })).status).to.equal(401);
		});

		it("renews a session and hands out a fresh CSRF token", async () => {
			const refreshed = await send("POST", "/auth/refresh", { headers: headers(annaToken, annaCsrf) });
			expect(refreshed.status).to.equal(200);
			const payload = bodyOf<{ expiresAt: number; csrfToken: string; permissions: string[] }>(refreshed);
			expect(payload.expiresAt).to.equal(1000 + 720 * 60);
			expect(payload.csrfToken).to.be.a("string").and.not.equal("");
			expect(payload.permissions).to.include("time.punch");

			// the refreshed token stays valid for the next request
			expect(
				(await send("POST", "/auth/refresh", { headers: headers(annaToken, payload.csrfToken) })).status,
			).to.equal(200);

			// without a session there is nothing to renew
			expect((await send("POST", "/auth/refresh")).status).to.equal(401);
		});

		it("changes the own password and ends all sessions", async () => {
			const response = await send("POST", "/auth/password", {
				body: { password: "Ganz-Neues-2026" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(response.status).to.equal(204);

			// the old session is gone, the new password works
			expect((await send("GET", "/auth/me", { headers: headers(annaToken) })).status).to.equal(401);
			expect((await send("POST", "/auth/login", { body: { login: "anna", password } })).status).to.equal(401);
			expect(
				(await send("POST", "/auth/login", { body: { login: "anna", password: "Ganz-Neues-2026" } })).status,
			).to.equal(200);

			const weak = await send("POST", "/auth/password", {
				body: { password: "kurz" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(weak.status).to.equal(400);
			expect(bodyOf(weak).detail).to.contain("policy");
		});
	});

	describe("session cookies", () => {
		it("sets an httpOnly session cookie at the login and removes it again", async () => {
			const login = await send("POST", "/auth/login", { body: { login: "anna", password } });
			expect(login.status).to.equal(200);
			const cookie = login.headers["set-cookie"];
			expect(cookie).to.contain(`zt_session=${bodyOf<{ token: string }>(login).token}`);
			expect(cookie).to.contain("HttpOnly");
			expect(cookie).to.contain("SameSite=Lax");
			expect(cookie).to.contain("Path=/");
			// plain HTTP on the loopback interface: a Secure cookie would never come back
			expect(cookie).to.not.contain("Secure");

			const logout = await send("POST", "/auth/logout", {
				headers: { cookie: `zt_session=${annaToken}`, "x-csrf-token": annaCsrf },
			});
			expect(logout.status).to.equal(204);
			// the session has to end in the browser as well, otherwise it stays signed in
			expect(logout.headers["set-cookie"]).to.contain(`zt_session=; Path=/; Max-Age=0`);
		});

		it("serves a browser that only holds the cookie and hands out the CSRF token of its session", async () => {
			const cookie = { cookie: `zt_session=${annaToken}` };

			const me = await send("GET", "/auth/me", { headers: cookie });
			expect(me.status).to.equal(200);
			const issued = bodyOf<{ csrfToken: string }>(me).csrfToken;
			expect(issued).to.equal(annaCsrf);

			const punch = await send("POST", "/punch", {
				body: { tsUtc: 1000 },
				headers: { ...cookie, "x-csrf-token": issued },
			});
			expect(punch.status).to.equal(201);
		});

		it("refuses a login or a password that is longer than anybody needs, before any work is done", async () => {
			const longLogin = await send("POST", "/auth/login", { body: { login: "x".repeat(129), password } });
			expect(longLogin.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(longLogin).detail).to.contain("login is too long");

			const longPassword = await send("POST", "/auth/login", {
				body: { login: "anna", password: "p".repeat(1025) },
			});
			expect(longPassword.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(longPassword).detail).to.contain("password is too long");

			// the refused attempts leave nothing in the audit trail
			const rows = db
				.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'auth.login_failed'")
				.get() as {
				count: number;
			};
			expect(rows.count).to.equal(0);
		});

		it("ends the browser session when the password changes", async () => {
			const changed = await send("POST", "/auth/password", {
				body: { password: "Neu-2026-komplett" },
				headers: { cookie: `zt_session=${annaToken}`, "x-csrf-token": annaCsrf },
			});
			expect(changed.status).to.equal(204);
			expect(changed.headers["set-cookie"]).to.contain("Max-Age=0");
		});
	});
});
