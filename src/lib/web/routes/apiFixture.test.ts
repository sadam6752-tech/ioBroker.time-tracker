/// <reference types="mocha" />
/**
 * The shared test bed of the API tests: an in-memory database with two signed-in accounts (`anna`, `admin`),
 * the API on top of it and the helpers that send a request. Every test file calls `useApiFixture()` inside its
 * `describe`, so each test starts with a fresh database. The `let` bindings are live: a test reads the values
 * of the running test.
 */
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAndMigrate, type Db } from "../../db/database";
import { seed } from "../../db/seed";
import { createAbsencesRepository, type AbsencesRepository } from "../../db/repositories/absences";
import { createDayNotesRepository, type DayNotesRepository } from "../../db/repositories/dayNotes";
import { createEntriesRepository, type EntriesRepository } from "../../db/repositories/entries";
import { createHolidaysRepository, type HolidaysRepository } from "../../db/repositories/holidays";
import { createPayoutsRepository, type PayoutsRepository } from "../../db/repositories/payouts";
import { createTerminalsRepository, type TerminalsRepository } from "../../db/repositories/terminals";
import { createTriggersRepository, type TriggersRepository } from "../../db/repositories/triggers";
import { createAutomationsRepository, type AutomationsRepository } from "../../db/repositories/automations";
import { createRfidRepository, type RfidRepository } from "../../db/repositories/rfid";
import { createRulesRepository, type RulesRepository } from "../../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../../db/repositories/users";
import { createAggregationService, type AggregationService } from "../../services/aggregation";
import { createAuthService, hashPassword, type AuthService } from "../../services/auth";
import { createSyncService, type SyncService } from "../../services/sync";
import { createBackupService, type BackupService } from "../../services/backup";
import { createApi, type Api } from "../api";
import { type HttpResponse } from "../router";

export const SECRET = "api-test-secret";
export const password = "Zeit-2026-klar";

/** Secret used to sign RFID tag links in the tests. */
export const TAG_SECRET = "tag-test-secret";

export let db: Db;
export let users: UsersRepository;
export let entries: EntriesRepository;
export let absences: AbsencesRepository;
export let dayNotes: DayNotesRepository;
export let holidays: HolidaysRepository;
export let rules: RulesRepository;
export let payouts: PayoutsRepository;
export let terminals: TerminalsRepository;
export let rfid: RfidRepository;
export let triggers: TriggersRepository;
export let automations: AutomationsRepository;
/** How often the API told the adapter about a changed rule table. */
export let hookCalls = 0;
export let aggregation: AggregationService;
export let sync: SyncService;
export let auth: AuthService;
export let settings: SettingsRepository;
export let backup: BackupService;
export let backupDir: string;
export let api: Api;
export let annaId: number;
export let adminId: number;
export let annaToken: string;
export let annaCsrf: string;
export let adminToken: string;
export let adminCsrf: string;
/** Clock of the API; a test that needs the past or the future moves it. */
export let clock = 1000;

/**
 * Sends a request through the API.
 *
 * @param method - HTTP method
 * @param path - request path
 * @param options - body, headers and query parameters
 * @param options.body - body object (serialised as JSON)
 * @param options.rawBody - body as bytes, sent as it is (an upload)
 * @param options.headers - request headers
 * @param options.query - query parameters
 * @returns response
 */
export async function send(
	method: string,
	path: string,
	options: {
		body?: unknown;
		rawBody?: Buffer;
		headers?: Record<string, string>;
		query?: Record<string, string>;
	} = {},
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
		body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
		remoteAddress: "127.0.0.1",
	});
}

/**
 * Parses the response body.
 *
 * @param response - HTTP response
 * @returns parsed body
 */
export function bodyOf<T = Record<string, unknown>>(response: HttpResponse): T {
	return JSON.parse(response.body.toString()) as T;
}

/**
 * Builds the headers of an authenticated request.
 *
 * @param token - session token
 * @param csrfToken - CSRF token
 * @returns header map
 */
export function headers(token: string, csrfToken?: string): Record<string, string> {
	return csrfToken ? { "x-session-token": token, "x-csrf-token": csrfToken } : { "x-session-token": token };
}

/**
 * Moves the clock of the API (a test that needs the past or the future).
 *
 * @param value - new instant, UTC epoch seconds
 */
export function setClock(value: number): void {
	clock = value;
}

/**
 * Registers the hooks that build a fresh test bed before every test and remove it afterwards.
 */
export function useApiFixture(): void {
	beforeEach(async () => {
		clock = 1000;
		hookCalls = 0;
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		absences = createAbsencesRepository(db);
		dayNotes = createDayNotesRepository(db);
		holidays = createHolidaysRepository(db);
		rules = createRulesRepository(db);
		payouts = createPayoutsRepository(db);
		terminals = createTerminalsRepository(db);
		rfid = createRfidRepository(db);
		triggers = createTriggersRepository(db);
		automations = createAutomationsRepository(db);
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
		backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "time-tracker-api-backup-"));
		backup = createBackupService({ db, dir: backupDir, now: () => 1000 });
		api = createApi({
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
			backup,
			kioskEnabled: true,
			hmacSecret: TAG_SECRET,
			now: () => clock,
			version: "9.9.9",
			onTriggerRulesChanged: () => {
				hookCalls += 1;
			},
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
}
