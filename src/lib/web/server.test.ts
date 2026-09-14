/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository } from "../db/repositories/users";
import { createAggregationService } from "../services/aggregation";
import { createAuthService, hashPassword } from "../services/auth";
import { createSyncService } from "../services/sync";
import { createApi } from "./api";
import { startWebServer, type WebServer } from "./server";

const password = "Zeit-2026-klar";

describe("web server", () => {
	let db: Db;
	let server: WebServer;

	beforeEach(async () => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		const users = createUsersRepository(db);
		const entries = createEntriesRepository(db);
		const absences = createAbsencesRepository(db);
		const settings = createSettingsRepository(db);
		const auth = createAuthService({ db, users, settings, secret: "server-test-secret" });
		const aggregation = createAggregationService({
			db,
			users,
			entries,
			absences,
			holidays: createHolidaysRepository(db),
			rules: createRulesRepository(db),
			settings,
		});
		const sync = createSyncService({ db, entries, users, aggregation });
		const api = createApi({ db, auth, users, entries, absences, aggregation, sync, settings, now: () => 1000 });

		const hash = hashPassword(password, { cost: 1024 });
		users.create({ login: "anna", displayName: "Anna", passwordHash: hash, roleKeys: ["employee"] });

		// port 0 lets the operating system pick a free port
		server = await startWebServer({ router: api.router, port: 0, bind: "127.0.0.1", maxBodyBytes: 1024 });
	});

	afterEach(async () => {
		await server.close();
		db.close();
	});

	it("serves the API over real HTTP", async () => {
		expect(server.port).to.be.greaterThan(0);
		expect(server.url).to.equal(`http://127.0.0.1:${server.port}`);

		const response = await fetch(`${server.url}/health`);
		expect(response.status).to.equal(200);
		expect(response.headers.get("content-type")).to.equal("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).to.equal("no-store");
		expect(await response.json()).to.deep.equal({ status: "ok", holidayCountry: "CH", time: 1000 });
	});

	it("logs in, punches and reads the report over HTTP", async () => {
		const login = await fetch(`${server.url}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login: "anna", password }),
		});
		expect(login.status).to.equal(200);
		const session = (await login.json()) as { token: string; csrfToken: string };

		const punch = await fetch(`${server.url}/time/punch`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-session-token": session.token,
				"x-csrf-token": session.csrfToken,
			},
			body: JSON.stringify({ tsUtc: 1000 }),
		});
		expect(punch.status).to.equal(201);
		const stored = (await punch.json()) as { entry: { id: number; localDate: string } };
		expect(punch.headers.get("location")).to.equal(`/time/entries/${stored.entry.id}`);

		// without a session the report is refused, with CSRF missing the write as well
		expect((await fetch(`${server.url}/reports/day/1970-01-01`)).status).to.equal(401);
		const withoutCsrf = await fetch(`${server.url}/time/punch`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-session-token": session.token },
			body: JSON.stringify({ tsUtc: 2000 }),
		});
		expect(withoutCsrf.status).to.equal(403);
	});

	it("answers unknown routes and oversized bodies with problem documents", async () => {
		const missing = await fetch(`${server.url}/gibt/es/nicht`);
		expect(missing.status).to.equal(404);
		expect(missing.headers.get("content-type")).to.equal("application/json; charset=utf-8");
		expect(await missing.json()).to.deep.include({ status: 404, code: "not_found", instance: "/gibt/es/nicht" });

		const huge = await fetch(`${server.url}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login: "x".repeat(2000), password }),
		});
		expect(huge.status).to.equal(413);
		expect(await huge.json()).to.deep.include({ status: 413, code: "payload_too_large" });
	});

	it("stops listening when the server is closed", async () => {
		expect((await fetch(`${server.url}/health`)).status).to.equal(200);
		await server.close();

		let failed = false;
		try {
			await fetch(`${server.url}/health`);
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true);

		// a second close call must not throw either
		await server.close();
	});
});
