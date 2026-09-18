/**
 * States published by the adapter.
 *
 * The adapter exposes a small, stable state tree so that other adapters (and the user's dashboards) can show
 * and trigger time tracking without speaking to the REST API:
 *
 * ```
 * users.<userId>.displayName / present / hasOpenEntry / lastPunch / todayWorkedMinutes / todayBalanceMinutes
 * users.<userId>.openConflicts
 * commands.punchUserId / punch / quickPunch / closeMonth / recalc
 * ```
 *
 * All objects are created with `setObjectNotExists`, so existing instances keep their settings. The logic works
 * on a tiny port interface (`StatePort`) — the adapter instance in production, a recorder in the tests.
 */

import type { UsersRepository } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import type { SyncService } from "../services/sync";
import { localDate as resolveLocalDate } from "../util/time";

/** Subset of the adapter API the state layer needs. */
export interface StatePort {
	/**
	 * Creates an object when it does not exist yet.
	 *
	 * @param id - full state id (including the instance prefix)
	 * @param object - object definition
	 */
	setObjectNotExists(id: string, object: ioBroker.SettableObject): Promise<unknown> | void;
	/**
	 * Writes a state value.
	 *
	 * @param id - full state id (including the instance prefix)
	 * @param value - value to write
	 * @param ack - true for confirmed values
	 */
	setState(id: string, value: ioBroker.StateValue, ack?: boolean): Promise<unknown> | void;
}

/** Figures of one employee shown in the state tree. */
export interface UserSnapshot {
	/** Database id of the employee */
	userId: number;
	/** Shown name */
	displayName: string;
	/** True when the last punch of today has no counterpart */
	hasOpenEntry: boolean;
	/** Instant of the last punch of the day, `null` when there is none */
	lastPunchUtc: number | null;
	/** Net working time of today in minutes */
	workedMinutes: number;
	/** Balance of today in minutes */
	balanceMinutes: number;
	/** Punches waiting for a decision */
	openConflicts: number;
	/** Net working time of the current month in minutes */
	monthWorkedMinutes: number;
	/** Balance of the current month in minutes */
	monthBalanceMinutes: number;
	/** Balance of the current year in minutes */
	yearBalanceMinutes: number;
}

/** Figures of the whole company, published next to the employees. */
export interface CompanySnapshot {
	/** Employees that are clocked in right now */
	presentCount: number;
	/** Names of those employees, separated by a comma (empty when nobody is present) */
	present: string;
	/** Punches of all employees waiting for a decision */
	openConflicts: number;
	/** Instant of the newest punch of today, `null` when nobody punched */
	lastPunchUtc: number | null;
}

/** Newest event of the instance, mirrored into the state tree. */
export interface EventSnapshot {
	/** Kind of the event, e.g. `punch` */
	type: string;
	/** Instant the event belongs to */
	atUtc: number;
	/** Name of the employee the event belongs to, empty for instance wide events */
	userName: string;
	/** Direction of a punch (`in`/`out`), empty for other events */
	direction: string;
	/** Where the change came from, e.g. `web` or `terminal`, empty when unknown */
	source: string;
}

/** Names of the writable command states. */
export const COMMAND_IDS = {
	/** Employee the commands apply to */
	punchUserId: "commands.punchUserId",
	/** Punch in or out for `punchUserId` */
	punch: "commands.punch",
	/** Punch in or out with the configured quick rounding */
	quickPunch: "commands.quickPunch",
	/** Close a month, value `YYYY-MM` */
	closeMonth: "commands.closeMonth",
	/** Recalculate a period, value `YYYY-MM` or `YYYY` */
	recalc: "commands.recalc",
	/** Write a backup of the database */
	backup: "commands.backup",
} as const;

/**
 * Builds a state object definition.
 *
 * @param name - name in English and German
 * @param name.en - English name
 * @param name.de - German name
 * @param type - state type
 * @param role - state role
 * @param options - additional flags
 * @param options.read - value can be read (default true)
 * @param options.write - value can be written (default false)
 * @param options.unit - unit of the value
 * @returns object definition
 */
function stateObject(
	name: { en: string; de: string },
	type: ioBroker.CommonType,
	role: string,
	options: { read?: boolean; write?: boolean; unit?: string } = {},
): ioBroker.SettableObject {
	return {
		type: "state",
		common: {
			name,
			type,
			role,
			read: options.read !== false,
			write: options.write === true,
			...(options.unit ? { unit: options.unit } : {}),
		},
		native: {},
	};
}

