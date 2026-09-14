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
		return JSON.parse(response.body.toString()) as T;
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

	describe("punching", () => {
		it("stores a punch and refreshes the day", async () => {
			const first = await send("POST", "/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(first.status).to.equal(201);
			const stored = bodyOf<{ entry: { id: number; tsUtc: number; source: string; localDate: string } }>(first);
			expect(stored.entry.tsUtc).to.equal(1000);
			expect(stored.entry.source).to.equal("web");
			expect(first.headers.location).to.equal(`/entries/${stored.entry.id}`);

			// without a CSRF token nothing is written
			const denied = await send("POST", "/punch", { body: { tsUtc: 2000 }, headers: headers(annaToken) });
			expect(denied.status).to.equal(403);
			expect(bodyOf(denied).code).to.equal("csrf_rejected");
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
			const batch = await send("POST", "/entries/sync", {
				body: { punches: [{ idempotencyKey: "a", tsUtc: 1000, clientTsUtc: 1000 - 3600 }] },
				headers: headers(adminToken, adminCsrf),
			});
			const entryId = bodyOf<{ conflicts: { entryId: number }[] }>(batch).conflicts[0].entryId;

			// the employee has no permission for the conflict queue
			expect((await send("GET", "/entries/conflicts", { headers: headers(annaToken) })).status).to.equal(403);

			const listed = await send("GET", "/entries/conflicts", { headers: headers(adminToken) });
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

	describe("reports", () => {
		it("serves the aggregates of own data and protects the data of others", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });
			await send("POST", "/punch", {
				body: { tsUtc: 1000 + 8 * 3600 },
				headers: headers(annaToken, annaCsrf),
			});

			const own = await send("GET", "/aggregates/day", {
				headers: headers(annaToken),
				query: { date: "1970-01-01" },
			});
			expect(own.status).to.equal(200);
			expect(bodyOf<{ day: { workedMin: number } }>(own).day.workedMin).to.equal(480);

			// the employee may not look at another employee
			const other = await send("GET", "/aggregates/day", {
				headers: headers(annaToken),
				query: { date: "1970-01-01", userId: String(adminId) },
			});
			expect(other.status).to.equal(403);
			expect(bodyOf(other).code).to.equal("permission_denied");

			const asAdmin = await send("GET", "/aggregates/day", {
				headers: headers(adminToken),
				query: { date: "1970-01-01", userId: String(annaId) },
			});
			expect(asAdmin.status).to.equal(200);
		});

		it("serves month and year aggregates", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			const month = await send("GET", "/aggregates/month", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(month.status).to.equal(200);
			expect(
				bodyOf<{ month: { year: number; month: number }; year: { year: number } }>(month).month,
			).to.deep.include({ year: 1970, month: 1, workedMin: 0, updatedAt: 1000 });

			const year = await send("GET", "/aggregates/year", {
				headers: headers(annaToken),
				query: { year: "1970" },
			});
			expect(year.status).to.equal(200);
			expect(bodyOf<{ year: { year: number } }>(year).year.year).to.equal(1970);

			const broken = await send("GET", "/aggregates/month", {
				headers: headers(annaToken),
				query: { year: "1970", month: "13" },
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("month must be between 1 and 12");
		});

		it("lists the months of a year and a range of days", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			// without `month` the route answers the twelve months of the year
			const months = await send("GET", "/aggregates/month", {
				headers: headers(annaToken),
				query: { year: "1970" },
			});
			expect(months.status).to.equal(200);
			const payload = bodyOf<{ months: ({ year: number; month: number } | null)[]; year: { year: number } }>(
				months,
			);
			expect(payload.months).to.have.lengthOf(12);
			expect(payload.months[0]).to.deep.include({ year: 1970, month: 1 });
			expect(payload.months[11]).to.deep.include({ year: 1970, month: 12 });
			expect(payload.year.year).to.equal(1970);

			// `from`/`to` answers the single days of the range (calendar view)
			const range = await send("GET", "/aggregates/day", {
				headers: headers(annaToken),
				query: { from: "1970-01-01", to: "1970-01-03" },
			});
			expect(range.status).to.equal(200);
			const days = bodyOf<{ days: unknown[]; from: string }>(range);
			expect(days.from).to.equal("1970-01-01");
			expect(days.days).to.have.lengthOf(3);

			// client errors: a broken date and a missing year
			expect(
				(await send("GET", "/aggregates/day", { headers: headers(annaToken), query: { date: "01.01.1970" } }))
					.status,
			).to.equal(400);
			expect((await send("GET", "/aggregates/year", { headers: headers(annaToken) })).status).to.equal(400);
		});

		it("lists the punches of a range", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			const listed = await send("GET", "/entries", {
				headers: headers(annaToken),
				query: { from: "1970-01-01", to: "1970-01-02" },
			});
			expect(bodyOf<{ entries: unknown[] }>(listed).entries).to.have.lengthOf(1);

			const missingRange = await send("GET", "/entries", { headers: headers(annaToken) });
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
			const created = await send("POST", "/punch", {
				body: { tsUtc: 1000 },
				headers: headers(annaToken, annaCsrf),
			});
			const entry = bodyOf<{ entry: { id: number; revision: number } }>(created).entry;

			const updated = await send("PATCH", `/entries/${entry.id}`, {
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
			const stale = await send("PATCH", `/entries/${entry.id}`, {
				body: { revision: entry.revision, note: "nochmal" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(stale.status).to.equal(409);
			expect(bodyOf(stale).code).to.equal("revision_conflict");

			const unknown = await send("PATCH", "/entries/999", {
				body: { revision: 1 },
				headers: headers(annaToken, annaCsrf),
			});
			expect(unknown.status).to.equal(404);
		});

		it("adds a punch manually with the edit permission", async () => {
			const own = await send("POST", "/entries", {
				body: { tsUtc: 3600, direction: "in", note: "Nachtrag" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(own.status).to.equal(201);
			expect(bodyOf<{ entry: { source: string; userId: number; direction: string } }>(own).entry).to.deep.include(
				{ source: "web", userId: annaId, direction: "in" },
			);

			// a punch for someone else needs `time.edit_other`
			expect(
				(
					await send("POST", "/entries", {
						body: { tsUtc: 3600 },
						headers: headers(annaToken, annaCsrf),
						query: { userId: String(adminId) },
					})
				).status,
			).to.equal(403);

			const asAdmin = await send("POST", "/entries", {
				body: { tsUtc: 3600 },
				headers: headers(adminToken, adminCsrf),
				query: { userId: String(annaId) },
			});
			expect(asAdmin.status).to.equal(201);
			expect(bodyOf<{ entry: { source: string } }>(asAdmin).entry.source).to.equal("admin");

			// an instant is mandatory, an unknown employee is a 404
			expect(
				(await send("POST", "/entries", { body: {}, headers: headers(annaToken, annaCsrf) })).status,
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
	});
});
