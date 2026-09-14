/*
 * ioBroker adapter "zeiterfassung" – time tracking
 * Scaffolded with @iobroker/create-adapter v3.1.5
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as utils from "@iobroker/adapter-core";
import { openAndMigrate, type Db } from "./lib/db/database";
import { seed } from "./lib/db/seed";
import type { HolidayCountry } from "./lib/domain/holidays";
import { createAbsencesRepository } from "./lib/db/repositories/absences";
import { createEntriesRepository } from "./lib/db/repositories/entries";
import { createHolidaysRepository } from "./lib/db/repositories/holidays";
import { createRulesRepository } from "./lib/db/repositories/rules";
import { createSettingsRepository } from "./lib/db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "./lib/db/repositories/users";
import { createPayoutsRepository } from "./lib/db/repositories/payouts";
import type { EntriesRepository } from "./lib/db/repositories/entries";
import type { AbsencesRepository } from "./lib/db/repositories/absences";
import type { SettingsRepository } from "./lib/db/repositories/settings";
import { createAggregationService, type AggregationService } from "./lib/services/aggregation";
import { createAuthService } from "./lib/services/auth";
import { createClosingService, type ClosingService } from "./lib/services/closing";
import { createSyncService, type SyncService } from "./lib/services/sync";
import { COMMAND_IDS, createCommandStates, publishAllUserStates } from "./lib/adapter/states";
import { handleCommand } from "./lib/adapter/commands";
import { createApi } from "./lib/web/api";
import { startWebServer, type WebServer } from "./lib/web/server";
import { createStaticHandler } from "./lib/web/static";

const SUPPORTED_COUNTRIES: HolidayCountry[] = ["CH", "DE", "AT"];

/** How often expired sessions are removed (minutes). */
const SESSION_PURGE_MINUTES = 30;

/** How often the published figures are refreshed (minutes). */
const STATE_REFRESH_MINUTES = 5;

/** Services created at startup. */
interface AdapterServices {
	users: UsersRepository;
	entries: EntriesRepository;
	absences: AbsencesRepository;
	settings: SettingsRepository;
	aggregation: AggregationService;
	sync: SyncService;
	closing: ClosingService;
}

class Zeiterfassung extends utils.Adapter {
	private db: Db | null = null;
	private webServer: WebServer | null = null;
	private services: AdapterServices | null = null;

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
			//   Phase 1–3 – storage, punch logic, target time, breaks, overtime, vacation
			//   Phase 4   – REST API on an own port (router, sessions, RBAC)
			//   Phase 5   – PWA delivered from www/
			//   Phase 8   – publish aggregates as states and react to command.*

			await this.startApi();
			await this.subscribeCommands();
			await this.refreshStates();

			// figures are refreshed regularly (the timer is cleared automatically on unload)
			this.setInterval(() => void this.refreshStates(), STATE_REFRESH_MINUTES * 60 * 1000);

