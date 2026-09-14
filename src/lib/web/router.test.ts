/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAuthService, type AuthService } from "../services/auth";
import { NotFoundError } from "../errors";
import { createRouter, json, noContent, type HttpRequest, type HttpResponse, type Router } from "./router";

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
	 * @returns response
	 */
	async function send(
		method: string,
		path: string,
		options: { body?: string; headers?: Record<string, string>; query?: Record<string, string> } = {},
	): Promise<HttpResponse> {
		const request: HttpRequest = {
			method,
			path,
			body: options.body,
			query: options.query,
			headers: options.headers,
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

		it("requires a CSRF token for state changing requests", async () => {
			const withoutToken = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1 }),
				headers: { "x-session-token": employeeToken, "content-type": "application/json" },
			});
			expect(withoutToken.status).to.equal(403);
			expect(bodyOf(withoutToken).code).to.equal("csrf_rejected");

			const wrongToken = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1 }),
				headers: { "x-session-token": employeeToken, "x-csrf-token": "falsch" },
			});
			expect(wrongToken.status).to.equal(403);

			const ok = await send("POST", "/punch", {
				body: JSON.stringify({ tsUtc: 1234 }),
				headers: { "x-session-token": employeeToken, "x-csrf-token": employeeCsrf },
			});
			expect(ok.status).to.equal(201);
			expect(bodyOf(ok)).to.deep.equal({ echo: { tsUtc: 1234 } });
			expect(ok.headers.location).to.equal("/time/entries/1");
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

		it("converts handler errors into problems", async () => {
			const notFound = await send("GET", "/boom", { headers: { "x-session-token": employeeToken } });
			expect(notFound.status).to.equal(404);
			expect(bodyOf(notFound)).to.deep.include({ code: "not_found", instance: "/boom" });

			const crash = await send("GET", "/crash", { headers: { "x-session-token": employeeToken } });
			expect(crash.status).to.equal(500);
			expect(bodyOf(crash).code).to.equal("internal_error");
			expect(crash.body).to.not.contain("internal detail");
		});
	});
});
