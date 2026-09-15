/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const { expect } = require("chai");
const { tests } = require("@iobroker/testing");

// The CI runners - the Windows ones in particular - are slow and heavily loaded, so a fixed delay is
// never long enough there. The tests below poll for the expected result instead. These two values
// only decide how patient a single hook or test is: `testTimeout` is mocha's limit for it,
// `reactionTimeout` is how long it waits for the adapter to react before giving up with a diagnosis.
const testTimeout = 60000;
const reactionTimeout = 20000;

/**
 * Waits a moment before the next try
 *
 * @param {number} ms time to wait
 * @returns {Promise<void>} resolves after the wait
 */
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
	defineAdditionalTests({ suite }) {
		suite("adapter wiring: states, commands and API", getHarness => {
			let harness;

			/**
			 * Waits until the adapter has logged a message matching the pattern
			 *
			 * @param {RegExp} pattern the message the adapter must have logged
			 * @returns {Promise<void>} resolves as soon as the message was logged
			 */
			async function waitForLog(pattern) {
				const started = Date.now();
				while (Date.now() - started < reactionTimeout) {
					if (harness.hasLog(pattern)) {
						return;
					}
					await sleep(100);
				}
				// show what the adapter said, so a failure stays diagnosable
				throw new Error(
					`the adapter did not log ${pattern} within ${reactionTimeout} ms. Adapter logs:\n${harness
						.getLogs()
						.map(log => log.message)
						.join("\n")}`,
				);
			}

			/**
			 * Waits until a state exists and passes the check
			 *
			 * @param {string} id id of the state
			 * @param {(val: unknown) => boolean} check the check the value must pass
			 * @returns {Promise<object>} the state that passed the check
			 */
			async function waitForState(id, check) {
				const started = Date.now();
				while (Date.now() - started < reactionTimeout) {
					const state = await harness.states.getState(id);
					if (state && check(state.val)) {
						return state;
					}
					await sleep(100);
				}
				throw new Error(`the state ${id} did not pass the check within ${reactionTimeout} ms`);
			}

			before(async function () {
				this.timeout(testTimeout);
				harness = getHarness();
				// wait for info.connection so database and API are ready
				await harness.startAdapterAndWait(true);
			});

			/**
			 * Reads the port the API listens on from the adapter log.
			 *
			 * @returns {number} port of the API
			 */
			function apiPort() {
				const line = harness
					.getLogs()
					.map(log => log.message)
					.find(message => /API listening on http:\/\/127\.0\.0\.1:\d+/.test(message));
				expect(line, "port of the API in the adapter log").to.be.a("string");
				return Number(/API listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(line))?.[1]);
			}

			it("publishes the command states and the connection indicator", async function () {
				this.timeout(testTimeout);
				const punch = await harness.objects.getObject("zeiterfassung.0.commands.punch");
				expect(punch?.common).to.include({ type: "boolean", role: "button", read: false, write: true });
				const closeMonth = await harness.objects.getObject("zeiterfassung.0.commands.closeMonth");
				expect(closeMonth?.common).to.include({ type: "string", write: true });
				const backup = await harness.objects.getObject("zeiterfassung.0.commands.backup");
				expect(backup?.common).to.include({ type: "boolean", role: "button", read: false, write: true });

				const connection = await harness.states.getState("zeiterfassung.0.info.connection");
				expect(connection?.val).to.equal(true);
			});

			it("writes a backup when the command state is triggered", async function () {
				this.timeout(testTimeout);
				await harness.states.setState("zeiterfassung.0.commands.backup", { val: true, ack: false });
				await waitForLog(/backup zeiterfassung-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite written/);

				// the instant of the newest backup is published for dashboards
				const lastBackup = await waitForState("zeiterfassung.0.info.lastBackup", val => Number(val) > 0);
				expect(lastBackup.val).to.be.a("number");
				expect(Number(lastBackup.val)).to.be.greaterThan(0);
			});

			it("starts the HTTP API on the configured port", async function () {
				this.timeout(testTimeout);
				expect(harness.hasLog(/API listening on http:\/\/127\.0\.0\.1:\d+/)).to.equal(true);
				expect(harness.hasLog(/API routes: \d+/)).to.equal(true);
			});

			it("answers the API below /api and delivers the web app", async function () {
				this.timeout(testTimeout);
				const port = apiPort();

				// the API is mounted below /api, so the web interface can own the rest of the paths
				const health = await fetch(`http://127.0.0.1:${port}/api/health`);
				expect(health.status).to.equal(200);
				expect(await health.json()).to.include({ status: "ok" });

				const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ login: "gibt-es-nicht", password: "Falsch-2026-gemischt" }),
				});
				expect(login.status).to.equal(401);
				expect(login.headers.get("content-type")).to.equal("application/problem+json; charset=utf-8");

				// the packed package contains www/, so the adapter serves the built web app
				expect(harness.hasLog(/web interface found at .*www/)).to.equal(true);
				const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
				expect(page.status).to.equal(200);
				expect(page.headers.get("content-type")).to.equal("text/html; charset=utf-8");
				expect(await page.text()).to.contain('<div id="root">');

				// a deep link of the client side router answers with the app shell as well
				const deepLink = await fetch(`http://127.0.0.1:${port}/month`, { headers: { accept: "text/html" } });
				expect(deepLink.status).to.equal(200);

				// an API client never receives the HTML page
				const missing = await fetch(`http://127.0.0.1:${port}/api/gibt/es/nicht`, {
					headers: { accept: "application/json" },
				});
				expect(missing.status).to.equal(404);
				expect(await missing.json()).to.include({ code: "not_found" });
			});

			it("serves the live event stream and refuses a connection without a session", async function () {
				this.timeout(testTimeout);
				expect(harness.hasLog(/live events on \/stream/)).to.equal(true);

				const { WebSocket } = require("ws");
				const socket = new WebSocket(`ws://127.0.0.1:${apiPort()}/api/stream?token=quatsch`);
				let timer;
				const status = await Promise.race([
					new Promise((resolve, reject) => {
						socket.on("unexpected-response", (_request, response) => resolve(response.statusCode));
						socket.on("open", () => reject(new Error("the stream accepted a connection without a session")));
						socket.on("error", error => reject(error));
					}),
					new Promise((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error(`the stream did not answer within ${reactionTimeout} ms`)),
							reactionTimeout,
						);
					}),
				]).finally(() => clearTimeout(timer));
				expect(status).to.equal(401);
			});

			it("reacts to a command state", async function () {
				this.timeout(testTimeout);
				await harness.states.setState("zeiterfassung.0.commands.punch", { val: true, ack: false });
				// the adapter creates the first administrator while starting, so the punch has an employee
				await waitForLog(/command commands\.punch: .*(punched|no employee exists yet)/);
				expect(harness.hasLog(/command commands\.punch: .*punched/)).to.equal(true);
			});
		});
	},
});