			// Service is ready
			await this.setState("info.connection", true, true);
		} catch (error) {
			this.log.error(`Startup failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Secret used to sign CSRF tokens. A generated secret only lives for this run, so the administrator is
	 * asked to configure one.
	 */
	private sessionSecret(): string {
		const configured = (this.config.sessionSecret ?? "").trim();
		if (configured) {
			return configured;
		}

		this.log.warn(
			"no session secret configured - a temporary one is used, so all sessions end with the next restart",
		);
		return randomBytes(32).toString("base64url");
	}

	/**
	 * Builds the services and starts the HTTP server on the configured port.
	 *
	 * Binding can fail (port in use); that must never stop the adapter, so the failure is only logged.
	 */
	private async startApi(): Promise<void> {
		const db = this.db;
		if (!db) {
			return;
		}

		const users = createUsersRepository(db);
		const entries = createEntriesRepository(db);
		const absences = createAbsencesRepository(db);
		const holidays = createHolidaysRepository(db);
		const rules = createRulesRepository(db);
		const settings = createSettingsRepository(db);
		const auth = createAuthService({
			db,
			users,
			settings,
			secret: this.sessionSecret(),
			defaultTtlMinutes: this.config.sessionTtlMinutes || 720,
		});
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
		const closing = createClosingService({ db, aggregation, payouts: createPayoutsRepository(db) });
		const api = createApi({
			db,
			auth,
			users,
			entries,
			absences,
			holidays,
			rules,
			aggregation,
			sync,
			settings,
			version: this.version,
		});

		this.services = { users, entries, absences, settings, aggregation, sync, closing };
		this.log.debug(`API routes: ${api.routes().length}`);

		// the web interface is delivered from `www/` next to the compiled code (built by the PWA project);
		// without it the adapter still provides the API, e.g. for the terminal
		const webDir = path.join(__dirname, "..", "www");
		const staticFiles = fs.existsSync(path.join(webDir, "index.html"))
			? createStaticHandler({ root: webDir })
			: undefined;
		this.log.info(
			staticFiles
				? `web interface found at ${webDir}`
				: `no web interface at ${webDir} - only the API (and the terminal) is available`,
		);

		try {
			this.webServer = await startWebServer({
				router: api.router,
				port: this.config.port || 8082,
				bind: this.config.bind || "127.0.0.1",
				staticFiles,
				log: {
					info: message => this.log.info(message),
					warn: message => this.log.warn(message),
					error: message => this.log.error(message),
				},
			});
		} catch (error) {
			this.log.error(
				`API could not be started on port ${this.config.port}: ${(error as Error).message} - the web interface and the terminal stay unavailable`,
			);
			this.webServer = null;
			return;
		}

		// expired sessions are removed regularly; the timer is cleared automatically on unload
		this.setInterval(
			() => {
				try {
					const removed = auth.purge();
					if (removed > 0) {
						this.log.debug(`removed ${removed} expired session(s)`);
					}
				} catch (error) {
					this.log.warn(`session cleanup failed: ${(error as Error).message}`);
				}
			},
			SESSION_PURGE_MINUTES * 60 * 1000,
		);
	}

	/**
	 * Creates the command states and subscribes to them.
	 */
	private async subscribeCommands(): Promise<void> {
		try {
			await createCommandStates(this);
			await this.subscribeStatesAsync("commands.*");
			this.log.debug("command states ready");
		} catch (error) {
			this.log.warn(`command states could not be created: ${(error as Error).message}`);
		}
	}

	/**
	 * Publishes the figures of all employees.
	 */
	private async refreshStates(): Promise<void> {
		const services = this.services;
		if (!services) {
			return;
		}
		try {
			const snapshots = await publishAllUserStates({
				port: this,
				aggregation: services.aggregation,
				users: services.users,
				sync: services.sync,
			});
			this.log.debug(`published ${snapshots.length} employee state(s)`);
		} catch (error) {
			this.log.warn(`states could not be published: ${(error as Error).message}`);
		}
	}

	/**
	 * Runs a command state and reports the outcome.
	 *
	 * @param id - state id without the instance prefix
	 * @param value - value written by the user or a script
	 */
	private async runCommand(id: string, value: ioBroker.StateValue): Promise<void> {
		const services = this.services;
		const db = this.db;
		if (!services || !db) {
			return;
		}

		try {
			const result = handleCommand(
				{
					db,
					entries: services.entries,
					users: services.users,
					settings: services.settings,
					aggregation: services.aggregation,
					closing: services.closing,
				},
				id,
				value,
			);
			this.log.info(`command ${id}: ${result.message}`);
		} catch (error) {
			this.log.warn(`command ${id} failed: ${(error as Error).message}`);
		}

		// buttons are stateless: always release them again
		if (id === COMMAND_IDS.punch || id === COMMAND_IDS.quickPunch) {
			await this.setState(id, false, true);
		}
		await this.refreshStates();
	}

	/**
	 * Stops the HTTP server.
	 */
	private async stopApi(): Promise<void> {
		const server = this.webServer;
		this.webServer = null;
		if (server) {
			await server.close();
			this.log.debug("API stopped");
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
			void this.stopApi()
				.catch(error => this.log.warn(`stopping the API failed: ${(error as Error).message}`))
				.finally(() => {
					this.db?.close();
					this.db = null;
					callback();
				});
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

			const prefix = `${this.namespace}.`;
			const localId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
			if (localId.startsWith("commands.")) {
				void this.runCommand(localId, state.val);
				return;
			}

			this.log.debug(`Ignored state change: ${localId} = ${state.val}`);
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
