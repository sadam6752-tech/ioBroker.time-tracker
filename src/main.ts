/*
 * ioBroker adapter "time-tracker" – time tracking
 * Scaffolded with @iobroker/create-adapter v3.1.5
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as utils from "@iobroker/adapter-core";
import { currentSchemaVersion, openAndMigrate, type Db } from "./lib/db/database";
import { seed } from "./lib/db/seed";
import type { HolidayCountry } from "./lib/domain/holidays";
import { createAbsencesRepository } from "./lib/db/repositories/absences";
import { createEntriesRepository } from "./lib/db/repositories/entries";
import { createHolidaysRepository } from "./lib/db/repositories/holidays";
import { createPayoutsRepository } from "./lib/db/repositories/payouts";
import { createRulesRepository } from "./lib/db/repositories/rules";
import { createSettingsRepository } from "./lib/db/repositories/settings";
import { createUsersRepository, type UserRecord, type UsersRepository } from "./lib/db/repositories/users";
import {
	createAutomationsRepository,
	type AutomationRuleRecord,
	type AutomationsRepository,
} from "./lib/db/repositories/automations";
import { createTerminalsRepository } from "./lib/db/repositories/terminals";
import { createRfidRepository } from "./lib/db/repositories/rfid";
import {
	createTriggersRepository,
	type TriggerRuleRecord,
	type TriggersRepository,
} from "./lib/db/repositories/triggers";
import type { EntriesRepository } from "./lib/db/repositories/entries";
import type { AbsencesRepository } from "./lib/db/repositories/absences";
import type { SettingsRepository } from "./lib/db/repositories/settings";
import { createAggregationService, type AggregationService } from "./lib/services/aggregation";
import { createAuthService, hashPassword } from "./lib/services/auth";
import { SECRET_FILE_NAME, resolveSessionSecret } from "./lib/services/sessionSecret";
import { createClosingService, type ClosingService } from "./lib/services/closing";
import {
	applyPendingRestore,
	createBackupService,
	recordRestore,
	type AppliedRestore,
	type BackupService,
} from "./lib/services/backup";
import { createSyncService, type SyncService } from "./lib/services/sync";
import {
	COMMAND_IDS,
	createCommandStates,
	createCompanyStates,
	createEventStates,
	createInfoStates,
	publishAllUserStates,
	publishCompanySnapshot,
	publishEventSnapshot,
	readCompanySnapshot,
} from "./lib/adapter/states";
import { PRESENCE_SUFFIX, handlePresenceState, parsePresenceStateId } from "./lib/adapter/presence";
import { handleCommand, punchEmployee } from "./lib/adapter/commands";
import { evaluateTrigger, triggerText } from "./lib/adapter/triggers";
import { evaluateAutomation, isoWeekday, runPeriod, workBlock } from "./lib/adapter/automation";
import { handleMessage } from "./lib/adapter/messages";
import { createApi, MAX_BACKUP_UPLOAD_BYTES } from "./lib/web/api";
import type { ApiEvent, EventBus } from "./lib/web/events";
import { startWebServer, type WebServer } from "./lib/web/server";
import { localDateTime } from "./lib/util/time";
import { createStaticHandler } from "./lib/web/static";

const SUPPORTED_COUNTRIES: HolidayCountry[] = ["CH", "DE", "AT"];

/** How often expired sessions are removed (minutes). */
const SESSION_PURGE_MINUTES = 30;

/** How often the published figures are refreshed (minutes). */
const STATE_REFRESH_MINUTES = 5;

/** How old the newest backup may be before the daily check writes a new one. */
const BACKUP_MAX_AGE_HOURS = 20;

/** How often the automation rules are checked (minutes). */
const AUTOMATION_CHECK_MINUTES = 1;

/** Name of the file that holds a generated badge (HMAC) secret next to the database. */
const TAG_SECRET_FILE_NAME = "tag-secret";

/**
 * Events of the API that change the published figures.
 *
 * A punch or a correction arrives through the API of this very process, so nothing would republish the states
 * until the five minute timer fires; these events say exactly when data changed.
 */