/**
 * Builds a channel object definition.
 *
 * @param name - name in English and German
 * @param name.en - English name
 * @param name.de - German name
 * @returns object definition
 */
function channelObject(name: { en: string; de: string }): ioBroker.SettableObject {
	return { type: "channel", common: { name }, native: {} };
}

/**
 * Reads the figures of an employee for the state tree.
 *
 * @param args - data sources and employee
 * @param args.aggregation - aggregation service
 * @param args.users - user storage
 * @param args.sync - synchronisation service (open conflicts)
 * @param args.userId - database id of the employee
 * @param args.now - instant of the snapshot
 * @returns snapshot of the figures
 */
export function readUserSnapshot(args: {
	aggregation: AggregationService;
	users: UsersRepository;
	sync: SyncService;
	userId: number;
	now?: number;
}): UserSnapshot | null {
	const user = args.users.findById(args.userId);
	if (!user) {
		return null;
	}

	const timestamp = args.now ?? Math.floor(Date.now() / 1000);
	const today = resolveLocalDate(timestamp, user.timezone);
	const day = args.aggregation.recalculateDay(user.id, today, { now: timestamp });
	// the month is recalculated like the month view does it; the year is read, so the publishing stays cheap
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	const monthAggregate = args.aggregation.recalculateMonth(user.id, year, month, { now: timestamp });
	const yearAggregate = args.aggregation.year(user.id, year);

	return {
		userId: user.id,
		displayName: user.displayName,
		hasOpenEntry: day.hasOpenEntry,
		lastPunchUtc: Math.max(day.firstInUtc ?? 0, day.lastOutUtc ?? 0) || null,
		workedMinutes: day.workedMin,
		balanceMinutes: day.balanceMin,
		openConflicts: args.sync.conflicts(user.id).length,
		monthWorkedMinutes: monthAggregate.workedMin,
		monthBalanceMinutes: monthAggregate.balanceMin,
		yearBalanceMinutes: yearAggregate ? yearAggregate.workedMin - yearAggregate.targetMin : 0,
	};
}

/**
 * Publishes the figures of one employee.
 *
 * @param port - state port
 * @param snapshot - figures to publish
 */
export async function publishUserSnapshot(port: StatePort, snapshot: UserSnapshot): Promise<void> {
	const id = `users.${snapshot.userId}`;
	await port.setState(`${id}.displayName`, snapshot.displayName, true);
	await port.setState(`${id}.present`, snapshot.hasOpenEntry, true);
	await port.setState(`${id}.hasOpenEntry`, snapshot.hasOpenEntry, true);
	await port.setState(`${id}.lastPunch`, snapshot.lastPunchUtc ?? 0, true);
	await port.setState(`${id}.todayWorkedMinutes`, snapshot.workedMinutes, true);
	await port.setState(`${id}.todayBalanceMinutes`, snapshot.balanceMinutes, true);
	await port.setState(`${id}.monthWorkedMinutes`, snapshot.monthWorkedMinutes, true);
	await port.setState(`${id}.monthBalanceMinutes`, snapshot.monthBalanceMinutes, true);
	await port.setState(`${id}.yearBalanceMinutes`, snapshot.yearBalanceMinutes, true);
	await port.setState(`${id}.openConflicts`, snapshot.openConflicts, true);
}

/**
 * Creates the channels of all employees and publishes their current figures.
 *
 * @param args - state port and data sources
 * @param args.port - state port
 * @param args.aggregation - aggregation service
 * @param args.users - user storage
 * @param args.sync - synchronisation service
 * @param args.now - instant of the snapshot
 * @returns the published snapshots
 */
export async function publishAllUserStates(args: {
	port: StatePort;
	aggregation: AggregationService;
	users: UsersRepository;
	sync: SyncService;
	now?: number;
}): Promise<UserSnapshot[]> {
	const snapshots: UserSnapshot[] = [];
	for (const user of args.users.list({ includeInactive: true })) {
		await createUserChannel(args.port, user.id);
		const snapshot = readUserSnapshot({
			aggregation: args.aggregation,
			users: args.users,
			sync: args.sync,
			userId: user.id,
			now: args.now,
		});
		if (!snapshot) {
			continue;
		}
		await publishUserSnapshot(args.port, snapshot);
		snapshots.push(snapshot);
	}
	return snapshots;
}

/**
 * Creates the channel of one employee.
 *
 * @param port - state port
 * @param userId - database id of the employee
 * @returns the channel id
 */
