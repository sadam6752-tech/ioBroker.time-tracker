/// <reference types="mocha" />
import { expect } from "chai";
import * as https from "node:https";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository } from "../db/repositories/absences";
import { createDayNotesRepository } from "../db/repositories/dayNotes";
import { createEntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createPayoutsRepository } from "../db/repositories/payouts";
import { createTerminalsRepository } from "../db/repositories/terminals";
import { createRfidRepository } from "../db/repositories/rfid";
import { createTriggersRepository } from "../db/repositories/triggers";
import { createAutomationsRepository } from "../db/repositories/automations";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository } from "../db/repositories/users";
import { createAggregationService } from "../services/aggregation";
import { createAuthService, hashPassword } from "../services/auth";
import { createSyncService } from "../services/sync";
import { createApi, type Api } from "./api";
import { startWebServer, type TlsOptions } from "./server";

/** Self-signed certificate for `localhost` / `127.0.0.1`, valid for 100 years; it only exists for this test. */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDY6cSh9Fqa4TbI
tpEQlVmQNfnzdnwXksOXasbnGSXh3sDjdGCS6VfwnNrOmgiKPltjWTT79qycLIxw
ylwVeBFhWV0mGELNa1gXm0KCyVWQwHNyai01aW2MW7tZUtL/AL5tnzxnJFIt4qCx
tFAoPZuE3++/nIgQLryLqL8kaVtYsMabVGNJcUXsWzkUA5d1jhRKH/FOkmdllQU/
mOodiyZLbsUMDLDUPh6wMr4zbPIWkPNh48CduqGvI6jepjSse40Yd43xK0ta1Ved
Mu6WMoZrnAy7A8qXiBFuoj5DLr8U3ikQj0H69htxJ4hNqvrzYA3/iDWcEx6SFa46
RCQ6LIX3AgMBAAECggEAIa4qmfsXFnVhzEiMvcZy4bF/3g3HtuFS/W/W8os1Fp0/
1hF77VPOE85HK00/hjeoeQSg9X6XzqgcJmdFZQ//ot39WKzrsnm4c/HnoechIhi/
1EQoQOLd361eqb/ygyXaa6sN9fXtzLIjwXP9/kGSpE8hKt9jQSAApq7M/xpc1KhU
7sas8D+eE9WDNERfwsaAix/emudp3Ftah7aq9bTUzaPcQi4f/voig3t8n2r1aYE2
pMf0TzYOhQqlD5A1yYVzqtr9DL1xKQom/kb55QutX2kQJdIPGY2jSPCBV4M1832F
qWU6o1kBDtERxyas9jwYn8Ouz4UNlDwaMlNoa5zEAQKBgQD2EJYwL7CaYerU6UC4
tL2QPXYCcWHyYOGFWOj/g5CLKWlUr2gqIwTe3Lo0cgC4W2TA2H7yFlnNvEJj/bN9
aPifvixnNrzbd+DSTLhKO6vupCS8viJxTzikRelsZce4SMEQ0djKjwc49UXUVTo2
fzdK0jFlg2TcO5IY6kWNV6TkfwKBgQDhq9wX9TXYIhjeSSlpCeoxfimwM/s0hWAB
bxwgOi95Qmg1cU/xbo29eI13XjaRxRGgrNm1y4uNOrMgzEmGUIL/dUvB56bXkpHn
UO7DcolZg0dsmDIhcXLtZWgO2HUtrDo/hHn811Auw+DiDY+oWvmyYCYk8lgxmeSh
BmT15zrCiQKBgQDNJ50gxdI3lWYGaAdnOIJILYYjmUbxn6bH2A5DYvzzme5RBgIS
B6p66YtySI6jJsgFJTwKOWpcZxbvaUnqSMfp39QDphal4PgYPpD0i3XY/RAIMXpk
AIoYJJXuo5l142rczCk1ETUTXyP+WaS0ZTLDdiZrHbbNC/nOPh0JMEaxnwKBgEeU
7/dZfH7WMfUwV8ZNss+IKUkO8/uw4scRq2Y9jpl0CwIIs0btvl//QUA/zidmzzSc
H2Ke8eEWYYNhyWClYSgO2Lzk8fMnNsicz1+HkTGnhpxXmm8pQT80D1HGL0URgFht
eRROZ8ytrUOG8a6BTPrbrL3DcV4qZm79TEED24uhAoGBAJr2hkSEpsHlr6PdzSqY
L9Bmdw624/u7waa0gmbWGZHf8wTP0mZPsW0hc9CkSExOKla537wLVIcBd0cEVa0Z
qgT7ft/LxunMwmprHodaq8q3DaA3BTaTP8Ac5zxoyvQtyvsaMSl0xUgUFzG9v4VG
z4QY3V2yelTtghccuuCG9A/W
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUROAtxechA/7608/kDG8cgplR0tAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwMTIwMzcwMFoYDzIxMjYw
OTA3MjAzNzAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDY6cSh9Fqa4TbItpEQlVmQNfnzdnwXksOXasbnGSXh
3sDjdGCS6VfwnNrOmgiKPltjWTT79qycLIxwylwVeBFhWV0mGELNa1gXm0KCyVWQ
wHNyai01aW2MW7tZUtL/AL5tnzxnJFIt4qCxtFAoPZuE3++/nIgQLryLqL8kaVtY
sMabVGNJcUXsWzkUA5d1jhRKH/FOkmdllQU/mOodiyZLbsUMDLDUPh6wMr4zbPIW
kPNh48CduqGvI6jepjSse40Yd43xK0ta1VedMu6WMoZrnAy7A8qXiBFuoj5DLr8U
3ikQj0H69htxJ4hNqvrzYA3/iDWcEx6SFa46RCQ6LIX3AgMBAAGjbzBtMB0GA1Ud
DgQWBBTkGa24spAJKLj5wmcjhLMskQdmlDAfBgNVHSMEGDAWgBTkGa24spAJKLj5
wmcjhLMskQdmlDAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAHccm9F/fSNMvZPXDDwprPOCIXKQc
8u9rVJjLGRbjWCrg6KL7sZ8gwZOM9+3eTMNfeRUQ+T8tUxQU5PHDxEWwvcGOiri+
2Ta5mama3kSbandJGlXnSDYHeJAm8peGMPuUmgqRpAZ5Nn04sORI3pwzcl24Xn+u
fZ0pu9KfY4GSEYjpl9JP0mZQukN6S0j2Iu+MwzhHvLcbu4c2v0UFKqwgr0qXK+vg
2TnwubGMMLGlaFSXQSQloCXkZNy/89Lv0c9O2JYWccyB2x53ozJSpQ+o5qcCx0gm
g1XfQZoCUByDX4iV/5OHF8E5pwDyqmYtyaUuWEOSiV+5XYIN3QuolLMzGw==
-----END CERTIFICATE-----
`;
const TLS: TlsOptions = { key: TEST_KEY, cert: TEST_CERT };
const password = "Zeit-2026-klar";

/** Answer of one HTTPS request. */
interface Answer {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

/**
 * Sends a request to the test server and trusts only the test certificate.
 *
 * @param url - address of the request
 * @param options - method, headers and body
 * @param options.method - HTTP method
 * @param options.headers - request headers
 * @param options.body - request body
 * @returns status, headers and body
 */
function request(
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = https.request(
			url,
			{ method: options.method ?? "GET", headers: options.headers, ca: TEST_CERT },
			res => {
				const chunks: Buffer[] = [];
				res.on("data", chunk => chunks.push(chunk as Buffer));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

describe("web server over HTTPS", () => {
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
		const dayNotes = createDayNotesRepository(db);
		const holidays = createHolidaysRepository(db);
		const rules = createRulesRepository(db);
		const payouts = createPayoutsRepository(db);
		const terminals = createTerminalsRepository(db);
		const rfid = createRfidRepository(db);
		const triggers = createTriggersRepository(db);
		const automations = createAutomationsRepository(db);
		const settings = createSettingsRepository(db);
		const auth = createAuthService({ db, users, settings, secret: "server-tls-test-secret" });
		const aggregation = createAggregationService({ db, users, entries, absences, holidays, rules, settings });
		const sync = createSyncService({ db, entries, users, aggregation });
		users.create({
			login: "anna",
			displayName: "Anna",
			passwordHash: hashPassword(password, { cost: 1024 }),
			roleKeys: ["employee"],
		});
		return createApi({
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
			secureTransport: true,
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

	it("answers over HTTPS and names an https address", async () => {
		const logs: string[] = [];
		const server = await startWebServer({
			router: createTestApi().router,
			port: 0,
			bind: "127.0.0.1",
			tls: TLS,
			log: { info: message => logs.push(message), warn: () => {}, error: () => {} },
		});
		try {
			expect(server.url).to.equal(`https://127.0.0.1:${server.port}`);
			expect(logs[0]).to.contain(`https://127.0.0.1:${server.port}/api`);
			const health = await request(`${server.url}/api/health`);
			expect(health.status).to.equal(200);
			expect(JSON.parse(health.body)).to.deep.include({ status: "ok" });
		} finally {
			await server.close();
		}
	});

	it("marks the session cookie as Secure without a proxy header", async () => {
		const server = await startWebServer({ router: createTestApi().router, port: 0, bind: "127.0.0.1", tls: TLS });
		try {
			const login = await request(`${server.url}/api/auth/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login: "anna", password }),
			});
			expect(login.status).to.equal(200);
			const cookie = ([] as string[]).concat(login.headers["set-cookie"] ?? []).join("; ");
			expect(cookie).to.contain("Secure");
			expect(cookie).to.contain("HttpOnly");
		} finally {
			await server.close();
		}
	});

	it("refuses a client that does not trust the certificate", async () => {
		const server = await startWebServer({ router: createTestApi().router, port: 0, bind: "127.0.0.1", tls: TLS });
		try {
			let failed = false;
			try {
				await new Promise<void>((resolve, reject) => {
					https.get(`${server.url}/api/health`, res => res.resume().on("end", resolve)).on("error", reject);
				});
			} catch {
				failed = true;
			}
			expect(failed).to.equal(true);
		} finally {
			await server.close();
		}
	});

	it("does not start with a broken certificate", async () => {
		let failed = false;
		try {
			const server = await startWebServer({
				router: createTestApi().router,
				port: 0,
				bind: "127.0.0.1",
				tls: { key: "kein Schluessel", cert: "kein Zertifikat" },
			});
			await server.close();
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true);
	});
});