const FIGURES_EVENT_TYPES = ["punch", "terminal.punch", "rfid.scan", "entry.update", "entry.delete", "absence.change"];

/** Services created at startup. */
interface AdapterServices {
	users: UsersRepository;
	entries: EntriesRepository;
	absences: AbsencesRepository;
	settings: SettingsRepository;
	aggregation: AggregationService;
	sync: SyncService;
	closing: ClosingService;
	backup: BackupService;
	triggers: TriggersRepository;
	automations: AutomationsRepository;
}

class TimeTracker extends utils.Adapter {
	private db: Db | null = null;
	private webServer: WebServer | null = null;
	private services: AdapterServices | null = null;
	/** Bus of the API; `null` until the API is created */
	private events: EventBus | null = null;
	/** Last value seen per watched trigger state: only a change fires a rule */
	private readonly triggerValues = new Map<string, string>();
	/** Trigger states the adapter currently subscribes to */
	private readonly triggerStates = new Set<string>();
	/** Pending refresh of the figures after a change through the API */
	private stateRefreshTimer: ioBroker.Timeout | undefined = undefined;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "time-tracker",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// scripts, Blockly and other adapters reach the instance through `sendTo` messages
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/** Database file: configured path or `<adapter instance data dir>/time-tracker.sqlite`. */
	private databaseFile(): string {
		const configured = (this.config.dbPath ?? "").trim();
		if (configured) {
			return path.resolve(configured);
		}

		const dir = utils.getAbsoluteInstanceDataDir(this);
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, "time-tracker.sqlite");
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
			// A restore that the administration queued is applied before the database is opened: the swap needs a
			// closed file, and that is the only moment the adapter can offer it (see the backup service).
			let applied: AppliedRestore | null = null;
			try {
				applied = applyPendingRestore(file);
				if (applied) {
					this.log.info(
						`restored the database from ${applied.restored.name}: ${applied.restored.users} users, ${applied.restored.entries} punches, previous file ${applied.previous ?? "(none)"}`,
					);
				}
			} catch (error) {
				// the queued files stay in place, so a working backup can be handed in afterwards
				this.log.error(`the queued restore was refused: ${(error as Error).message}`);
			}
			this.db = openAndMigrate(file, message => this.log.debug(message));
			if (applied) {
				// the audit entry can only be written once the restored database is open
				recordRestore(this.db, applied.restored, applied.actorId);
			}

			const year = new Date().getUTCFullYear();
			const country = this.holidayCountry();
			const result = seed(this.db, { holidayCountry: country, holidayYears: [year, year + 1] });
			this.log.info(
				`database ready at ${file} (${result.permissions} permissions, ${result.holidays} holidays added for ${country})`,
			);

			// Without an account nobody can log in, so the first administrator is created here (Phase 2 of the
			// specification: "Standard-Admin, Passwort mit Pflichtwechsel").
			this.ensureAdministrator(this.db);

			// the settings of the admin UI win over the stored values (before the services are built)
			this.applyConfiguration(createSettingsRepository(this.db));

			// NOTE: The implementation follows the internal specification (not part of this repository):
			//   Phase 1–3 – storage, punch logic, target time, breaks, overtime, vacation
			//   Phase 4   – REST API on an own port (router, sessions, RBAC)
			//   Phase 5   – PWA delivered from www/
			//   Phase 8   – publish aggregates as states and react to command.*

			await this.startApi();
			// creates the command and info states, so the instance information can be published afterwards
			await this.subscribeCommands();
			// watches the states the trigger rules name (fingerprint reader, button, door contact, …)
			await this.refreshTriggerSubscriptions();
			// the automation rules look at the clock, so they are checked once a minute
			this.runAutomationRules();
			this.setInterval(() => this.runAutomationRules(), AUTOMATION_CHECK_MINUTES * 60 * 1000);
			await this.publishInstanceInfo();
			await this.refreshStates();

			// figures are refreshed regularly (the timer is cleared automatically on unload)
			this.setInterval(
				() => {
					void this.publishInstanceInfo();
					void this.refreshStates();
				},
				STATE_REFRESH_MINUTES * 60 * 1000,
			);

