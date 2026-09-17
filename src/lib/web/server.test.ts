/// <reference types="mocha" />
import { expect } from "chai";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createPayoutsRepository } from "../db/repositories/payouts";
import { createTerminalsRepository } from "../db/repositories/terminals";
import { createRfidRepository } from "../db/repositories/rfid";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository } from "../db/repositories/users";
import { createAggregationService } from "../services/aggregation";
import { createAuthService, hashPassword } from "../services/auth";
import { createSyncService } from "../services/sync";
import { createApi, type Api } from "./api";
import { json } from "./router";
import { normalizeBindAddress, startWebServer, type WebServer } from "./server";
import { createStaticHandler } from "./static";

const password = "Zeit-2026-klar";

describe("bind address of the instance settings", () => {
	it("falls back to the local machine when nothing is configured", () => {
		expect(normalizeBindAddress(undefined)).to.equal("127.0.0.1");
		expect(normalizeBindAddress("")).to.equal("127.0.0.1");
		expect(normalizeBindAddress("   ")).to.equal("127.0.0.1");
	});

	it("keeps plain addresses as they are", () => {
		expect(normalizeBindAddress("192.168.1.5")).to.equal("192.168.1.5");
		expect(normalizeBindAddress("0.0.0.0")).to.equal("0.0.0.0");
		// an IPv6 address is full of colons: only a bracketed port is removed
		expect(normalizeBindAddress("::")).to.equal("::");
		expect(normalizeBindAddress("fe80::1")).to.equal("fe80::1");
	});

	it("drops a port, because the port comes from the instance", () => {
		expect(normalizeBindAddress("192.168.1.5:8082")).to.equal("192.168.1.5");
		expect(normalizeBindAddress("[::1]:8082")).to.equal("::1");
	});

	it("understands a wildcard", () => {
		expect(normalizeBindAddress("*")).to.equal("0.0.0.0");
	});
});

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
		const holidays = createHolidaysRepository(db);
		const rules = createRulesRepository(db);
		const payouts = createPayoutsRepository(db);
		const terminals = createTerminalsRepository(db);
		const rfid = createRfidRepository(db);
		const settings = createSettingsRepository(db);
		const auth = createAuthService({ db, users, settings, secret: "server-test-secret" });
		const aggregation = createAggregationService({
			db,
			users,
			entries,
			absences,
			holidays,
			rules,
			settings,
		});
		const sync = createSyncService({ db, entries, users, aggregation });
		const api = createApi({
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
			now: () => 1000,
		});

		// a route that exists only in this test: it reports what the transport handed over
		api.router.add({
			method: "POST",
			path: "/probe/raw",
			requiresAuth: false,
			requiresCsrf: false,
			handler: context => {
				const body = context.rawBody();
				return json(200, { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
			},
		});

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

		// without a session the report is refused; a browser that holds the cookie but no CSRF token writes nothing
		expect((await fetch(`${server.url}/api/aggregates/day?date=1970-01-01`)).status).to.equal(401);
		const withoutCsrf = await fetch(`${server.url}/api/punch`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: `zt_session=${session.token}` },
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

	it("hands a binary upload over as bytes, not as text", async () => {
		// a sequence that is not valid UTF-8: a text decode would replace or drop bytes
		const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42, 0xc3, 0x28]);
		const response = await fetch(`${server.url}/api/probe/raw`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: bytes,
		});

		expect(response.status).to.equal(200);
		const payload = (await response.json()) as { bytes: number; sha256: string };
		expect(payload.bytes).to.equal(bytes.length);
		expect(payload.sha256).to.equal(createHash("sha256").update(bytes).digest("hex"));

		// a JSON body stays text and arrives as its UTF-8 bytes
		const text = await fetch(`${server.url}/api/probe/raw`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "AB",
		});
		expect(((await text.json()) as { bytes: number }).bytes).to.equal(2);
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

describe("web server without a web interface", () => {
	let db: Db;

	/**
	 * Builds an API on the in-memory database of the test.
	 *
	 * @returns the API
	 */
	function createTestApi(): Api {
		const users = createUsersRepository(db);
		const entries = createEntriesRepository(db);
		const absences = createAbsencesRepository(db);
		const holidays = createHolidaysRepository(db);
		const rules = createRulesRepository(db);
		const payouts = createPayoutsRepository(db);
		const terminals = createTerminalsRepository(db);
		const rfid = createRfidRepository(db);
		const settings = createSettingsRepository(db);
		const auth = createAuthService({ db, users, settings, secret: "server-bare-test-secret" });
		const aggregation = createAggregationService({ db, users, entries, absences, holidays, rules, settings });
		const sync = createSyncService({ db, entries, users, aggregation });
		return createApi({
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
			now: () => 1000,
		});
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
	});

	afterEach(() => {
		db.close();
	});

	it("answers a request outside the API with a problem when no web interface is served", async () => {
		// an instance without `www/` still serves the API, and everything else becomes a problem document
		const bare = await startWebServer({ router: createTestApi().router, port: 0, bind: "127.0.0.1" });
		try {
			// a repeated query parameter arrives as a list
			expect((await fetch(`${bare.url}/api/health?a=1&a=2`)).status).to.equal(200);

			const missing = await fetch(`${bare.url}/irgendwas`);
			expect(missing.status).to.equal(404);
			expect(missing.headers.get("content-type")).to.equal("application/problem+json; charset=utf-8");
			expect(await missing.json()).to.deep.include({ status: 404, code: "not_found" });
		} finally {
			await bare.close();
		}
	});

	it("reports a broken transport as 500, logs it and names the loopback address", async () => {
		const logs: string[] = [];
		const broken = await startWebServer({
			router: createTestApi().router,
			port: 0,
			bind: "0.0.0.0",
			// a web interface whose files cannot be read: the transport fails before a response is written
			staticFiles: () => {
				throw new Error("kaputt");
			},
			log: { info: message => logs.push(message), warn: () => {}, error: message => logs.push(message) },
		});
		try {
			// a wildcard bind is reached through the loopback address, and that is the address a client is told
			expect(broken.url).to.equal(`http://127.0.0.1:${broken.port}`);
			expect(logs[0]).to.contain("web interface is served from disk");
			expect(logs[0]).to.not.contain("live events");

			expect((await fetch(`${broken.url}/`)).status).to.equal(500);
			expect(logs.some(message => message.includes("request failed: kaputt"))).to.equal(true);
		} finally {
			await broken.close();
		}
	});
});