export async function createUserChannel(port: StatePort, userId: number): Promise<string> {
	const id = `users.${userId}`;
	await port.setObjectNotExists(id, channelObject({ en: "Employee", de: "Mitarbeiter" }));
	await port.setObjectNotExists(`${id}.displayName`, stateObject({ en: "Name", de: "Name" }, "string", "info.name"));
	// the writable twin of `hasOpenEntry`: a script, a fingerprint reader or a dashboard writes it to say that
	// somebody arrived (`true`) or left (`false`) — see `presence.ts` for what the adapter does with it
	await port.setObjectNotExists(
		`${id}.present`,
		stateObject(
			{ en: "Present (working time is running)", de: "Anwesenheit (Arbeitszeit läuft)" },
			"boolean",
			"switch",
			{ write: true },
		),
	);
	await port.setObjectNotExists(
		`${id}.hasOpenEntry`,
		stateObject({ en: "Punched in", de: "Eingestempelt" }, "boolean", "indicator.working"),
	);
	await port.setObjectNotExists(
		`${id}.lastPunch`,
		stateObject({ en: "Last punch", de: "Letzte Buchung" }, "number", "value.time"),
	);
	await port.setObjectNotExists(
		`${id}.todayWorkedMinutes`,
		stateObject({ en: "Worked today", de: "Heute gearbeitet" }, "number", "value", { unit: "min" }),
	);
	await port.setObjectNotExists(
		`${id}.todayBalanceMinutes`,
		stateObject({ en: "Balance today", de: "Saldo heute" }, "number", "value", { unit: "min" }),
	);
	await port.setObjectNotExists(
		`${id}.monthWorkedMinutes`,
		stateObject({ en: "Worked this month", de: "Diesen Monat gearbeitet" }, "number", "value", { unit: "min" }),
	);
	await port.setObjectNotExists(
		`${id}.monthBalanceMinutes`,
		stateObject({ en: "Balance this month", de: "Saldo diesen Monat" }, "number", "value", { unit: "min" }),
	);
	await port.setObjectNotExists(
		`${id}.yearBalanceMinutes`,
		stateObject({ en: "Balance this year", de: "Saldo dieses Jahr" }, "number", "value", { unit: "min" }),
	);
	await port.setObjectNotExists(
		`${id}.openConflicts`,
		stateObject({ en: "Open conflicts", de: "Offene Konflikte" }, "number", "value"),
	);
	return id;
}

/**
 * Creates the writable command states.
 *
 * @param port - state port
 */
export async function createCommandStates(port: StatePort): Promise<void> {
	await port.setObjectNotExists("commands", channelObject({ en: "Commands", de: "Befehle" }));
	await port.setObjectNotExists(
		COMMAND_IDS.punchUserId,
		stateObject(
			{ en: "Employee id for punch commands", de: "Mitarbeiter-Id für Stempelbefehle" },
			"number",
			"value",
			{
				write: true,
			},
		),
	);
	await port.setObjectNotExists(
		COMMAND_IDS.punch,
		stateObject({ en: "Punch in or out", de: "Ein- oder ausstempeln" }, "boolean", "button", {
			read: false,
			write: true,
		}),
	);
	await port.setObjectNotExists(
		COMMAND_IDS.quickPunch,
		stateObject({ en: "Punch with quick rounding", de: "Stempeln mit Schnellrundung" }, "boolean", "button", {
			read: false,
			write: true,
		}),
	);
	await port.setObjectNotExists(
		COMMAND_IDS.closeMonth,
		stateObject({ en: "Close month (YYYY-MM)", de: "Monat abschließen (JJJJ-MM)" }, "string", "text", {
			write: true,
		}),
	);
	await port.setObjectNotExists(
		COMMAND_IDS.recalc,
		stateObject(
			{ en: "Recalculate period (YYYY-MM or YYYY)", de: "Zeitraum neu berechnen (JJJJ-MM oder JJJJ)" },
			"string",
			"text",
			{ write: true },
		),
	);
	await port.setObjectNotExists(
		COMMAND_IDS.backup,
		stateObject({ en: "Write a database backup", de: "Datenbank-Sicherung schreiben" }, "boolean", "button", {
			read: false,
			write: true,
		}),
	);
}

/**
 * Creates the informational states of the instance.
 *
 * @param port - state port
 */