			// one backup per day: the check runs every hour, so a missed run is caught up after a restart
			await this.runScheduledBackup();
			this.setInterval(() => void this.runScheduledBackup(), 60 * 60 * 1000);

			// Service is ready
			await this.setState("info.connection", true, true);
		} catch (error) {
			const message = (error as Error).message;
			this.log.error(`Startup failed: ${message}`);
			await this.setState("info.lastError", message, true);
		}
	}

	/**
	 * Creates the first administrator when the instance has none.
	 *
	 * The account is created with `must_change_pw = 1`, so the start password opens the door exactly once.
	 * Login and password can be configured; without a configured password a random one is generated and written
	 * to the log, because there is no other way to hand it to the operator.
	 *
	 * @param db - open database handle
	 */
	private ensureAdministrator(db: Db): void {
		const users = createUsersRepository(db);
		const administrators = users.list().filter(user => users.roles(user.id).includes("admin"));
		if (administrators.length > 0) {
			return;
		}

		const login = (this.config.adminLogin ?? "").trim() || "admin";
		const configured = (this.config.adminPassword ?? "").trim();
		const password = configured || `Zf-${randomBytes(9).toString("base64url")}-7`;

		try {
			users.create({
				login,
				displayName: login,
				passwordHash: hashPassword(password),
				mustChangePw: true,
				timezone: this.config.timezone || "Europe/Berlin",
				roleKeys: ["admin"],
				now: Math.floor(Date.now() / 1000),
			});
		} catch (error) {
			this.log.warn(`the administrator "${login}" could not be created: ${(error as Error).message}`);
			return;
		}

		if (configured) {
			this.log.info(
				`administrator "${login}" created with the configured start password - it has to be changed at the first login`,
			);
		} else {
			this.log.warn(
				`administrator "${login}" created with the start password "${password}" - change it at the first login`,
			);
		}
	}

	/**
	 * Copies the instance configuration into the stored settings and publishes the instance information.
	 *
	 * The ioBroker admin UI is where an operator configures the instance, so a configured value wins over what
	 * is stored in the database; `PUT /api/settings` stays for the keys the admin UI does not offer. Empty
	 * fields are ignored, so clearing a field never wipes a stored setting.
	 *
	 * @param settings - instance settings
	 */
	private applyConfiguration(settings: SettingsRepository): void {
		const text = (value: string | undefined): string | null => (value?.trim() ? value.trim() : null);
		const number = (value: number | undefined): string | null =>
			typeof value === "number" && Number.isFinite(value) ? String(value) : null;
		const flag = (value: boolean | undefined): string | null => (value === undefined ? null : value ? "1" : "0");

		const mapped: [string, string | null][] = [
			["holiday_country", text(this.config.holidayCountry)?.toUpperCase() ?? null],
			["timezone", text(this.config.timezone)],
			["default_language", text(this.config.defaultLanguage)],
			["edit_window_days", number(this.config.editWindowDays)],
			["quick_round_minutes", number(this.config.quickRoundMinutes)],
			["session_ttl_minutes", number(this.config.sessionTtlMinutes)],
			["backup_retention_days", number(this.config.backupRetentionDays)],
			["absence_calc_until_today", flag(this.config.absenceCalcUntilToday)],
			["absence_deduct_worktime", flag(this.config.absenceDeductWorktime)],
		];

		const now = Math.floor(Date.now() / 1000);
		for (const [key, value] of mapped) {
			if (value !== null && settings.get(key) !== value) {
				settings.set(key, value, null, now);
			}
		}
	}

	/**
	 * Publishes version, database size and schema version as states (specification 5.1).
	 *
	 * The objects are created by `createInfoStates`, so this runs after the command states were set up.
	 */
	private async publishInstanceInfo(): Promise<void> {
		await this.setState("info.version", this.version ?? "0.0.0", true);
		const file = this.db ? this.databaseFile() : "";
		await this.setState("info.dbSizeBytes", file && fs.existsSync(file) ? fs.statSync(file).size : 0, true);
		if (this.db) {
			await this.setState("info.schemaVersion", String(currentSchemaVersion(this.db)), true);
		}
	}

	/**
	 * Secret used to sign CSRF tokens. A value from the instance settings wins; without one the adapter generates a
	 * secret on the first start and stores it next to the database, so a restart keeps the CSRF tokens of clients
	 * that are already open valid.
	 */
	private sessionSecret(): string {
		const resolved = resolveSessionSecret({
			configured: this.config.sessionSecret,
			file: path.join(path.dirname(this.databaseFile()), SECRET_FILE_NAME),
		});

		if (resolved.source === "configured") {
			this.log.debug("session secret taken from the instance settings");
		} else if (resolved.source === "stored") {
			this.log.debug(`session secret taken from ${resolved.file}`);
		} else if (resolved.file) {
			this.log.info(
				`no session secret configured - generated one and stored it at ${resolved.file}, so sessions and CSRF tokens survive restarts`,
			);
		} else {
			this.log.warn(
				`no session secret configured and it could not be stored (${resolved.error ?? "unknown"}) - a temporary one is used, so all sessions end with the next restart`,
			);
		}

		return resolved.secret;
	}

	/**
	 * Secret that signs the badge/NFC links.
	 *
	 * A value from the instance settings wins. Without one a secret is generated on the first start and stored next
	 * to the database — otherwise a fresh installation could not create a badge at all and the administration would
	 * only report “not configured”.
	 */
	private tagSecret(): string {
		const resolved = resolveSessionSecret({
			configured: this.config.hmacSecret,
			file: path.join(path.dirname(this.databaseFile()), TAG_SECRET_FILE_NAME),
		});

		if (resolved.source === "configured") {
			this.log.debug("badge link secret taken from the instance settings");
		} else if (resolved.source === "stored") {
			this.log.debug(`badge link secret taken from ${resolved.file}`);
		} else if (resolved.file) {
			this.log.info(
				`no badge link secret configured - generated one and stored it at ${resolved.file}, so badges stay valid across restarts`,
			);
		} else {
			this.log.warn(
				`no badge link secret configured and it could not be stored (${resolved.error ?? "unknown"}) - a temporary one is used, so badges stop working with the next restart`,
			);
		}

		return resolved.secret;
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
		const payouts = createPayoutsRepository(db);
		const terminals = createTerminalsRepository(db);
		const rfid = createRfidRepository(db);
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
		const triggers = createTriggersRepository(db);
		const automations = createAutomationsRepository(db);
		const sync = createSyncService({ db, entries, users, aggregation });
		const closing = createClosingService({ db, aggregation, payouts });
		// backups live next to the database file: `<data dir>/backups/time-tracker-<timestamp>.sqlite`
		const backup = createBackupService({
			db,
			dir: path.join(path.dirname(this.databaseFile()), "backups"),
			retentionDays: Math.max(0, Number(this.config.backupRetentionDays ?? 30) || 0),
		});
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
			triggers,
			automations,
			aggregation,
			sync,
			settings,
			backup,
			kioskEnabled: this.config.kioskEnabled === true,
			// a reverse proxy in front is the normal case for HTTPS; without the switch the forwarded
			// headers are ignored, so a client cannot choose its own address or the HTTPS flag
			trustProxy: this.config.trustProxy === true,
			hmacSecret: this.tagSecret(),
			version: this.version,
			// a saved trigger rule changes the states the adapter has to watch
			onTriggerRulesChanged: () => void this.refreshTriggerSubscriptions(),
		});

		this.services = {
			users,
			entries,
			absences,
			settings,
			aggregation,
			sync,
			closing,
			backup,
			triggers,
			automations,
		};
		this.events = api.events;
		// the newest event is mirrored into the state tree, so a notification only has to watch `events.*`;
		// a punch, a correction or an absence changes the figures, so they are republished right away
		api.events.subscribe(event => {
			void this.publishEventState(event);
			if (FIGURES_EVENT_TYPES.includes(event.type)) {
				this.scheduleStateRefresh();
			}
		});
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
				port: this.config.port || 8092,
				bind: this.config.bind || "127.0.0.1",
				staticFiles,
				// an uploaded backup is bigger than the default limit; the route carries the same bound
				maxBodyBytes: MAX_BACKUP_UPLOAD_BYTES,
				// live events for the PWA and the terminal: `/api/stream?token=...`
				stream: {
					auth,
					events: api.events,
					version: this.version,
					timers: {
						// the adapter's own timer functions: they are cleared with the adapter on unload
						setInterval: (handler, milliseconds) => this.setInterval(handler, milliseconds),
						clearInterval: handle => this.clearInterval(handle as ioBroker.Interval),
					},
				},
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
			await createInfoStates(this);
			await createCompanyStates(this);
			await createEventStates(this);
			await this.subscribeStatesAsync("commands.*");
			// the presence switch of every employee: written by a script, a fingerprint reader or a dashboard
			await this.subscribeStatesAsync(`users.*.${PRESENCE_SUFFIX}`);
			this.log.debug("command states ready");
		} catch (error) {
			this.log.warn(`command states could not be created: ${(error as Error).message}`);
		}
	}

	/**
	 * Writes a backup unless a recent one exists.
	 *
	 * The check runs hourly and once at start: a nightly backup therefore happens within an hour at the latest,
	 * and an instance that was down for days does not write a burst of copies.
	 */
	private async runScheduledBackup(): Promise<void> {
		const backup = this.services?.backup;
		if (!backup) {
			return;
		}
		try {
			const newest = backup.list()[0];
			const ageHours = newest ? (Date.now() / 1000 - newest.createdAt) / 3600 : Number.POSITIVE_INFINITY;
			if (ageHours < BACKUP_MAX_AGE_HOURS) {
				this.log.debug(`backup ${newest?.name ?? ""} is ${ageHours.toFixed(1)} h old, nothing to do`);
				return;
			}

			const created = backup.create({ actorId: null, reason: "scheduled" });
			this.log.info(
				`backup ${created.backup.name} written (${created.backup.sizeBytes} bytes, ${created.backup.users} employees, ${created.backup.entries} punches), ${created.removed.length} old file(s) removed`,
			);
			await this.announceBackup(created.backup.name, created.backup.createdAt);
		} catch (error) {
			this.log.warn(`backup failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Publishes the instant of a written backup.
	 *
	 * @param name - file name of the backup
	 * @param createdAt - instant the backup belongs to
	 */
	private async announceBackup(name: string, createdAt: number): Promise<void> {
		await this.setState("info.lastBackup", createdAt, true);
		this.events?.publish({
			type: "backup.create",
			atUtc: createdAt,
			userId: null,
			data: { backup: name },
		});
	}

	/**
	 * Applies a write on the presence state of an employee.
	 *
	 * `users.<id>.present` is the writable twin of `users.<id>.hasOpenEntry`: `true` opens an entry, `false` closes
	 * it. Afterwards the figures of all employees are republished, so a dashboard sees the new state right away.
	 *
	 * @param id - state id without the instance prefix
	 * @param value - value written by the user or a script
	 */
	private async runPresence(id: string, value: ioBroker.StateValue): Promise<void> {
		const services = this.services;
		if (!services) {
			return;
		}

		try {
			const result = handlePresenceState(
				{
					entries: services.entries,
					users: services.users,
					aggregation: services.aggregation,
				},
				id,
				value,
			);
			if (result.ok) {
				this.log.info(`presence ${id}: ${result.message}`);
			} else {
				// a value the state does not understand, an unknown employee: worth a warning, not an error
				this.log.warn(`presence ${id}: ${result.message}`);
			}
			await this.refreshStates();
		} catch (error) {
			this.log.error(`Error in runPresence for ${id}: ${(error as Error).message}`);
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
			// the company figures are derived from the same snapshots, so they never disagree
			await publishCompanySnapshot(this, readCompanySnapshot(snapshots));
			// the target employee of the punch commands is mirrored into the state the user writes (acknowledged, so
			// the adapter ignores its own write — see `onStateChange`). `0` means "the only employee".
			await this.setState(COMMAND_IDS.punchUserId, services.settings.getNumber("command_punch_user_id", 0), true);
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
					backup: services.backup,
				},
				id,
				value,
			);
			this.log.info(`command ${id}: ${result.message}`);
			// a closing is triggered from a state, not from a request: tell the connected clients about it
			// (only the period is published, never the figures of the employee it belongs to)
			if (id === COMMAND_IDS.closeMonth) {
				this.events?.publish({
					type: "month.close",
					atUtc: Math.floor(Date.now() / 1000),
					userId: null,
					data: { period: String(value ?? "") },
				});
			}
			// a manual backup reports its file the same way the scheduled one does
			if (id === COMMAND_IDS.backup && result.ok) {
				const newest = services.backup.list()[0];
				if (newest) {
					await this.announceBackup(newest.name, newest.createdAt);
				}
			}
		} catch (error) {
			this.log.warn(`command ${id} failed: ${(error as Error).message}`);
		}

		// buttons are stateless: always release them again
		if (id === COMMAND_IDS.punch || id === COMMAND_IDS.quickPunch || id === COMMAND_IDS.backup) {
			await this.setState(id, false, true);
		}
		await this.refreshStates();
	}

	/**
	 * Watches exactly the states the active trigger rules name.
	 *
	 * Runs at startup and whenever the administration saves the rules, so an added, changed or removed rule takes
	 * effect without a restart. A state that no rule names any more is dropped from the watch list.
	 */
	private async refreshTriggerSubscriptions(): Promise<void> {
		const services = this.services;
		if (!services) {
			return;
		}

		let rules: TriggerRuleRecord[] = [];
		try {
			rules = services.triggers.list();
		} catch (error) {
			this.log.warn(`trigger rules could not be read: ${(error as Error).message}`);
			return;
		}

		const wanted = new Set(rules.map(rule => rule.sourceState));
		for (const id of [...this.triggerStates]) {
			if (wanted.has(id)) {
				continue;
			}
			try {
				await this.unsubscribeForeignStatesAsync(id);
			} catch (error) {
				this.log.debug(`trigger state ${id} could not be released: ${(error as Error).message}`);
			}
			this.triggerStates.delete(id);
			this.triggerValues.delete(id);
		}

		for (const id of wanted) {
			if (this.triggerStates.has(id)) {
				continue;
			}
			try {
				await this.subscribeForeignStatesAsync(id);
				this.triggerStates.add(id);
			} catch (error) {
				this.log.warn(`trigger state ${id} could not be watched: ${(error as Error).message}`);
			}
		}

		this.log.debug(`watching ${this.triggerStates.size} trigger state(s) for ${rules.length} active rule(s)`);
	}

	/**
	 * Applies a write on a state that trigger rules watch.
	 *
	 * Such a state belongs to another adapter, so its `ack` says nothing about whether the value was set by a
	 * script or by the device. What counts is that the value **changed**: a reader that repeats itself, a
	 * dashboard that refreshes or a script that writes the same value twice does not punch twice. Together with
	 * the cooldown of a rule even a rapidly blinking state stays harmless.
	 *
	 * @param id - full state id
	 * @param state - state object of the write
	 * @returns true when the state belongs to a rule and was handled here
	 */
	private handleTriggerState(id: string, state: ioBroker.State): boolean {
		const services = this.services;
		if (!services) {
			return false;
		}

		const previous = this.triggerValues.get(id) ?? null;
		this.triggerValues.set(id, triggerText(state.val));

		const rules = services.triggers.list().filter(rule => rule.sourceState === id);
		if (rules.length === 0) {
			return false;
		}

		const now = Math.floor(Date.now() / 1000);
		for (const rule of rules) {
			const decision = evaluateTrigger(rule, { value: state.val, previous, now }, services.users);
			if (!decision.fire || decision.userId === null) {
				this.log.debug(`trigger ${rule.id} (${rule.sourceState}) did not fire: ${decision.reason}`);
				continue;
			}
			this.runTrigger(rule, decision.userId);
		}
		return true;
	}

	/**
	 * Runs the action of a rule that fired.
	 *
	 * The punch goes through the same path as the command state and a presence change through the same handler as
	 * the `users.<id>.present` state, so direction, rounding, notes and the recalculation behave identically.
	 *
	 * @param rule - rule that fired
	 * @param userId - employee the action applies to
	 */
	private runTrigger(rule: TriggerRuleRecord, userId: number): void {
		void (async (): Promise<void> => {
			const services = this.services;
			if (!services) {
				return;
			}
			try {
				const result =
					rule.action === "present" || rule.action === "absent"
						? handlePresenceState(
								{ entries: services.entries, users: services.users, aggregation: services.aggregation },
								`users.${userId}.${PRESENCE_SUFFIX}`,
								rule.action === "present",
							)
						: punchEmployee(
								{
									entries: services.entries,
									users: services.users,
									settings: services.settings,
									aggregation: services.aggregation,
								},
								{ userId, quick: rule.action === "quickPunch", note: `trigger.${rule.id}` },
							);
				this.log.info(`trigger ${rule.id} (${rule.sourceState}) → ${result.message}`);
				services.triggers.markFired({ id: rule.id });
				await this.refreshStates();
			} catch (error) {
				// a deleted employee, a deactivated one, a value that cannot be used: never take the adapter down
				this.log.warn(`trigger ${rule.id} failed: ${(error as Error).message}`);
			}
		})();
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
	 * Runs the automation rules that are due.
	 *
	 * A rule acts at most once per employee and period — the local date, or the ISO week for a weekly rule;
	 * `automation_runs` holds that decision, so a restart
	 * cannot punch twice. The run is noted **before** the action (a double punch would be worse than a missed
	 * reminder) and taken back when the action fails, so the next minute retries it.
	 */
	private runAutomationRules(): void {
		const services = this.services;
		if (!services) {
			return;
		}

		let rules: AutomationRuleRecord[] = [];
		try {
			rules = services.automations.list();
		} catch (error) {
			this.log.warn(`automation rules could not be read: ${(error as Error).message}`);
			return;
		}
		if (rules.length === 0) {
			return;
		}

		const nowUtc = Math.floor(Date.now() / 1000);
		let acted = false;

		for (const rule of rules) {
			const candidates =
				rule.userId === null
					? services.users.list()
					: [services.users.findById(rule.userId)].filter((user): user is UserRecord => user !== null);

			for (const user of candidates) {
				if (!user.isActive) {
					continue;
				}
				const local = localDateTime(nowUtc, user.timezone);
				// a weekly rule is guarded per ISO week, a daily rule per local date
				const period = runPeriod(rule.repeat, local.date);
				if (services.automations.hasRun({ ruleId: rule.id, userId: user.id, period })) {
					continue;
				}

				const punches = services.entries
					.listByDate(user.id, local.date)
					.map(entry => ({ tsUtc: entry.tsUtc, direction: entry.direction }));
				const block = workBlock(punches, nowUtc);
				const decision = evaluateAutomation(rule, {
					localDate: local.date,
					weekday: isoWeekday(local.date),
					minuteOfDay: local.minutes,
					hasOpenEntry: block.hasOpenEntry,
					blockMinutes: block.blockMinutes,
					alreadyRan: false,
				});
				if (!decision.fire) {
					this.log.debug(`automation ${rule.id} (${user.displayName}): ${decision.reason}`);
					continue;
				}

				const action = this.automationAction(rule, block.blockMinutes);
				if (
					!services.automations.recordRun({
						ruleId: rule.id,
						userId: user.id,
						period,
						action,
						now: nowUtc,
					})
				) {
					continue;
				}

				try {
					if (rule.kind === "clockOut" || rule.kind === "clockIn") {
						const result = punchEmployee(
							{
								entries: services.entries,
								users: services.users,
								settings: services.settings,
								aggregation: services.aggregation,
							},
							{ userId: user.id, note: `auto.${rule.kind}`, now: nowUtc },
						);
						this.log.info(`automation ${rule.id} for ${user.displayName}: ${result.message}`);
					} else {
						this.log.info(`automation ${rule.id} for ${user.displayName}: ${action}`);
					}
					acted = true;
					this.events?.publish({
						type: `automation.${rule.kind}`,
						atUtc: nowUtc,
						userId: user.id,
						data: { ruleId: rule.id, action, reason: decision.reason },
					});
				} catch (error) {
					// give the next check a chance instead of losing the period
					services.automations.forgetRun({ ruleId: rule.id, userId: user.id, period });
					this.log.warn(`automation ${rule.id} for ${user.displayName} failed: ${(error as Error).message}`);
				}
			}
		}

		if (acted) {
			// a punch written by a rule changes the published figures
			this.scheduleStateRefresh();
		}
	}

	/**
	 * Short description of what a rule did (the log entry of `automation_runs`).
	 *
	 * @param rule - rule that fired
	 * @param blockMinutes - length of the running work block, `null` when the employee is not clocked in
	 * @returns text for the log
	 */
	private automationAction(rule: AutomationRuleRecord, blockMinutes: number | null): string {
		if (rule.kind === "clockOut") {
			return "clocked out";
		}
		if (rule.kind === "clockIn") {
			return "clocked in";
		}
		if (rule.kind === "breakReminder") {
			return `reminded after ${blockMinutes ?? 0} min without a break`;
		}
		return "reported a missing punch";
	}

	/**
	 * Republishes the figures shortly after data changed.
	 *
	 * A punch from the web app, the terminal or a badge arrives through the API of this very process, so without
	 * this the states would only change with the five minute timer. One action often produces several events, so
	 * the refresh is collected for a moment instead of running once per event.
	 */
	private scheduleStateRefresh(): void {
		if (this.stateRefreshTimer) {
			return;
		}
		this.stateRefreshTimer = this.setTimeout(() => {
			this.stateRefreshTimer = undefined;
			void this.refreshStates();
		}, 1000);
	}

	/**
	 * Publishes the newest event of the instance into the state tree.
	 *
	 * A notification adapter, a dashboard or a Blockly script then only has to watch `events.*` instead of
	 * following the live stream of the web app.
	 *
	 * @param event - event published by the API
	 */
	private async publishEventState(event: ApiEvent): Promise<void> {
		const services = this.services;
		if (!services) {
			return;
		}
		try {
			const data = event.data ?? {};
			const user =
				event.userId === null || event.userId === undefined ? null : services.users.findById(event.userId);
			await publishEventSnapshot(this, {
				type: event.type,
				atUtc: event.atUtc,
				userName: user?.displayName ?? "",
				direction: typeof data.direction === "string" ? data.direction : "",
				source: typeof data.source === "string" ? data.source : "",
			});
		} catch (error) {
			this.log.debug(`event state could not be published: ${(error as Error).message}`);
		}
	}

	/**
	 * Is called when another adapter sends a message (`sendTo`).
	 *
	 * @param obj - message object of the adapter framework
	 */
	private onMessage(obj: ioBroker.Message): void {
		void (async (): Promise<void> => {
			const services = this.services;
			if (!services) {
				return;
			}
			try {
				const answer = await handleMessage(
					{
						users: services.users,
						entries: services.entries,
						absences: services.absences,
						settings: services.settings,
						aggregation: services.aggregation,
						sync: services.sync,
						backup: services.backup,
						version: this.version,
					},
					obj.command,
					obj.message,
				);
				this.log.info(`message ${obj.command}: ${answer.message}`);
				if (obj.callback) {
					this.sendTo(obj.from, obj.command, answer, obj.callback);
				}
				await this.refreshStates();
			} catch (error) {
				const message = (error as Error).message;
				this.log.warn(`message ${obj.command} failed: ${message}`);
				if (obj.callback) {
					this.sendTo(obj.from, obj.command, { ok: false, message }, obj.callback);
				}
			}
		})();
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param id - State ID
	 * @param state - State object
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		try {
			if (!state) {
				// deletions carry no value
				return;
			}
			// a watched state of another adapter is handled first: such a state is acknowledged by its own
			// adapter, and what counts there is the change of the value
			if (this.handleTriggerState(id, state)) {
				return;
			}
			if (state.ack) {
				// Ignore acknowledged (status) states of this instance
				return;
			}

			const prefix = `${this.namespace}.`;
			const localId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
			if (localId.startsWith("commands.")) {
				void this.runCommand(localId, state.val);
				return;
			}
			if (parsePresenceStateId(localId) !== null) {
				void this.runPresence(localId, state.val);
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
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new TimeTracker(options);
} else {
	// otherwise start the instance directly
	(() => new TimeTracker())();
}
