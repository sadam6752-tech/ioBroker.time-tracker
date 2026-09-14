/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const { expect } = require("chai");
const { tests } = require("@iobroker/testing");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
	defineAdditionalTests({ suite }) {
		suite("adapter wiring: states, commands and API", getHarness => {
			let harness;

			before(async () => {
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

			it("publishes the command states and the connection indicator", async () => {
				const punch = await harness.objects.getObject("zeiterfassung.0.commands.punch");
				expect(punch?.common).to.include({ type: "boolean", role: "button", read: false, write: true });
				const closeMonth = await harness.objects.getObject("zeiterfassung.0.commands.closeMonth");
				expect(closeMonth?.common).to.include({ type: "string", write: true });

				const connection = await harness.states.getState("zeiterfassung.0.info.connection");
				expect(connection?.val).to.equal(true);
			});

			it("starts the HTTP API on the configured port", async () => {
				expect(harness.hasLog(/API listening on http:\/\/127\.0\.0\.1:\d+/)).to.equal(true);
				expect(harness.hasLog(/API routes: \d+/)).to.equal(true);
			});

			it("answers the API below /api and delivers the web app", async () => {
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

			it("serves the live event stream and refuses a connection without a session", async () => {
				expect(harness.hasLog(/live events on \/stream/)).to.equal(true);

				const { WebSocket } = require("ws");
				const socket = new WebSocket(`ws://127.0.0.1:${apiPort()}/api/stream?token=quatsch`);
				const status = await new Promise((resolve, reject) => {
					socket.on("unexpected-response", (_request, response) => resolve(response.statusCode));
					socket.on("open", () => reject(new Error("the stream accepted a connection without a session")));
					socket.on("error", error => reject(error));
				});
				expect(status).to.equal(401);
			});

			it("reacts to a command state", async () => {
				await harness.states.setState("zeiterfassung.0.commands.punch", { val: true, ack: false });
				await new Promise(resolve => setTimeout(resolve, 750));

				// show what the adapter said, so a failure is diagnosable
				const messages = harness.getLogs().map(log => log.message);
				if (!harness.hasLog(/no employee exists yet/)) {
					console.log(`adapter logs:\n${messages.join("\n")}`);
				}
				// without an employee the command is refused, which proves it was dispatched
				expect(harness.hasLog(/no employee exists yet/)).to.equal(true);
			});
		});
	},
});
