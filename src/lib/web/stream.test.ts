/// <reference types="mocha" />
import { expect } from "chai";
import { WebSocket, type RawData } from "ws";
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
import { SESSION_COOKIE } from "./cookies";
import { startWebServer, type WebServer } from "./server";
const password = "Zeit-2026-klar";

/** A frame of the stream. */
type Frame = Record<string, unknown>;

/** A connected test client with a frame buffer. */
interface TestClient {
	/** Underlying connection */
	socket: WebSocket;
	/** Greeting frame */
	hello: Frame;
	/** Waits for the next frame */
	next(timeoutMs?: number): Promise<Frame>;
	/** Asserts that no frame arrives within the given time */
	silence(ms?: number): Promise<void>;
}

/**
 * Waits for a moment.
 *
 * @param ms - milliseconds
 */
async function sleep(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads the text of a received frame.
 *
 * @param raw - received frame
 * @returns the frame as UTF-8 text
 */
function textOf(raw: RawData): string {
	const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
	return buffer.toString("utf8");
}

describe("web event stream", () => {
	let db: Db;
	let api: Api;
	let server: WebServer;
	let annaId: number;
	let annaToken: string;
	let annaCsrf: string;
	let adminToken: string;
	let adminCsrf: string;
	/** Intervals the stream asked the caller for, and the timers it stopped again. */
	let startedIntervals: number[];
	let stoppedTimers: unknown[];
	/** Callback the stream handed to the injected `setInterval`, so a test can fire the keep-alive ping. */
	let pingHandler: (() => void) | null;

	/**
	 * Connects a client, buffers its frames and consumes the greeting.
	 *
	 * Frames are buffered from the moment the connection is opened, so a test can trigger a request first and
	 * look at the frames afterwards. A plain "once" listener would miss frames that arrive during the request.
	 *
	 * @param token - session token
	 * @param path - path of the endpoint
	 * @param cookie - optional session cookie a browser would send with the handshake
	 * @returns the client
	 */
	async function connect(token: string, path = "/api/stream", cookie?: string): Promise<TestClient> {
		const url = `ws://127.0.0.1:${server.port}${path}?token=${encodeURIComponent(token)}`;
		const socket = cookie ? new WebSocket(url, { headers: { cookie } }) : new WebSocket(url);
		const frames: Frame[] = [];
		const waiters: { resolve: (frame: Frame) => void; timer: NodeJS.Timeout }[] = [];

		socket.on("message", raw => {
			const frame = JSON.parse(textOf(raw)) as Frame;
			const waiter = waiters.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
			} else {
				frames.push(frame);
			}
		});

		/**
		 * Waits for the next frame.
		 *
		 * @param timeoutMs - how long to wait
		 * @returns the frame
		 */
		const next = (timeoutMs = 2000): Promise<Frame> => {
			const buffered = frames.shift();
			if (buffered !== undefined) {
				return Promise.resolve(buffered);
			}
			return new Promise<Frame>((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex(waiter => waiter.timer === timer);
					if (index >= 0) {
						waiters.splice(index, 1);
					}
					reject(new Error("no frame arrived in time"));
				}, timeoutMs);
				waiters.push({ resolve, timer });
			});
		};

		const hello = await next();
		return {
			socket,
			hello,
			next,
			silence: async (ms = 250): Promise<void> => {
				await sleep(ms);
				const count = frames.length;
				frames.length = 0;
				expect(count, "frames that should not have arrived").to.equal(0);
			},
		};
	}
	/**
	 * Sends an authenticated request with an empty JSON body to the running server.
	 *
	 * @param path - request path below the API prefix
	 * @param token - session token
	 * @param csrfToken - CSRF token
	 * @param body
	 * @returns status code
	 */
	async function post(path: string, token: string, csrfToken: string, body: unknown = {}): Promise<number> {
		const response = await fetch(`${server.url}/api${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-session-token": token, "x-csrf-token": csrfToken },
			body: JSON.stringify(body),
		});
		return response.status;
	}

	/**
	 * Logs in over the real server.
	 *
	 * @param loginName - login of the employee
	 * @returns session token
	 */
	async function login(loginName: string): Promise<string> {
		const response = await fetch(`${server.url}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login: loginName, password }),
		});
		expect(response.status).to.equal(200);
		const payload = (await response.json()) as { token: string; csrfToken: string };
		if (loginName === "anna") {
			annaCsrf = payload.csrfToken;
		} else {
			adminCsrf = payload.csrfToken;
		}
		return payload.token;
	}

	beforeEach(async () => {
		startedIntervals = [];
		stoppedTimers = [];
		pingHandler = null;
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
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
		const auth = createAuthService({ db, users, settings, secret: "stream-test-secret" });
		const aggregation = createAggregationService({ db, users, entries, absences, holidays, rules, settings });
		const sync = createSyncService({ db, entries, users, aggregation });
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
			now: () => 1000,
			version: "9.9.9",
		});

		const hash = hashPassword(password, { cost: 1024 });
		users.create({ login: "admin", displayName: "Admin", passwordHash: hash, roleKeys: ["admin"] });
		annaId = users.create({ login: "anna", displayName: "Anna", passwordHash: hash, roleKeys: ["employee"] }).id;

		server = await startWebServer({
			router: api.router,
			port: 0,
			stream: {
				auth,
				events: api.events,
				version: "9.9.9",
				now: () => 1000,
				// the adapter hands in its own timer functions; here stubs record what the stream does with them
				timers: {
					setInterval: (handler, milliseconds) => {
						pingHandler = handler;
						startedIntervals.push(milliseconds);
						return 42;
					},
					clearInterval: handle => stoppedTimers.push(handle),
				},
			},
		});

		annaToken = await login("anna");
		adminToken = await login("admin");
	});

	afterEach(async () => {
		await server.close();
		db.close();
	});
	it("greets the client and forwards the punches of its own account", async () => {
		const anna = await connect(annaToken);
		expect(anna.hello).to.deep.include({ type: "hello", userId: annaId, version: "9.9.9", subscribe: "own" });

		expect(await post("/punch", annaToken, annaCsrf)).to.equal(201);

		const frame = await anna.next();
		expect(frame).to.deep.include({ type: "punch", userId: annaId });
		expect((frame.data as { localDate: string }).localDate).to.equal("1970-01-01");
		anna.socket.close();
	});

	it("hides the events of other employees from an employee", async () => {
		const anna = await connect(annaToken);
		const admin = await connect(adminToken);
		expect(admin.hello).to.deep.include({ type: "hello", subscribe: "all" });

		// the administration writes a punch for its own account: anna must not see it, the administration must.
		// The administrator role does not punch, so the punch is written as a correction (`POST /entries`).
		expect(await post("/entries", adminToken, adminCsrf, { tsUtc: 1_000_000 })).to.equal(201);

		const frame = await admin.next();
		expect(frame.userId).to.not.equal(annaId);
		await anna.silence();
		anna.socket.close();
		admin.socket.close();
	});

	it("refuses an upgrade on another path", async () => {
		// the API owns `/api/stream`; every other upgrade belongs to nobody and is answered with 404
		const socket = new WebSocket(
			`ws://127.0.0.1:${server.port}/falscher-pfad?token=${encodeURIComponent(annaToken)}`,
		);
		const status = await new Promise<number>((resolve, reject) => {
			socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
			socket.on("open", () => reject(new Error("the connection was accepted")));
			socket.on("error", () => reject(new Error("the connection failed before the response")));
		});
		expect(status).to.equal(404);
	});

	it("pings the connected clients with the timer of the adapter", async () => {
		const anna = await connect(annaToken);
		expect(startedIntervals).to.have.lengthOf(1);
		expect(pingHandler).to.be.a("function");

		const ping = new Promise<void>(resolve => anna.socket.on("ping", () => resolve()));
		pingHandler?.();
		await ping;

		// a closed client is gone from the list, so the following ping has nobody to talk to
		anna.socket.close();
		await sleep(50);
		pingHandler?.();
	});

	it("rejects a connection with an unknown token", async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/stream?token=quatsch`);
		const status = await new Promise<number>((resolve, reject) => {
			socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
			socket.on("open", () => reject(new Error("the connection was accepted")));
			socket.on("error", () => reject(new Error("the connection failed before the response")));
		});
		expect(status).to.equal(401);
		expect(server.stream?.clientCount()).to.equal(0);
	});

	it("answers a client ping and closes the connections on shutdown", async () => {
		const anna = await connect(annaToken);
		anna.socket.send("ping");
		expect(await anna.next()).to.deep.include({ type: "pong", atUtc: 1000 });

		const closed = new Promise<number>(resolve => anna.socket.once("close", code => resolve(code)));
		await server.stream?.close();
		expect(await closed).to.equal(1001);
	});

	it("takes the keep-alive timer from the caller and stops it on close", async () => {
		// no plain timer of its own: the adapter's timer functions are used, so nothing survives the adapter
		expect(startedIntervals).to.deep.equal([30_000]);

		await server.stream?.close();
		expect(stoppedTimers).to.deep.equal([42]);
	});

	it("accepts the session cookie of a browser instead of the query token", async () => {
		// a browser cannot set headers on a handshake, but it does send its cookies — so the live stream works
		// without a token in the URL (specification 4.10)
		const anna = await connect("", "/api/stream", `${SESSION_COOKIE}=${annaToken}`);
		expect(anna.hello.type).to.equal("hello");
		expect(anna.hello.atUtc).to.equal(1000);
		anna.socket.close();
	});
});
