/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAuthService, type AuthService } from "../services/auth";
import { NotFoundError } from "../errors";
import { SESSION_COOKIE } from "./cookies";
import { binary, createRouter, json, noContent, type HttpRequest, type HttpResponse, type Router } from "./router";

const SECRET = "router-test-secret";
const password = "Zeit-2026-klar";

describe("web router", () => {
	let db: Db;
	let users: UsersRepository;
	let auth: AuthService;
	let router: Router;
	let annaId: number;
	let adminId: number;
	let employeeToken: string;
	let employeeCsrf: string;
	let adminToken: string;

	/**
	 * Sends a request through the router.
	 *
	 * @param method - HTTP method
	 * @param path - request path
	 * @param options - request options
	 * @param options.body - raw body
	 * @param options.headers - request headers
	 * @param options.query - query parameters
	 * @param options.remoteAddress - client address counted by the rate limit
	 * @returns response
	 */
	async function send(
		method: string,
		path: string,
		options: {
			body?: string;
			headers?: Record<string, string>;
			query?: Record<string, string>;
			remoteAddress?: string;
		} = {},
	): Promise<HttpResponse> {
		const request: HttpRequest = {
			method,
			path,
			body: options.body,
			query: options.query,
			headers: options.headers,
			remoteAddress: options.remoteAddress ?? "127.0.0.1",
		};
		return router.handle(request);
	}

	/**
	 * Parses the response body.
	 *
	 * @param response - HTTP response
	 * @returns parsed body
	 */
	function bodyOf<T = Record<string, unknown>>(response: HttpResponse): T {
		return JSON.parse(response.body.toString()) as T;
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		auth = createAuthService({ db, users, settings: createSettingsRepository(db), secret: SECRET });

		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		auth.setPassword({ userId: annaId, password, actorId: adminId, now: 1000 });
		auth.setPassword({ userId: adminId, password, actorId: adminId, now: 1000 });

		const employee = auth.login({ login: "anna", password, now: 2000 });
		const admin = auth.login({ login: "admin", password, now: 2000 });
		if (!employee.ok || !admin.ok) {
			throw new Error("login for the router tests failed");
		}
		employeeToken = employee.token;
		employeeCsrf = employee.csrfToken;
		adminToken = admin.token;

		router = createRouter({ auth, now: () => 2000, maxBodyBytes: 64 });
		router.add({
			method: "GET",
			path: "/health",
			requiresAuth: false,
			handler: () => json(200, { status: "ok" }),
		});
		router.add({
			method: "GET",
			path: "/me",
			handler: context => json(200, { login: context.auth?.user.login, permissions: context.auth?.permissions }),
		});
		router.add({
			method: "GET",
			path: "/session-info",
			handler: context =>
				json(200, {
					token: context.sessionToken,
					viaCookie: context.viaCookie,
					secure: context.secure,
					address: context.request.remoteAddress,
				}),
		});
		router.add({
			method: "GET",
			path: "/reports/day/:date",
			handler: context => json(200, { date: context.params.date, format: context.query("format") }),
		});
		router.add({
			method: "POST",
			path: "/punch",
			permission: "time.punch",
			handler: context => json(201, { echo: context.jsonBody() }, { location: "/time/entries/1" }),
		});
		router.add({
			method: "DELETE",
			path: "/punch",
			permission: "time.punch",
			handler: () => noContent(),
		});
		router.add({
			method: "GET",
			path: "/users",
			permission: "user.create",
			handler: () => json(200, { users: [] }),
		});
		router.add({
			method: "POST",
			path: "/body-required",
			handler: context => json(200, { received: context.jsonBody() }),
		});
		router.add({
			method: "DELETE",
			path: "/body-optional",
			handler: context => json(200, { received: context.optionalJsonBody() }),
		});
		router.add({
			method: "GET",
			path: "/limited",
			rateLimit: { name: "test-limited", limit: 2, windowSeconds: 60 },
			handler: () => json(200, { ok: true }),
		});
		router.add({
			method: "GET",
			path: "/boom",
			handler: () => {
				throw new NotFoundError("entry 5 not found");
			},
		});
		router.add({
			method: "GET",
			path: "/crash",
			handler: () => {
				throw new TypeError("internal detail that must not leak");
			},
		});
		router.add({
			method: "GET",
			path: "/download",
			handler: () =>
				binary(200, Buffer.from([1, 2, 3]), "application/octet-stream", {
					"content-disposition": 'attachment; filename="export.bin"',
				}),
		});
		router.add({
			method: "GET",
			path: "/export.csv",
			handler: () => binary(200, "a,b\n1,2\n", "text/csv; charset=utf-8"),
		});
	});

	afterEach(() => {
		db.close();
	});

	describe("routing", () => {
		it("lists and matches routes", async () => {
			expect(router.routes()).to.deep.include({ method: "GET", path: "/reports/day/:date" });

			const response = await send("GET", "/health");
			expect(response.status).to.equal(200);
			expect(bodyOf(response)).to.deep.equal({ status: "ok" });
		});

		it("passes path parameters and query values to the handler", async () => {
			const response = await send("GET", "/reports/day/2026-01-07", {
				query: { format: "minutes" },
				headers: { "x-session-token": employeeToken },
			});

			expect(response.status).to.equal(200);
			expect(bodyOf(response)).to.deep.equal({ date: "2026-01-07", format: "minutes" });
		});

		it("answers unknown paths with 404 and known paths with 405", async () => {
			const missing = await send("GET", "/nothing/here", { headers: { "x-session-token": employeeToken } });
			expect(missing.status).to.equal(404);
			expect(bodyOf(missing)).to.deep.include({ code: "not_found", instance: "/nothing/here" });

			const wrongMethod = await send("PATCH", "/health");
			expect(wrongMethod.status).to.equal(405);
			expect(wrongMethod.headers.allow).to.equal("GET");
			expect(bodyOf(wrongMethod).code).to.equal("method_not_allowed");
		});

		it("sets the security headers on every response", async () => {
			const ok = await send("GET", "/health");
			expect(ok.headers).to.deep.include({
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
			});

			const problem = await send("GET", "/nothing", { headers: { "x-session-token": employeeToken } });
			expect(problem.headers["content-type"]).to.equal("application/problem+json; charset=utf-8");
			expect(problem.headers["cache-control"]).to.equal("no-store");
		});
	});

	describe("authentication and permissions", () => {
		it("requires a session for protected routes", async () => {
			const missing = await send("GET", "/me");
			expect(missing.status).to.equal(401);
			expect(bodyOf(missing).code).to.equal("no_session");

			const invalid = await send("GET", "/me", { headers: { "x-session-token": "fremd" } });
			expect(invalid.status).to.equal(401);
			expect(bodyOf(invalid).code).to.equal("no_session");

			const ok = await send("GET", "/me", { headers: { "x-session-token": employeeToken } });
			expect(ok.status).to.equal(200);
			expect(bodyOf(ok)).to.deep.include({ login: "anna" });
		});

		it("enforces the permission of a route", async () => {
			const denied = await send("GET", "/users", { headers: { "x-session-token": employeeToken } });
			expect(denied.status).to.equal(403);
			expect(bodyOf(denied).code).to.equal("permission_denied");

			const allowed = await send("GET", "/users", { headers: { "x-session-token": adminToken } });
			expect(allowed.status).to.equal(200);
		});

		it("requires a CSRF token for state changing requests of a browser", async () => {
			// the browser sends the httpOnly session cookie by itself — that is the credential a foreign page
			// could ride on, so exactly this case needs the CSRF token
			const browser = { cookie: `${SESSION_COOKIE}=${employeeToken}` };
			const withoutToken = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1 }),
				headers: { ...browser, "content-type": "application/json" },
			});
			expect(withoutToken.status).to.equal(403);
			expect(bodyOf(withoutToken).code).to.equal("csrf_rejected");

			const wrongToken = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1 }),
				headers: { ...browser, "x-csrf-token": "falsch" },
			});
			expect(wrongToken.status).to.equal(403);

			const ok = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1234 }),
				headers: { ...browser, "x-csrf-token": employeeCsrf },
			});
			expect(ok.status).to.equal(201);
			expect(bodyOf(ok)).to.deep.equal({ echo: { tsUtc: 1234 } });
			expect(ok.headers.location).to.equal("/time/entries/1");
		});

		it("needs no CSRF token for a bearer client", async () => {
			// a foreign page cannot equip a request with a header, so a pure bearer request cannot be forged
			// (specification 4.10: CSRF applies to cookie authentication only)
			const response = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 5 }),
				headers: { "x-session-token": employeeToken, "content-type": "application/json" },
			});
			expect(response.status).to.equal(201);
		});

		it("authenticates a browser with the session cookie alone", async () => {
			const response = await send("GET", "/me", { headers: { cookie: `${SESSION_COOKIE}=${employeeToken}` } });
			expect(response.status).to.equal(200);
			expect(bodyOf<{ login: string }>(response).login).to.equal("anna");
		});

		it("reports how the session came in and whether the client talks HTTPS", async () => {
			const withoutCookie = await send("GET", "/session-info", { headers: { "x-session-token": employeeToken } });
			expect(bodyOf(withoutCookie)).to.deep.equal({
				token: employeeToken,
				viaCookie: false,
				secure: false,
				address: "127.0.0.1",
			});

			const withCookie = await send("GET", "/session-info", {
				headers: { cookie: `${SESSION_COOKIE}=${employeeToken}` },
			});
			expect(bodyOf(withCookie)).to.deep.equal({
				token: employeeToken,
				viaCookie: true,
				secure: false,
				address: "127.0.0.1",
			});

			// the HTTPS flag only becomes true through a trusted proxy, never because a client claims it
			const proxied = createRouter({ auth, now: () => 2000, trustProxy: true });
			proxied.add({
				method: "GET",
				path: "/session-info",
				handler: context => json(200, { secure: context.secure, address: context.request.remoteAddress }),
			});
			const claimed = await proxied.handle({
				method: "GET",
				path: "/session-info",
				headers: { cookie: `${SESSION_COOKIE}=${employeeToken}`, "x-forwarded-proto": "https" },
				remoteAddress: "192.0.2.1",
			});
			expect(bodyOf(claimed)).to.deep.equal({ secure: true, address: "192.0.2.1" });

			const untrusted = await send("GET", "/session-info", {
				headers: { "x-session-token": employeeToken, "x-forwarded-proto": "https" },
			});
			expect(bodyOf<{ secure: boolean }>(untrusted).secure).to.equal(false);
		});

		it("renews the cookie of an old browser session and drops the old token", async () => {
			// the seeded lifetime is 720 minutes, so the rotation is due after half of it (six hours)
			const started = auth.login({ login: "anna", password, now: 1000 });
			expect(started.ok).to.equal(true);
			const oldToken = started.ok ? started.token : "";

			const browser = createRouter({ auth, now: () => 1000 + 21601 });
			browser.add({
				method: "GET",
				path: "/session-info",
				handler: context => json(200, { login: context.auth?.user.login, token: context.sessionToken }),
			});

			const response = await browser.handle({
				method: "GET",
				path: "/session-info",
				headers: { cookie: `${SESSION_COOKIE}=${oldToken}` },
				remoteAddress: "127.0.0.1",
			});
			expect(response.status).to.equal(200);
			const renewed = /zt_session=([^;]+)/.exec(response.headers["set-cookie"] ?? "")?.[1];
			expect(renewed, "the response carries a fresh cookie").to.be.a("string");
			expect(renewed).to.not.equal(oldToken);

			// the old token is gone, the new one carries the session on
			expect(auth.authenticate({ token: oldToken, now: 1000 + 21601 }).ok).to.equal(false);
			expect(auth.authenticate({ token: renewed ?? "", now: 1000 + 21601 }).ok).to.equal(true);

			// a bearer client is never rotated: it holds no cookie that could be replaced silently
			const bearer = await browser.handle({
				method: "GET",
				path: "/session-info",
				headers: { "x-session-token": renewed ?? "" },
				remoteAddress: "127.0.0.1",
			});
			expect(bearer.status).to.equal(200);
			expect(bearer.headers["set-cookie"]).to.equal(undefined);
		});

		it("uses the forwarded address only for a trusted proxy", async () => {
			const build = (trustProxy: boolean): Router => {
				const instance = createRouter({ auth, now: () => 2000, trustProxy });
				instance.add({
					method: "GET",
					path: "/limited",
					requiresAuth: false,
					rateLimit: { name: "proxy-limited", limit: 1, windowSeconds: 60 },
					handler: () => json(200, { ok: true }),
				});
				instance.add({
					method: "GET",
					path: "/session-info",
					requiresAuth: false,
					handler: context => json(200, { address: context.request.remoteAddress }),
				});
				return instance;
			};
			const distrusting = build(false);
			const trusting = build(true);
			const call = (instance: Router, headers: Record<string, string>): Promise<HttpResponse> =>
				instance.handle({ method: "GET", path: "/limited", headers, remoteAddress: "192.0.2.1" });

			// a client that sets the header itself must not get a bucket of its own …
			expect((await call(distrusting, { "x-forwarded-for": "10.0.0.7" })).status).to.equal(200);
			expect((await call(distrusting, { "x-forwarded-for": "10.0.0.8" })).status).to.equal(429);

			// … while a trusted proxy really separates the clients behind it
			expect((await call(trusting, { "x-forwarded-for": "10.0.0.7" })).status).to.equal(200);
			expect((await call(trusting, { "x-forwarded-for": "10.0.0.8" })).status).to.equal(200);

			// the rightmost hop is the one the proxy appended; the left part is client controlled
			const forwarded = await trusting.handle({
				method: "GET",
				path: "/session-info",
				headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.5" },
				remoteAddress: "192.0.2.1",
			});
			expect(bodyOf<{ address: string }>(forwarded).address).to.equal("203.0.113.5");

			const ignored = await distrusting.handle({
				method: "GET",
				path: "/session-info",
				headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.5" },
				remoteAddress: "192.0.2.1",
			});
			expect(bodyOf<{ address: string }>(ignored).address).to.equal("192.0.2.1");
		});

		it("does not require a session for public routes", async () => {
			expect((await send("GET", "/health")).status).to.equal(200);
		});
	});

	describe("bodies and errors", () => {
		it("rejects bodies above the limit", async () => {
			const response = await send("POST", "/punch", {
				body: JSON.stringify({ note: "x".repeat(200) }),
				headers: { "x-session-token": employeeToken, "x-csrf-token": employeeCsrf },
			});

			expect(response.status).to.equal(413);
			expect(bodyOf(response).code).to.equal("payload_too_large");
		});

		it("rejects unusable bodies", async () => {
			const headers = { "x-session-token": employeeToken, "x-csrf-token": employeeCsrf };

			const broken = await send("POST", "/punch", { body: "{not json", headers });
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.equal("body is not valid JSON");

			const empty = await send("POST", "/punch", { headers });
			expect(empty.status).to.equal(400);
			expect(bodyOf(empty).detail).to.equal("body is required");

			const wrongType = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1 }),
				headers: { ...headers, "content-type": "text/plain" },
			});
			expect(wrongType.status).to.equal(415);
			expect(bodyOf(wrongType).code).to.equal("unsupported_media_type");
		});

		it("answers with 204 and without content-type for empty responses", async () => {
			const response = await send("DELETE", "/punch", {
				headers: { "x-session-token": employeeToken, "x-csrf-token": employeeCsrf },
			});

			expect(response.status).to.equal(204);
			expect(response.body).to.equal("");
			expect(response.headers).to.not.have.property("content-type");
		});

		it("distinguishes a required from an optional JSON body", async () => {
			// `jsonBody()` needs a body, `optionalJsonBody()` answers `{}` for a DELETE without one
			const missing = await send("POST", "/body-required", {
				headers: { "x-session-token": employeeToken, "x-csrf-token": employeeCsrf },
			});
			expect(missing.status).to.equal(400);
			expect(bodyOf(missing).detail).to.equal("body is required");

			const optional = await send("DELETE", "/body-optional", {
				headers: { "x-session-token": employeeToken, "x-csrf-token": employeeCsrf },
			});
			expect(optional.status).to.equal(200);
			expect(bodyOf(optional)).to.deep.equal({ received: {} });
		});

		it("limits a route per client address", async () => {
			// `/limited` answers twice per minute and client
			const first = await send("GET", "/limited", { headers: { "x-session-token": employeeToken } });
			const second = await send("GET", "/limited", { headers: { "x-session-token": employeeToken } });
			expect(first.status).to.equal(200);
			expect(second.status).to.equal(200);

			const blocked = await send("GET", "/limited", { headers: { "x-session-token": employeeToken } });
			expect(blocked.status).to.equal(429);
			expect(bodyOf(blocked)).to.deep.include({ status: 429, code: "rate_limited" });
			expect(blocked.headers["retry-after"]).to.equal("60");
			expect(blocked.headers["content-type"]).to.equal("application/problem+json; charset=utf-8");

			// the limit counts per client, so another address still gets through
			const other = await send("GET", "/limited", {
				headers: { "x-session-token": employeeToken },
				remoteAddress: "10.0.0.9",
			});
			expect(other.status).to.equal(200);
		});

		it("converts handler errors into problems", async () => {
			const notFound = await send("GET", "/boom", { headers: { "x-session-token": employeeToken } });
			expect(notFound.status).to.equal(404);
			expect(bodyOf(notFound)).to.deep.include({ code: "not_found", instance: "/boom" });

			const crash = await send("GET", "/crash", { headers: { "x-session-token": employeeToken } });
			expect(crash.status).to.equal(500);
			expect(bodyOf(crash).code).to.equal("internal_error");
			expect(crash.body).to.not.contain("internal detail");
		});

		it("passes a binary download through unchanged", async () => {
			const response = await send("GET", "/download", { headers: { "x-session-token": employeeToken } });

			expect(response.status).to.equal(200);
			expect(response.headers["content-type"]).to.equal("application/octet-stream");
			expect(response.headers["content-disposition"]).to.equal('attachment; filename="export.bin"');
			expect(Buffer.isBuffer(response.body)).to.equal(true);
			expect([...(response.body as Buffer)]).to.deep.equal([1, 2, 3]);
		});

		it("writes a text download without JSON encoding", async () => {
			const response = await send("GET", "/export.csv", { headers: { "x-session-token": employeeToken } });

			expect(response.headers["content-type"]).to.equal("text/csv; charset=utf-8");
			expect(response.body.toString()).to.equal("a,b\n1,2\n");
			expect(response.body.toString()).to.not.contain('"a,b');
		});
	});
});
