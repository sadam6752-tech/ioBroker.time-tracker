/*
 * ioBroker adapter "zeiterfassung" – time tracking
 * Scaffolded with @iobroker/create-adapter v3.1.5
 */

import * as utils from "@iobroker/adapter-core";

class Zeiterfassung extends utils.Adapter {
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "zeiterfassung",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	private async onReady(): Promise<void> {
		try {
			// Reset the connection indicator during startup
			await this.setState("info.connection", false, true);

			// The adapter config (instance settings, everything under "native") is available via this.config
			this.log.debug(
				`Starting on port ${this.config.port} (bind ${this.config.bind}, timezone ${this.config.timezone})`,
			);

			// NOTE: The implementation follows the internal specification (not part of this repository):
			//   Phase 2 – SQLite schema and migrations
			//   Phase 3 – punch logic, target time, breaks, overtime, vacation
			//   Phase 4 – HTTP/WebSocket API (Fastify), sessions, RBAC
			//   Phase 5 – PWA delivered from www/
			//   Phase 8 – publish aggregates as states and react to command.*

			// Service is ready
			await this.setState("info.connection", true, true);
		} catch (error) {
			this.log.error(`Startup failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param callback - Callback function
	 */
	private onUnload(callback: () => void): void {
		try {
			// Timers created with this.setTimeout/this.setInterval are cleared automatically on unload.
			// TODO(Phase 4): close the HTTP server and the database connection here.
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${(error as Error).message}`);
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param id - State ID
	 * @param state - State object
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		try {
			if (!state || state.ack) {
				// Ignore deletions and acknowledged (status) states
				return;
			}

			// TODO(Phase 8): handle command.* (punch, quickPunch, closeMonth, recalc)
			this.log.debug(`Command received: ${id} = ${state.val}`);
		} catch (error) {
			this.log.error(`Error in onStateChange for ${id}: ${(error as Error).message}`);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Zeiterfassung(options);
} else {
	// otherwise start the instance directly
	(() => new Zeiterfassung())();
}