export async function createInfoStates(port: StatePort): Promise<void> {
	await port.setObjectNotExists("info", channelObject({ en: "Information", de: "Information" }));
	await port.setObjectNotExists(
		"info.version",
		stateObject({ en: "Adapter version", de: "Adapter-Version" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"info.schemaVersion",
		stateObject({ en: "Database schema version", de: "Datenbank-Schemaversion" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"info.dbSizeBytes",
		stateObject({ en: "Database size", de: "Datenbank-Größe" }, "number", "value", { unit: "bytes" }),
	);
	await port.setObjectNotExists(
		"info.lastError",
		stateObject({ en: "Last error", de: "Letzter Fehler" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"info.lastBackup",
		stateObject({ en: "Last backup", de: "Letzte Sicherung" }, "number", "value.time"),
	);
}

/**
 * Creates the states of the company.
 *
 * @param port - state port
 */
export async function createCompanyStates(port: StatePort): Promise<void> {
	await port.setObjectNotExists("company", channelObject({ en: "Company", de: "Firma" }));
	await port.setObjectNotExists(
		"company.presentCount",
		stateObject({ en: "Present employees", de: "Anwesende Mitarbeiter" }, "number", "value"),
	);
	await port.setObjectNotExists(
		"company.present",
		stateObject({ en: "Who is present", de: "Wer ist anwesend" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"company.openConflicts",
		stateObject({ en: "Open conflicts", de: "Offene Konflikte" }, "number", "value"),
	);
	await port.setObjectNotExists(
		"company.lastPunch",
		stateObject({ en: "Last punch", de: "Letzte Buchung" }, "number", "value.time"),
	);
}

/**
 * Reads the company figures out of the figures of the employees.
 *
 * @param snapshots - figures of all employees
 * @returns the company figures
 */
export function readCompanySnapshot(snapshots: UserSnapshot[]): CompanySnapshot {
	const present = snapshots.filter(snapshot => snapshot.hasOpenEntry);
	return {
		presentCount: present.length,
		present: present.map(snapshot => snapshot.displayName).join(", "),
		openConflicts: snapshots.reduce((sum, snapshot) => sum + snapshot.openConflicts, 0),
		lastPunchUtc: snapshots.reduce<number | null>(
			(newest, snapshot) =>
				snapshot.lastPunchUtc !== null && (newest === null || snapshot.lastPunchUtc > newest)
					? snapshot.lastPunchUtc
					: newest,
			null,
		),
	};
}

/**
 * Publishes the company figures.
 *
 * @param port - state port
 * @param snapshot - figures to publish
 */
export async function publishCompanySnapshot(port: StatePort, snapshot: CompanySnapshot): Promise<void> {
	await port.setState("company.presentCount", snapshot.presentCount, true);
	await port.setState("company.present", snapshot.present, true);
	await port.setState("company.openConflicts", snapshot.openConflicts, true);
	await port.setState("company.lastPunch", snapshot.lastPunchUtc ?? 0, true);
}

/**
 * Creates the event states.
 *
 * @param port - state port
 */
export async function createEventStates(port: StatePort): Promise<void> {
	await port.setObjectNotExists("events", channelObject({ en: "Events", de: "Ereignisse" }));
	await port.setObjectNotExists(
		"events.lastAt",
		stateObject({ en: "Last event at", de: "Letztes Ereignis um" }, "number", "value.time"),
	);
	await port.setObjectNotExists(
		"events.lastType",
		stateObject({ en: "Kind of the last event", de: "Art des letzten Ereignisses" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"events.lastUser",
		stateObject({ en: "Employee of the last event", de: "Mitarbeiter des letzten Ereignisses" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"events.lastDirection",
		stateObject({ en: "Direction of the last punch", de: "Richtung der letzten Buchung" }, "string", "text"),
	);
	await port.setObjectNotExists(
		"events.lastSource",
		stateObject({ en: "Source of the last event", de: "Quelle des letzten Ereignisses" }, "string", "text"),
	);
}

/**
 * Publishes the newest event.
 *
 * @param port - state port
 * @param snapshot - event to publish
 */
export async function publishEventSnapshot(port: StatePort, snapshot: EventSnapshot): Promise<void> {
	await port.setState("events.lastAt", snapshot.atUtc, true);
	await port.setState("events.lastType", snapshot.type, true);
	await port.setState("events.lastUser", snapshot.userName, true);
	await port.setState("events.lastDirection", snapshot.direction, true);
	await port.setState("events.lastSource", snapshot.source, true);
}
