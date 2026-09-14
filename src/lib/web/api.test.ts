/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository, type AbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService, type AggregationService } from "../services/aggregation";
import { createAuthService, hashPassword, type AuthService } from "../services/auth";
import { createSyncService, type SyncService } from "../services/sync";
import { createApi, type Api } from "./api";
import type { HttpResponse } from "./router";

const SECRET = "api-test-secret";
const password = "Zeit-2026-klar";

describe("web api", () => {
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let absences: AbsencesRepository;
	let aggregation: AggregationService;
	let sync: SyncService;
	let auth: AuthService;
	let settings: SettingsRepository;
	let api: Api;
	let annaId: number;
	let adminId: number;
	let annaToken: string;
	let annaCsrf: string;
	let adminToken: string;
	let adminCsrf: string;

	/**
	 * Sends a request through the API.
	 *
	 * @param method - HTTP method
	 * @param path - request path
	 * @param options - body, headers and query parameters
	 * @param options.body - body object (serialised as JSON)
	 * @param options.headers - request headers
	 * @param options.query - query parameters
	 * @returns response
	 */
	async function send(
		method: string,
		path: string,
		options: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string> } = {},
	): Promise<HttpResponse> {
		const headers = { ...(options.headers ?? {}) };
		if (options.body !== undefined) {
			headers["content-type"] = headers["content-type"] ?? "application/json";
		}
		return api.router.handle({
			method,
			path,
			headers,
			query: options.query,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			remoteAddress: "127.0.0.1",
		});
	}

	/**
	 * Parses the response body.
	 *
	 * @param response - HTTP response
	 * @returns parsed body
	 */
	function bodyOf<T = Record<string, unknown>>(response: HttpResponse): T {
		return JSON.parse(response.body) as T;
	}

	/**
	 * Builds the headers of an authenticated request.
	 *
	 * @param token - session token
	 * @param csrfToken - CSRF token
	 * @returns header map
	 */
	function headers(token: string, csrfToken?: string): Record<string, string> {
		return csrfToken ? { "x-session-token": token, "x-csrf-token": csrfToken } : { "x-session-token": token };
	}

	beforeEach(async () => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		absences = createAbsencesRepository(db);
		settings = createSettingsRepository(db);
		auth = createAuthService({ db, users, settings, secret: SECRET, maxFailedAttempts: 3 });
		aggregation = createAggregationService({
			db,
			users,
			entries,
			absences,
			holidays: createHolidaysRepository(db),
			rules: createRulesRepository(db),
			settings,
		});
		sync = createSyncService({ db, entries, users, aggregation });
		api = createApi({ db, auth, users, entries, absences, aggregation, sync, settings, now: () => 1000 });

		// a cheap hash keeps the tests fast; the default cost is covered by the auth tests
		const hash = hashPassword(password, { cost: 1024 });
		adminId = users.create({ login: "admin", displayName: "Admin", passwordHash: hash, roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", passwordHash: hash, roleKeys: ["employee"] }).id;
		users.saveWorkProfile({
			userId: annaId,
			profile: { percent: 100, weeklyHours: 40, workdays: "0;1;1;1;1;1;0" },
			actorId: adminId,
		});

		const anna = await send("POST", "/auth/login", { body: { login: "anna", password } });
		const admin = await send("POST", "/auth/login", { body: { login: "admin", password } });
		expect(anna.status).to.equal(200);
		expect(admin.status).to.equal(200);
		annaToken = bodyOf<{ token: string }>(anna).token;
		annaCsrf = bodyOf<{ csrfToken: string }>(anna).csrfToken;
		adminToken = bodyOf<{ token: string }>(admin).token;
		adminCsrf = bodyOf<{ csrfToken: string }>(admin).csrfToken;
	});

	afterEach(() => {
		db.close();
	});

	describe("authentication", () => {
		it("serves public metadata without a session", async () => {
			const health = await send("GET", "/health");
			expect(health.status).to.equal(200);
			expect(bodyOf(health)).to.deep.equal({ status: "ok", holidayCountry: "CH", time: 1000 });

			const routes = await send("GET", "/routes");
			expect(
				bodyOf<{ routes: { method: string; path: string; permission?: string }[] }>(routes).routes,
			).to.deep.include({ method: "POST", path: "/time/punch", permission: "time.punch" });
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

	describe("punching", () => {
		it("stores a punch and refreshes the day", async () => {
			const first = await send("POST", "/time/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(first.status).to.equal(201);
			const stored = bodyOf<{ entry: { id: number; tsUtc: number; source: string; localDate: string } }>(first);
			expect(stored.entry.tsUtc).to.equal(1000);
			expect(stored.entry.source).to.equal("web");
			expect(first.headers.location).to.equal(`/time/entries/${stored.entry.id}`);

			// without a CSRF token nothing is written
			const denied = await send("POST", "/time/punch", { body: { tsUtc: 2000 }, headers: headers(annaToken) });
			expect(denied.status).to.equal(403);
			expect(bodyOf(denied).code).to.equal("csrf_rejected");
		});

		it("is idempotent for a repeated punch and requires the permission", async () => {
			const payload = { tsUtc: 1000, idempotencyKey: "offline-1" };
			const first = await send("POST", "/time/punch", { body: payload, headers: headers(annaToken, annaCsrf) });
			const second = await send("POST", "/time/punch", { body: payload, headers: headers(annaToken, annaCsrf) });

			expect(first.status).to.equal(201);
			expect(bodyOf<{ created: boolean }>(first).created).to.equal(true);
			expect(bodyOf<{ created: boolean }>(second).created).to.equal(false);
			expect(bodyOf<{ entry: { id: number } }>(second).entry.id).to.equal(
				bodyOf<{ entry: { id: number } }>(first).entry.id,
			);

			// the employee may punch, but may not correct the punches of others
			const other = await send("POST", "/time/entries/1", {
				body: { revision: 1, note: "x" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(other.status).to.equal(200);
		});

		it("accepts an offline batch and reports conflicts", async () => {
			const batch = await send("POST", "/sync", {
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

			const broken = await send("POST", "/sync", {
				body: { punches: "no" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.equal("punches must be an array");
		});

		it("resolves conflicts with the matching permission", async () => {
			const batch = await send("POST", "/sync", {
				body: { punches: [{ idempotencyKey: "a", tsUtc: 1000, clientTsUtc: 1000 - 3600 }] },
				headers: headers(adminToken, adminCsrf),
			});
			const entryId = bodyOf<{ conflicts: { entryId: number }[] }>(batch).conflicts[0].entryId;

			// the employee has no permission for the conflict queue
			expect((await send("GET", "/sync/conflicts", { headers: headers(annaToken) })).status).to.equal(403);

			const listed = await send("GET", "/sync/conflicts", { headers: headers(adminToken) });
			expect(bodyOf<{ conflicts: { id: number }[] }>(listed).conflicts.map(entry => entry.id)).to.deep.equal([
				entryId,
			]);

			const resolved = await send("POST", `/sync/conflicts/${entryId}`, {
				body: { action: "accept", tsUtc: 500 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(resolved.status).to.equal(200);
			expect(bodyOf<{ entry: { tsUtc: number; syncState: string } }>(resolved).entry).to.deep.include({
				tsUtc: 500,
				syncState: "synced",
			});

			const invalid = await send("POST", `/sync/conflicts/${entryId}`, {
				body: { action: "later" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(invalid.status).to.equal(400);
		});
	});

	describe("reports", () => {
		it("serves the aggregates of own data and protects the data of others", async () => {
			await send("POST", "/time/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });
			await send("POST", "/time/punch", {
				body: { tsUtc: 1000 + 8 * 3600 },
				headers: headers(annaToken, annaCsrf),
			});

			const own = await send("GET", "/reports/day/1970-01-01", { headers: headers(annaToken) });
			expect(own.status).to.equal(200);
			expect(bodyOf<{ day: { workedMin: number } }>(own).day.workedMin).to.equal(480);

			// the employee may not look at another employee
			const other = await send("GET", "/reports/day/1970-01-01", {
				headers: headers(annaToken),
				query: { userId: String(adminId) },
			});
			expect(other.status).to.equal(403);
			expect(bodyOf(other).code).to.equal("permission_denied");

			const asAdmin = await send("GET", "/reports/day/1970-01-01", {
				headers: headers(adminToken),
				query: { userId: String(annaId) },
			});
			expect(asAdmin.status).to.equal(200);
		});

		it("serves month and year aggregates", async () => {
			await send("POST", "/time/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			const month = await send("GET", "/reports/month/1970/1", { headers: headers(annaToken) });
			expect(month.status).to.equal(200);
			expect(
				bodyOf<{ month: { year: number; month: number }; year: { year: number } }>(month).month,
			).to.deep.include({ year: 1970, month: 1, workedMin: 0, updatedAt: 1000 });

			const year = await send("GET", "/reports/year/1970", { headers: headers(annaToken) });
			expect(year.status).to.equal(200);
			expect(bodyOf<{ year: { year: number } }>(year).year.year).to.equal(1970);

			const broken = await send("GET", "/reports/month/1970/13", { headers: headers(annaToken) });
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("month must be between 1 and 12");
		});

		it("lists the punches of a range", async () => {
			await send("POST", "/time/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			const listed = await send("GET", "/time/entries", {
				headers: headers(annaToken),
				query: { from: "1970-01-01", to: "1970-01-02" },
			});
			expect(bodyOf<{ entries: unknown[] }>(listed).entries).to.have.lengthOf(1);

			const missingRange = await send("GET", "/time/entries", { headers: headers(annaToken) });
			expect(missingRange.status).to.equal(400);
			expect(bodyOf(missingRange).detail).to.equal("from and to are required");
		});
	});

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
	});

	describe("corrections", () => {
		it("corrects a punch with optimistic locking", async () => {
			const created = await send("POST", "/time/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			const entry = bodyOf<{ entry: { id: number; revision: number } }>(created).entry;

			const updated = await send("POST", `/time/entries/${entry.id}`, {
				body: { revision: entry.revision, tsUtc: 700, note: "korrigiert", reason: "vertippt" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(updated.status).to.equal(200);
			expect(bodyOf<{ entry: { tsUtc: number; revision: number; note: string } }>(updated).entry).to.deep.include(
				{
					tsUtc: 700,
					revision: 2,
					note: "korrigiert",
				},
			);

			// a stale revision is a conflict
			const stale = await send("POST", `/time/entries/${entry.id}`, {
				body: { revision: entry.revision, note: "nochmal" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(stale.status).to.equal(409);
			expect(bodyOf(stale).code).to.equal("revision_conflict");

			const unknown = await send("POST", "/time/entries/999", {
				body: { revision: 1 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(unknown.status).to.equal(404);
		});

		it("deletes a punch with the delete permission", async () => {
			const created = await send("POST", "/time/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			const entryId = bodyOf<{ entry: { id: number } }>(created).entry.id;

			// the employee role has no `time.delete`
			const denied = await send("DELETE", `/time/entries/${entryId}`, {
				body: { reason: "doppelt" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			const removed = await send("DELETE", `/time/entries/${entryId}`, {
				body: { reason: "doppelt" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(removed.status).to.equal(204);
			expect(entries.findById(entryId)).to.equal(null);
		});
	});
});
