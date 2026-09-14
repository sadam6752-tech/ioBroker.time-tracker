/*
 * ioBroker adapter "zeiterfassung" – time tracking
 * Scaffolded with @iobroker/create-adapter v3.1.5
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as utils from "@iobroker/adapter-core";
import { openAndMigrate, type Db } from "./lib/db/database";
import { seed } from "./lib/db/seed";
import type { HolidayCountry } from "./lib/domain/holidays";

const SUPPORTED_COUNTRIES: HolidayCountry[] = ["CH", "DE", "AT"];

class Zeiterfassung extends utils.Adapter {
	private db: Db | null = null;

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

	/** Database file: configured path or `<adapter instance data dir>/zeiterfassung.sqlite`. */
	private databaseFile(): string {
		const configured = (this.config.dbPath ?? "").trim();
		if (configured) {
			return path.resolve(configured);
		}

		const dir = utils.getAbsoluteInstanceDataDir(this);
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, "zeiterfassung.sqlite");
	}

	/** Configured holiday country, falling back to Switzerland. */
	private holidayCountry(): HolidayCountry {
		const configured = (this.config.holidayCountry ?? "").toUpperCase() as HolidayCountry;
		return SUPPORTED_COUNTRIES.includes(configured) ? configured : "CH";
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	private async onReady(): Promise<void> {
		try {
			// Reset the connection indicator during startup
			await this.setState("info.connection", false, true);

			const file = this.databaseFile();
			this.db = openAndMigrate(file, message => this.log.debug(message));

			const year = new Date().getUTCFullYear();
			const country = this.holidayCountry();
			const result = seed(this.db, { holidayCountry: country, holidayYears: [year, year + 1] });
			this.log.info(
				`database ready at ${file} (${result.permissions} permissions, ${result.holidays} holidays added for ${country})`,
			);

			// NOTE: The implementation follows the internal specification (not part of this repository):
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
			// TODO(Phase 4): close the HTTP server here.
			this.db?.close();
			this.db = null;

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
