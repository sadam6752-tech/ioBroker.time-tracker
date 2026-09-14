/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
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
import { createStaticHandler } from "./static";

const password = "Zeit-2026-klar";

describe("web server", () => {
	let db: Db;
	let server: WebServer;
	let www: string;

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

		// a small web interface on disk plus a file outside of it (for the traversal test)
		www = fs.mkdtempSync(path.join(os.tmpdir(), "zeiterfassung-www-"));
		fs.writeFileSync(path.join(www, "index.html"), "<!doctype html><title>Zeiterfassung</title>");
		fs.writeFileSync(path.join(www, "app.js"), "console.log('app');");
		fs.writeFileSync(path.join(www, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		fs.writeFileSync(path.join(os.tmpdir(), "zeiterfassung-secret.txt"), "streng geheim");

		// port 0 lets the operating system pick a free port
		server = await startWebServer({
			router: api.router,
			port: 0,
			bind: "127.0.0.1",
			maxBodyBytes: 1024,
			staticFiles: createStaticHandler({ root: www }),
		});
	});

	afterEach(async () => {
		await server.close();
		fs.rmSync(www, { recursive: true, force: true });
		db.close();
	});

	it("serves the API over real HTTP below the prefix", async () => {
		expect(server.port).to.be.greaterThan(0);
		expect(server.url).to.equal(`http://127.0.0.1:${server.port}`);

		const response = await fetch(`${server.url}/api/health`);
		expect(response.status).to.equal(200);
		expect(response.headers.get("content-type")).to.equal("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).to.equal("no-store");
		expect(await response.json()).to.deep.equal({ status: "ok", holidayCountry: "CH", time: 1000 });
	});

	it("logs in, punches and reads the report over HTTP", async () => {
		const login = await fetch(`${server.url}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login: "anna", password }),
		});
		expect(login.status).to.equal(200);
		const session = (await login.json()) as { token: string; csrfToken: string };

		const punch = await fetch(`${server.url}/api/punch`, {
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
		expect(punch.headers.get("location")).to.equal(`/entries/${stored.entry.id}`);

		// without a session the report is refused, with CSRF missing the write as well
		expect((await fetch(`${server.url}/api/aggregates/day?date=1970-01-01`)).status).to.equal(401);
		const withoutCsrf = await fetch(`${server.url}/api/punch`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-session-token": session.token },
			body: JSON.stringify({ tsUtc: 2000 }),
		});
		expect(withoutCsrf.status).to.equal(403);
	});

	it("serves the web interface and routes unknown paths to the page", async () => {
		const index = await fetch(`${server.url}/`);
		expect(index.status).to.equal(200);
		expect(index.headers.get("content-type")).to.equal("text/html; charset=utf-8");
		expect(index.headers.get("cache-control")).to.equal("no-cache");
		expect(await index.text()).to.contain("Zeiterfassung");

		const asset = await fetch(`${server.url}/app.js`);
		expect(asset.status).to.equal(200);
		expect(asset.headers.get("content-type")).to.equal("text/javascript; charset=utf-8");
		expect(asset.headers.get("cache-control")).to.equal("public, max-age=3600");
		expect(await asset.text()).to.equal("console.log('app');");

		// binary assets keep their bytes
		const logo = await fetch(`${server.url}/logo.png`);
		expect(logo.headers.get("content-type")).to.equal("image/png");
		expect(Buffer.from(await logo.arrayBuffer())).to.deep.equal(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		// a client side route falls back to the page
		const clientRoute = await fetch(`${server.url}/reports/day/2026-01-07`, {
			headers: { accept: "text/html" },
		});
		expect(clientRoute.status).to.equal(200);
		expect(await clientRoute.text()).to.contain("Zeiterfassung");
	});

	it("answers a conditional request with 304", async () => {
		const first = await fetch(`${server.url}/app.js`);
		const etag = first.headers.get("etag") ?? "";
		const modified = first.headers.get("last-modified") ?? "";
		expect(etag).to.not.equal("");

		const second = await fetch(`${server.url}/app.js`, { headers: { "if-none-match": etag } });
		expect(second.status).to.equal(304);

		const third = await fetch(`${server.url}/app.js`, { headers: { "if-modified-since": modified } });
		expect(third.status).to.equal(304);
	});

	it("never leaves the web root and answers API errors with problems", async () => {
		// `fetch` normalises `..` away, so a raw client is used to send the literal path
		const raw = (path: string): Promise<{ status: number; body: string }> =>
			new Promise((resolve, reject) => {
				const request = http.request(
					{ host: "127.0.0.1", port: server.port, path, method: "GET" },
					response => {
						let body = "";
						response.on("data", chunk => (body += chunk));
						response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
					},
				);
				request.on("error", reject);
				request.end();
			});

		const literal = await raw("/../zeiterfassung-secret.txt");
		expect(literal.body).to.not.contain("streng geheim");

		const encoded = await raw("/%2e%2e%2fzeiterfassung-secret.txt");
		expect(encoded.status).to.equal(404);
		expect(encoded.body).to.not.contain("streng geheim");

		// an API client gets a problem document, not the HTML page
		const missing = await fetch(`${server.url}/api/gibt/es/nicht`, { headers: { accept: "application/json" } });
		expect(missing.status).to.equal(404);
		expect(missing.headers.get("content-type")).to.equal("application/problem+json; charset=utf-8");
		expect(await missing.json()).to.deep.include({ status: 404, code: "not_found" });

		const huge = await fetch(`${server.url}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login: "x".repeat(2000), password }),
		});
		expect(huge.status).to.equal(413);
		expect(huge.headers.get("content-type")).to.equal("application/problem+json; charset=utf-8");
		expect(await huge.json()).to.deep.include({ status: 413, code: "payload_too_large" });
	});

	it("stops listening when the server is closed", async () => {
		expect((await fetch(`${server.url}/api/health`)).status).to.equal(200);
		await server.close();

		let failed = false;
		try {
			await fetch(`${server.url}/api/health`);
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true);

		// a second close call must not throw either
		await server.close();
	});
});
