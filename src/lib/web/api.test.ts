/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository, type AbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository, type HolidaysRepository } from "../db/repositories/holidays";
import { createPayoutsRepository, type PayoutsRepository } from "../db/repositories/payouts";
import { createTerminalsRepository, type TerminalsRepository } from "../db/repositories/terminals";
import { createRfidRepository, type RfidRepository } from "../db/repositories/rfid";
import { createRulesRepository, type RulesRepository } from "../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { runLegacyImport } from "../legacy/import";

/** The synthetic SMALL-Time fixture (`fixtures/smalltime`), used by the import endpoints. */
const fixture = path.resolve(__dirname, "..", "..", "..", "fixtures", "smalltime");
import { createAggregationService, type AggregationService } from "../services/aggregation";
import { createAuthService, hashPassword, type AuthService } from "../services/auth";
import { createSyncService, type SyncService } from "../services/sync";
import { createBackupService, type BackupService } from "../services/backup";
import { createApi, type Api } from "./api";
import type { HttpResponse } from "./router";

const SECRET = "api-test-secret";
const password = "Zeit-2026-klar";

/** Secret used to sign RFID tag links in the tests. */
const TAG_SECRET = "tag-test-secret";

describe("web api", () => {
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let absences: AbsencesRepository;
	let holidays: HolidaysRepository;
	let rules: RulesRepository;
	let payouts: PayoutsRepository;
	let terminals: TerminalsRepository;
	let rfid: RfidRepository;
	let aggregation: AggregationService;
	let sync: SyncService;
	let auth: AuthService;
	let settings: SettingsRepository;
	let backup: BackupService;
	let backupDir: string;
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
		holidays = createHolidaysRepository(db);
		rules = createRulesRepository(db);
		payouts = createPayoutsRepository(db);
		terminals = createTerminalsRepository(db);
		rfid = createRfidRepository(db);
		settings = createSettingsRepository(db);
		auth = createAuthService({ db, users, settings, secret: SECRET, maxFailedAttempts: 3 });
		aggregation = createAggregationService({
			db,
			users,
			entries,
			absences,
			holidays,
			rules,
			settings,
		});
		sync = createSyncService({ db, entries, users, aggregation });
		backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeiterfassung-api-backup-"));
		backup = createBackupService({ db, dir: backupDir, now: () => 1000 });
		api = createApi({
			db,
			auth,
			users,
			entries,
			absences,
			holidays,
			rules,
			payouts,
			terminals,
			rfid,
			aggregation,
			sync,
			settings,
			backup,
			runImport: options =>
				runLegacyImport({ db, users, entries, absences, rules, settings, payouts, aggregation }, options),
			kioskEnabled: true,
			hmacSecret: TAG_SECRET,
			now: () => 1000,
			version: "9.9.9",
		});

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
		fs.rmSync(backupDir, { recursive: true, force: true });
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

		it("ends the browser session when the password changes", async () => {
			const changed = await send("POST", "/auth/password", {
				body: { password: "Neu-2026-komplett" },
				headers: { cookie: `zt_session=${annaToken}`, "x-csrf-token": annaCsrf },
			});
			expect(changed.status).to.equal(204);
			expect(changed.headers["set-cookie"]).to.contain("Max-Age=0");
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

	describe("master data", () => {
		it("lists absence types and keeps them with the matching permission", async () => {
			const list = await send("GET", "/absence-types", { headers: headers(annaToken) });
			expect(list.status).to.equal(200);
			const types = bodyOf<{ types: { code: string; name: string; factor: number }[] }>(list).types;
			expect(types.map(type => type.code)).to.include("F");
			expect(types.find(type => type.code === "W")?.factor).to.equal(50);

			// managing types needs `absence.manage_types`
			expect(
				(
					await send("POST", "/absence-types", {
						body: { code: "S", name: "Sonderurlaub" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("POST", "/absence-types", {
				body: { code: "S", name: "Sonderurlaub", factor: 100 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			expect(bodyOf(created)).to.deep.include({ created: true });
			expect(bodyOf<{ type: { code: string; name: string } }>(created).type).to.deep.include({
				code: "S",
				name: "Sonderurlaub",
			});

			// the same code updates the existing type instead of creating a second one
			const updated = await send("POST", "/absence-types", {
				body: { code: "s", name: "Sonderurlaub bezahlt" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(updated.status).to.equal(200);
			expect(bodyOf(updated)).to.deep.include({ created: false });
			expect(bodyOf<{ type: { name: string } }>(updated).type.name).to.equal("Sonderurlaub bezahlt");
			expect(absences.types().filter(type => type.code === "S")).to.have.lengthOf(1);

			// a code that is not a short key is refused
			expect(
				(
					await send("POST", "/absence-types", {
						body: { code: "zu lang!", name: "X" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
		});

		it("lists, adds and removes holidays", async () => {
			const seeded = await send("GET", "/holidays", { headers: headers(annaToken), query: { year: "2026" } });
			expect(seeded.status).to.equal(200);
			expect(bodyOf<{ holidays: unknown[] }>(seeded).holidays.length).to.be.greaterThan(0);

			// the year is required and the calendar is an administrative topic
			expect((await send("GET", "/holidays", { headers: headers(annaToken) })).status).to.equal(400);
			expect(
				(
					await send("POST", "/holidays", {
						body: { date: "2026-06-01", name: "Brückentag" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("POST", "/holidays", {
				body: { date: "2026-06-01", name: "Brückentag" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const holidayId = bodyOf<{ holiday: { id: number; year: number } }>(created).holiday.id;
			expect(created.headers.location).to.equal(`/holidays/${holidayId}`);

			const listed = await send("GET", "/holidays", { headers: headers(adminToken), query: { year: "2026" } });
			expect(
				bodyOf<{ holidays: { date: string }[] }>(listed).holidays.some(
					holiday => holiday.date === "2026-06-01",
				),
			).to.equal(true);

			const removed = await send("DELETE", `/holidays/${holidayId}`, {
				headers: headers(adminToken, adminCsrf),
			});
			expect(removed.status).to.equal(204);
			expect(
				(await send("DELETE", `/holidays/${holidayId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(404);
		});

		it("reads and changes instance settings through a whitelist", async () => {
			// `settings.view` and `settings.edit` are administrative rights
			expect((await send("GET", "/settings", { headers: headers(annaToken) })).status).to.equal(403);

			const read = await send("GET", "/settings", { headers: headers(adminToken) });
			expect(read.status).to.equal(200);
			expect(bodyOf<{ settings: Record<string, string> }>(read).settings).to.have.property("quick_round_minutes");

			const changed = await send("PUT", "/settings", {
				body: { quick_round_minutes: 15, absence_calc_until_today: false },
				headers: headers(adminToken, adminCsrf),
			});
			expect(changed.status).to.equal(200);
			expect(settings.get("quick_round_minutes")).to.equal("15");
			expect(settings.get("absence_calc_until_today")).to.equal("false");

			// unknown keys, unsupported values and an empty body are client errors
			expect(
				(await send("PUT", "/settings", { body: { unbekannt: "1" }, headers: headers(adminToken, adminCsrf) }))
					.status,
			).to.equal(400);
			expect(
				(
					await send("PUT", "/settings", {
						body: { edit_window_days: { a: 1 } },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(await send("PUT", "/settings", { body: {}, headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(400);

			// values that look like secrets are never handed out
			settings.set("session_secret", "geheim", adminId);
			const filtered = await send("GET", "/settings", { headers: headers(adminToken) });
			expect(bodyOf<{ settings: Record<string, string> }>(filtered).settings).to.not.have.property(
				"session_secret",
			);
		});

		it("changes and deletes an absence", async () => {
			const created = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-07-06" },
				headers: headers(annaToken, annaCsrf),
			});
			const absenceId = bodyOf<{ absence: { id: number } }>(created).absence.id;

			// the own absence may be corrected, the state is an approval
			const moved = await send("PATCH", `/absences/${absenceId}`, {
				body: { dateTo: "2026-07-08", note: "verlängert" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(moved.status).to.equal(200);
			expect(bodyOf<{ absence: { dateTo: string; note: string } }>(moved).absence).to.deep.include({
				dateTo: "2026-07-08",
				note: "verlängert",
			});

			expect(
				(
					await send("PATCH", `/absences/${absenceId}`, {
						body: { status: "taken" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);
			expect(
				(
					await send("PATCH", `/absences/${absenceId}`, {
						body: { status: "taken" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(200);
			expect(
				(
					await send("PATCH", `/absences/${absenceId}`, {
						body: { status: "irgendwas" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			expect(
				(await send("DELETE", `/absences/${absenceId}`, { headers: headers(annaToken, annaCsrf) })).status,
			).to.equal(204);
			expect(
				(await send("DELETE", `/absences/${absenceId}`, { headers: headers(annaToken, annaCsrf) })).status,
			).to.equal(404);
		});

		it("reports the adapter version without a session", async () => {
			const version = await send("GET", "/version");
			expect(version.status).to.equal(200);
			expect(bodyOf(version)).to.deep.equal({ name: "iobroker.zeiterfassung", version: "9.9.9" });
		});
	});

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
			// the record never contains the hash or the legacy hash
			const raw = JSON.stringify(payload);
			expect(raw).to.not.contain("passwordHash");
			expect(raw).to.not.contain("legacySha1");
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

	describe("kiosk terminal", () => {
		/**
		 * Prepares a terminal with a badge user.
		 *
		 * @param options - whether the employee gets a PIN and whether the device demands one
		 * @param options.pin - true to set the PIN of the employee
		 * @param options.pinRequired - value for the device flag
		 * @returns device token and the requested session
		 */
		async function prepareTerminal(options: { pin: boolean; pinRequired: boolean }): Promise<{
			deviceToken: string;
			terminalSession: string;
		}> {
			await send("PATCH", `/users/${annaId}`, {
				body: { rfidCard: "CARD-42" },
				headers: headers(adminToken, adminCsrf),
			});
			if (options.pin) {
				await send("POST", `/users/${annaId}/pin`, {
					body: { pin: "1234" },
					headers: headers(adminToken, adminCsrf),
				});
			}
			const created = await send("POST", "/terminals", {
				body: { name: "Werkstatt", location: "Halle 1", pinRequired: options.pinRequired },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const deviceToken = bodyOf<{ deviceToken: string }>(created).deviceToken;

			const session = await send("POST", "/terminal/session", { body: { deviceToken } });
			expect(session.status).to.equal(200);
			return { deviceToken, terminalSession: bodyOf<{ terminalSession: string }>(session).terminalSession };
		}

		it("hands out a device token once and punches with badge and PIN", async () => {
			// the status is public so a device can show a setup hint
			const status = await send("GET", "/terminal/status");
			expect(status.status).to.equal(200);
			expect(bodyOf(status)).to.deep.include({ enabled: true, version: "9.9.9" });

			// only administrators manage devices and PINs
			expect((await send("GET", "/terminals", { headers: headers(annaToken) })).status).to.equal(403);
			expect(
				(
					await send("POST", `/users/${annaId}/pin`, {
						body: { pin: "1234" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);
			expect(
				(
					await send("POST", `/users/${annaId}/pin`, {
						body: { pin: "12" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			const { deviceToken, terminalSession } = await prepareTerminal({ pin: true, pinRequired: true });

			// the token is visible exactly once
			const listed = await send("GET", "/terminals", { headers: headers(adminToken) });
			expect(listed.status).to.equal(200);
			expect(JSON.stringify(bodyOf(listed))).to.not.contain(deviceToken);
			expect(bodyOf<{ terminals: { name: string; pinRequired: boolean }[] }>(listed).terminals).to.have.lengthOf(
				1,
			);

			// the selection list stays minimal
			const people = await send("GET", "/terminal/users", { query: { terminalSession } });
			expect(people.status).to.equal(200);
			const people2 = bodyOf<{ users: Record<string, unknown>[] }>(people).users;
			expect(people2).to.have.lengthOf(2);
			expect(Object.keys(people2[0]).sort()).to.deep.equal(["avatarUrl", "displayName", "id", "present"]);

			// a badge alone is not enough when the device demands a PIN
			expect(
				(await send("POST", "/terminal/punch", { body: { terminalSession, badge: "CARD-42" } })).status,
			).to.equal(401);

			const punched = await send("POST", "/terminal/punch", {
				body: { terminalSession, badge: "CARD-42", pin: "1234", tsUtc: 1000 },
			});
			expect(punched.status).to.equal(201);
			expect(bodyOf<{ user: { id: number; displayName: string } }>(punched).user).to.deep.equal({
				id: annaId,
				displayName: "Anna",
			});
			expect(bodyOf<{ entry: { direction: string } }>(punched).entry.direction).to.equal("auto");
			// the state of the day tells the terminal whether the employee is clocked in
			expect(bodyOf<{ day: { hasOpenEntry: boolean } }>(punched).day.hasOpenEntry).to.equal(true);

			// wrong PIN, unknown badge and a stale session are all refused
			expect(
				(
					await send("POST", "/terminal/punch", {
						body: { terminalSession, badge: "CARD-42", pin: "9999" },
					})
				).status,
			).to.equal(401);
			expect(
				(
					await send("POST", "/terminal/punch", {
						body: { terminalSession, badge: "UNBEKANNT", pin: "1234" },
					})
				).status,
			).to.equal(401);
			expect(
				(await send("POST", "/terminal/punch", { body: { terminalSession: "falsch", badge: "CARD-42" } }))
					.status,
			).to.equal(401);
			expect((await send("POST", "/terminal/punch", { body: { terminalSession, pin: "1234" } })).status).to.equal(
				400,
			);

			// the PIN also works without a badge, and the heartbeat keeps the session alive
			const byPin = await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, pin: "1234", tsUtc: 1000 + 8 * 3600 },
			});
			expect(byPin.status).to.equal(201);
			expect(bodyOf<{ day: { hasOpenEntry: boolean; workedMin: number } }>(byPin).day).to.deep.include({
				hasOpenEntry: false,
				workedMin: 480,
			});

			const heartbeat = await send("POST", "/terminal/heartbeat", { body: { terminalSession } });
			expect(heartbeat.status).to.equal(200);
			expect(bodyOf(heartbeat)).to.deep.include({ status: "ok" });

			// revoking the device ends everything
			const terminalId = bodyOf<{ terminals: { id: number }[] }>(listed).terminals[0].id;
			expect(
				(await send("DELETE", `/terminals/${terminalId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(204);
			expect((await send("GET", "/terminal/users", { query: { terminalSession } })).status).to.equal(401);
			expect((await send("POST", "/terminal/session", { body: { deviceToken } })).status).to.equal(401);
		});

		it("blocks an account after too many wrong PINs", async () => {
			const { terminalSession } = await prepareTerminal({ pin: true, pinRequired: true });

			// five wrong PINs inside the window block the account (specification 4.10) …
			for (let attempt = 0; attempt < 5; attempt++) {
				const refused = await send("POST", "/terminal/punch", {
					body: { terminalSession, userId: annaId, pin: "0000" },
				});
				expect(refused.status, `attempt ${attempt + 1}`).to.equal(401);
			}

			// … and now even the correct PIN is refused, no matter whether it comes with the badge
			const blocked = await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, pin: "1234" },
			});
			expect(blocked.status).to.equal(423);
			expect(bodyOf(blocked).code).to.equal("locked_out");
			expect(bodyOf(blocked).detail).to.contain("wrong PINs");

			const withBadge = await send("POST", "/terminal/punch", {
				body: { terminalSession, badge: "CARD-42", pin: "1234" },
			});
			expect(withBadge.status, "the block belongs to the account, not to the input form").to.equal(423);
		});

		it("accepts a badge alone when the device does not ask for a PIN", async () => {
			const { terminalSession } = await prepareTerminal({ pin: false, pinRequired: false });

			const punched = await send("POST", "/terminal/punch", {
				body: { terminalSession, badge: "CARD-42", tsUtc: 1000 },
			});
			expect(punched.status).to.equal(201);

			// without a stored PIN a PIN attempt fails instead of being ignored
			expect(
				(await send("POST", "/terminal/punch", { body: { terminalSession, userId: annaId, pin: "1234" } }))
					.status,
			).to.equal(401);
		});

		it("refuses every terminal call when the kiosk is switched off", async () => {
			const disabled = createApi({
				db,
				auth,
				users,
				entries,
				absences,
				holidays,
				rules,
				payouts,
				terminals,
				rfid,
				aggregation,
				sync,
				settings,
				kioskEnabled: false,
				now: () => 1000,
			});
			const status = await disabled.router.handle({
				method: "GET",
				path: "/terminal/status",
				query: {},
				headers: {},
				remoteAddress: "127.0.0.1",
			});
			expect(status.status).to.equal(200);
			expect(JSON.parse(status.body.toString())).to.deep.include({ enabled: false });

			const session = await disabled.router.handle({
				method: "POST",
				path: "/terminal/session",
				query: {},
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceToken: "egal" }),
				remoteAddress: "127.0.0.1",
			});
			expect(session.status).to.equal(403);
			expect(JSON.parse(session.body.toString())).to.deep.include({ code: "kiosk_disabled" });
		});
	});

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
		});

		it("refuses tag links without a configured secret", async () => {
			const withoutSecret = createApi({
				db,
				auth,
				users,
				entries,
				absences,
				holidays,
				rules,
				payouts,
				terminals,
				rfid,
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

	describe("rate limits and field errors", () => {
		it("answers too many requests with 429 and a retry-after header", async () => {
			// `/rfid/scan` allows 30 scans per minute and client; a bad token still counts
			let last = 0;
			for (let attempt = 1; attempt <= 30; attempt++) {
				const response = await send("POST", "/rfid/scan", { body: { token: "quatsch" } });
				expect(response.status, `attempt ${attempt}`).to.equal(400);
				last = response.status;
			}
			expect(last).to.equal(400);

			const blocked = await send("POST", "/rfid/scan", { body: { token: "quatsch" } });
			expect(blocked.status).to.equal(429);
			expect(bodyOf(blocked)).to.deep.include({ status: 429, code: "rate_limited" });
			expect(Number(blocked.headers["retry-after"])).to.be.greaterThan(0);

			// another route class of the same client is not affected by the counting
			const otherClass = await send("POST", "/terminal/session", { body: { deviceToken: "egal" } });
			expect(otherClass.status).to.equal(401);
		});

		it("reports invalid fields of a request in errors[]", async () => {
			const response = await send("PUT", `/users/${annaId}/profile`, {
				body: { percent: 130, workdays: "1;9", overtimeModel: "taeglich", unbekannt: 1 },
				headers: headers(adminToken, adminCsrf),
			});

			expect(response.status).to.equal(400);
			const problem = bodyOf<{
				code: string;
				detail: string;
				errors?: { path: string; message: string }[];
			}>(response);
			expect(problem.code).to.equal("bad_request");
			expect(problem.detail).to.equal("4 field(s) of the work profile are not valid");
			expect(problem.errors?.map(issue => issue.path).sort()).to.deep.equal([
				"overtimeModel",
				"percent",
				"unbekannt",
				"workdays",
			]);
			expect(problem.errors?.find(issue => issue.path === "percent")?.message).to.contain("between 0 and 100");

			// a valid request carries no `errors[]` at all
			const ok = await send("PUT", `/users/${annaId}/profile`, {
				body: { percent: 80 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(ok.status).to.equal(200);
		});
	});

	describe("exports", () => {
		it("needs a session and the own report permission", async () => {
			const anonymous = await send("GET", "/reports/xls", { query: { year: "1970", month: "1" } });
			expect(anonymous.status).to.equal(401);

			// an employee may read the own month, but not the one of somebody else
			const own = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(own.status).to.equal(200);

			const foreign = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1", userId: String(adminId) },
			});
			expect(foreign.status).to.equal(403);
		});

		it("answers with a workbook of the requested month", async () => {
			// one punch in January 1970, so the statement has a day row
			await send("POST", "/entries", {
				body: { tsUtc: 1_000_000 },
				headers: headers(annaToken, annaCsrf),
			});

			const response = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(response.status).to.equal(200);
			expect(response.headers["content-type"]).to.equal(
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			);
			expect(response.headers["content-disposition"]).to.equal(
				'attachment; filename="zeiterfassung-anna-1970-01.xlsx"',
			);
			expect(response.headers["cache-control"]).to.equal("no-store");

			// the body is a real workbook, not JSON
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
			const sheet = workbook.getWorksheet("1970-01");
			expect(sheet, "worksheet 1970-01").to.be.an("object");
			// the seeded instance language is German, so the statement is German
			const cellText = (address: string): string => {
				const value = sheet?.getCell(address).value;
				return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
			};
			expect(cellText("A2")).to.equal("Mitarbeiter: Anna (anna)");
			expect(cellText("A6")).to.equal("Datum");
			expect(cellText("A7")).to.contain("01.01.1970");
			expect(cellText("A18")).to.contain("12.01.1970");
			// a single punch of the day leaves it open, which the note column says
			expect(cellText("I18")).to.equal("offen");
			expect(sheet?.getCell("D7").numFmt).to.equal("[h]:mm");
			// 31 day rows and the totals row below them
			expect(cellText("A38")).to.equal("Summe");
			expect(cellText("H38")).to.equal("Tage: 31");
		});
		it("answers with a PDF statement of the requested month", async () => {
			const response = await send("GET", "/reports/pdf", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(response.status).to.equal(200);
			expect(response.headers["content-type"]).to.equal("application/pdf");
			expect(response.headers["content-disposition"]).to.equal(
				'attachment; filename="zeiterfassung-anna-1970-01.pdf"',
			);
			expect(response.headers["cache-control"]).to.equal("no-store");
			expect(response.body.toString("latin1").startsWith("%PDF-1.")).to.equal(true);

			// an employee never receives the statement of somebody else
			const foreign = await send("GET", "/reports/pdf", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1", userId: String(adminId) },
			});
			expect(foreign.status).to.equal(403);
		});

		it("refuses a report that needs a font nobody configured", async () => {
			// the employee switches to Russian, which the built-in PDF fonts cannot render
			const updated = await send("PATCH", `/users/${annaId}`, {
				body: { locale: "ru" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(updated.status).to.equal(200);

			const response = await send("GET", "/reports/pdf", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});

			// a clear answer beats a statement with empty boxes
			expect(response.status).to.equal(422);
			const problem = bodyOf<{ code: string; detail: string }>(response);
			expect(problem.code).to.equal("report_font_missing");
			expect(problem.detail).to.contain("report_font_path");

			// the Excel export has no such limitation
			const xls = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(xls.status).to.equal(200);
		});
	});

	describe("backups", () => {
		it("needs backup.run and lists nothing before the first copy", async () => {
			const forbidden = await send("GET", "/backup", { headers: headers(annaToken) });
			expect(forbidden.status).to.equal(403);
			expect(bodyOf(forbidden).code).to.equal("permission_denied");

			const empty = await send("GET", "/backup", { headers: headers(adminToken) });
			expect(empty.status).to.equal(200);
			expect(bodyOf(empty)).to.deep.include({ retentionDays: 30 });
			expect(bodyOf<{ backups: unknown[] }>(empty).backups).to.deep.equal([]);

			const refused = await send("POST", "/backup", { headers: headers(annaToken, annaCsrf) });
			expect(refused.status).to.equal(403);
		});

		it("takes a copy on request and reports it in the list", async () => {
			const created = await send("POST", "/backup", { headers: headers(adminToken, adminCsrf) });
			expect(created.status).to.equal(201);
			const payload = bodyOf<{
				backup: { name: string; sizeBytes: number; users: number; entries: number; schemaVersion: number };
				removed: string[];
			}>(created);
			expect(payload.removed).to.deep.equal([]);
			expect(payload.backup.name).to.equal("zeiterfassung-1970-01-01T00-16-40.sqlite");
			expect(payload.backup.sizeBytes).to.be.greaterThan(0);
			expect(payload.backup.users).to.be.greaterThan(0);
			expect(payload.backup.schemaVersion).to.be.greaterThan(0);

			const list = await send("GET", "/backup", { headers: headers(adminToken) });
			expect(bodyOf<{ backups: { name: string }[] }>(list).backups.map(file => file.name)).to.deep.equal([
				payload.backup.name,
			]);

			// the file really exists on disk and the audit trail knows who wrote it
			expect(fs.existsSync(path.join(backupDir, payload.backup.name))).to.equal(true);
			const audit = db
				.prepare("SELECT actor_id AS actorId FROM audit_log WHERE action = 'backup.create'")
				.get() as { actorId: number };
			expect(audit.actorId).to.equal(adminId);
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

		// legacy import (administration)

		it("runs a legacy import and reports what it found", async () => {
			const response = await send("POST", "/import/run", {
				headers: headers(adminToken, adminCsrf),
				body: { baseDir: fixture, mode: "dry-run" },
			});

			expect(response.status).to.equal(200);
			const report = bodyOf<{
				mode: string;
				status: string;
				stats: { entries: number; goldenMonths: number };
			}>(response);
			expect(report.mode).to.equal("dry-run");
			expect(report.status).to.equal("warnings");
			expect(report.stats.entries).to.equal(16);
			expect(report.stats.goldenMonths).to.equal(12);
			// a dry-run writes nothing: the adapter database stays as it was
			expect((db.prepare("SELECT COUNT(*) AS c FROM time_entries").get() as { c: number }).c).to.equal(0);
			expect((db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c).to.equal(2);
			// the report is stored for the administration
			const runs = await send("GET", "/import/runs", { headers: headers(adminToken) });
			expect(runs.status).to.equal(200);
			expect(bodyOf<{ runs: unknown[] }>(runs).runs).to.have.length(1);
		});

		it("requires the import.run permission and a base directory", async () => {
			const forbidden = await send("POST", "/import/run", {
				headers: headers(annaToken, annaCsrf),
				body: { baseDir: fixture, mode: "dry-run" },
			});
			expect(forbidden.status).to.equal(403);
			expect(bodyOf(forbidden).code).to.equal("permission_denied");

			const incomplete = await send("POST", "/import/run", {
				headers: headers(adminToken, adminCsrf),
				body: {},
			});
			expect(incomplete.status).to.equal(400);
			expect(bodyOf(incomplete).code).to.equal("bad_request");
		});
	});
});
