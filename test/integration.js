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
