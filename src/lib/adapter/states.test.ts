/**
 * Command states and the published figures of the adapter.
 *
 * A small recorder stands in for the adapter instance, so the state tree and the command handling can be
 * tested without a running ioBroker.
 */

/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createPayoutsRepository } from "../db/repositories/payouts";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService, type AggregationService } from "../services/aggregation";
import { createBackupService } from "../services/backup";
import { createClosingService, type ClosingService } from "../services/closing";
import { createSyncService, type SyncService } from "../services/sync";
import { handleCommand, type CommandDeps } from "./commands";
import { handlePresenceState, parsePresenceStateId, readPresenceValue, type PresenceDeps } from "./presence";
import {
	COMMAND_IDS,
	createCommandStates,
	createInfoStates,
	createUserChannel,
	publishAllUserStates,
	publishUserSnapshot,
	readUserSnapshot,
	type StatePort,
} from "./states";

/** Records the object definitions and state values written by the adapter. */
class Recorder implements StatePort {
	/** Object definitions by id */
	public readonly objects = new Map<string, ioBroker.SettableObject>();
	/** State values by id */
	public readonly values = new Map<string, ioBroker.StateValue>();

	/**
	 * Remembers an object definition.
	 *
	 * @param id - object id
	 * @param object - object definition
	 */
	public setObjectNotExists(id: string, object: ioBroker.SettableObject): void {
		this.objects.set(id, object);
	}

	/**
	 * Remembers a state value.
	 *
	 * @param id - state id
	 * @param value - value
	 * @param ack - acknowledgement flag
	 */
	public setState(id: string, value: ioBroker.StateValue, ack = false): void {
		this.values.set(id, ack ? value : `unacked:${String(value)}`);
	}
}

describe("adapter states and commands", () => {
	let db: Db;
	let recorder: Recorder;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let settings: SettingsRepository;
	let aggregation: AggregationService;
	let sync: SyncService;
	let closing: ClosingService;
	let annaId: number;
	let now = 1_000_000;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		recorder = new Recorder();
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		const absences = createAbsencesRepository(db);
		settings = createSettingsRepository(db);
		aggregation = createAggregationService({
			db,
			users,
			entries,
			absences,
			holidays: createHolidaysRepository(db),
			rules: createRulesRepository(db),
			settings,
		});
		sync = createSyncService({ db, entries, users, aggregation });
		closing = createClosingService({ db, aggregation, payouts: createPayoutsRepository(db) });

		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		users.saveWorkProfile({ userId: annaId, profile: { weeklyHours: 40, percent: 100 }, actorId: annaId });
	});

	afterEach(() => {
		db.close();
	});

	/**
	 * Builds the dependencies of the command handler.
	 *
	 * @returns command dependencies with a fixed clock
	 */
	function deps(): CommandDeps {
		return { db, entries, users, settings, aggregation, closing, now: () => now };
	}

	describe("state tree", () => {
		it("creates the command states with the ioBroker conventions", async () => {
			await createCommandStates(recorder);

			expect(recorder.objects.get("commands")?.type).to.equal("channel");
			const punch = recorder.objects.get(COMMAND_IDS.punch);
			expect(punch?.type).to.equal("state");
			expect(punch?.common).to.deep.include({ type: "boolean", role: "button", read: false, write: true });

			const closeMonth = recorder.objects.get(COMMAND_IDS.closeMonth);
			expect(closeMonth?.common).to.deep.include({ type: "string", write: true });

			const punchUserId = recorder.objects.get(COMMAND_IDS.punchUserId);
			expect(punchUserId?.common).to.deep.include({ type: "number", write: true });
		});

		it("creates the informational states", async () => {
			await createInfoStates(recorder);

			expect(recorder.objects.get("info")?.type).to.equal("channel");
			expect(recorder.objects.get("info.lastBackup")?.common).to.deep.include({
				type: "number",
				role: "value.time",
			});
		});

		it("creates one channel per employee and publishes the figures", async () => {
			const snapshots = await publishAllUserStates({ port: recorder, aggregation, users, sync, now });

			expect(snapshots).to.have.lengthOf(1);
			const channel = recorder.objects.get(`users.${annaId}`);
			expect(channel?.type).to.equal("channel");

			const openState = recorder.objects.get(`users.${annaId}.hasOpenEntry`);
			expect(openState?.common).to.deep.include({ type: "boolean", role: "indicator.working" });
			expect(recorder.objects.get(`users.${annaId}.lastPunch`)?.common).to.deep.include({ role: "value.time" });
			expect(recorder.objects.get(`users.${annaId}.todayWorkedMinutes`)?.common).to.deep.include({ unit: "min" });

			expect(recorder.values.get(`users.${annaId}.displayName`)).to.equal("Anna");
			expect(recorder.values.get(`users.${annaId}.openConflicts`)).to.equal(0);
		});

		it("reports an open punch and the worked minutes", async () => {
			entries.insert({ userId: annaId, tsUtc: now - 3600, timeZone: "Europe/Berlin" });

			const snapshot = readUserSnapshot({ aggregation, users, sync, userId: annaId, now });

			expect(snapshot).to.not.equal(null);
			expect(snapshot?.hasOpenEntry).to.equal(true);
			expect(snapshot?.lastPunchUtc).to.equal(now - 3600);
			expect(snapshot?.workedMinutes).to.equal(0);

			await publishUserSnapshot(recorder, snapshot as NonNullable<typeof snapshot>);
			expect(recorder.values.get(`users.${annaId}.hasOpenEntry`)).to.equal(true);
		});

		it("returns null for an unknown employee", () => {
			expect(readUserSnapshot({ aggregation, users, sync, userId: 999, now })).to.equal(null);
		});
	});

	describe("commands", () => {
		it("punches in and out and alternates the direction", () => {
			const first = handleCommand(deps(), COMMAND_IDS.punch, true);
			expect(first.ok).to.equal(true);
			expect(first.message).to.contain("punched in");
			expect(first.recalculated).to.have.lengthOf(1);

			// 60 seconds later the second punch is accepted (closer punches are duplicates)
			now += 60;
			const second = handleCommand(deps(), COMMAND_IDS.punch, true);
			expect(second.message).to.contain("punched out");

			const day = aggregation.day(annaId, first.recalculated[0]);
			expect(day?.workedMin).to.equal(1);
			expect(day?.hasOpenEntry).to.equal(false);
			expect(entries.listByDate(annaId, first.recalculated[0])).to.have.lengthOf(2);
		});

		it("ignores anything but true for button states", () => {
			const ignored = handleCommand(deps(), COMMAND_IDS.punch, false);

			expect(ignored.ok).to.equal(false);
			expect(ignored.message).to.contain("ignored");
			expect(entries.listByDate(annaId, "1970-01-12")).to.deep.equal([]);
		});

		it("rounds with quickPunch when the setting is active", () => {
			settings.set("quick_round_minutes", 15);

			const result = handleCommand(deps(), COMMAND_IDS.quickPunch, true);

			const stored = entries.listByRange(annaId, "1970-01-01", "1970-12-31");
			expect(stored).to.have.lengthOf(1);
			// 1_000_000 seconds = 13.05.1970 14:40 UTC → 15 minutes rounding keeps 14:45
			expect(stored[0].tsUtc % (15 * 60)).to.equal(0);
			expect(result.message).to.contain("punched in");
		});

		it("recalculates a month or a year", () => {
			const month = handleCommand(deps(), COMMAND_IDS.recalc, "1970-01");
			expect(month.message).to.equal("month 1970-01 recalculated");
			expect(aggregation.month(annaId, 1970, 1)).to.not.equal(null);

			const year = handleCommand(deps(), COMMAND_IDS.recalc, "1970");
			expect(year.message).to.equal("year 1970 recalculated");
			expect(aggregation.year(annaId, 1970)).to.not.equal(null);
		});

		it("closes a month", () => {
			const result = handleCommand(deps(), COMMAND_IDS.closeMonth, "1970-01");

			expect(result.ok).to.equal(true);
			expect(result.message).to.contain("month 1970-01 closed for Anna");
			const month = aggregation.month(annaId, 1970, 1);
			expect(month?.targetMin).to.be.greaterThan(0);
		});

		it("validates the period and unknown states", () => {
			expect(() => handleCommand(deps(), COMMAND_IDS.recalc, "01.1970")).to.throw("expected YYYY-MM or YYYY");
			expect(() => handleCommand(deps(), COMMAND_IDS.recalc, "1970-13")).to.throw(
				"month must be between 1 and 12",
			);
			expect(() => handleCommand(deps(), COMMAND_IDS.closeMonth, "1970")).to.throw("needs YYYY-MM");
			expect(() => handleCommand(deps(), "commands.unknown", true)).to.throw("unknown command state");
		});

		it("asks for the target employee when several exist", () => {
			users.create({ login: "bob", displayName: "Bob", roleKeys: ["employee"] });

			expect(() => handleCommand(deps(), COMMAND_IDS.punch, true)).to.throw("several employees exist");

			settings.set("command_punch_user_id", annaId);
			expect(handleCommand(deps(), COMMAND_IDS.punch, true).message).to.contain("Anna");
		});

		it("writes a backup on the button state", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeiterfassung-command-backup-"));
			try {
				const backup = createBackupService({ db, dir, now: () => now });

				expect(handleCommand(deps(), COMMAND_IDS.backup, false).ok).to.equal(false);
				const result = handleCommand({ ...deps(), backup }, COMMAND_IDS.backup, true);
				expect(result.ok).to.equal(true);
				expect(result.message).to.contain("backup zeiterfassung-");
				expect(backup.list()).to.have.lengthOf(1);

				// an instance without the service refuses instead of doing nothing silently
				expect(() => handleCommand(deps(), COMMAND_IDS.backup, true)).to.throw("no backup service");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("presence state", () => {
		/**
		 * Data sources of the presence handler.
		 *
		 * @returns the handler arguments
		 */
		const presenceDeps = (): PresenceDeps => ({ entries, users, aggregation, now: () => now });

		it("recognises its own state id and nothing else", () => {
			expect(parsePresenceStateId(`users.${annaId}.present`)).to.equal(annaId);
			expect(parsePresenceStateId("users.7.hasOpenEntry")).to.equal(null);
			expect(parsePresenceStateId(COMMAND_IDS.punch)).to.equal(null);
		});

		it("understands the values dashboards and scripts write", () => {
			expect(readPresenceValue(true)).to.equal(true);
			expect(readPresenceValue(1)).to.equal(true);
			expect(readPresenceValue("true")).to.equal(true);
			expect(readPresenceValue(false)).to.equal(false);
			expect(readPresenceValue(0)).to.equal(false);
			expect(readPresenceValue("OFF")).to.equal(false);
			expect(readPresenceValue("vielleicht")).to.equal(null);
		});

		it("opens and closes an entry through the state", () => {
			const arrived = handlePresenceState(presenceDeps(), `users.${annaId}.present`, true);

			expect(arrived.ok).to.equal(true);
			expect(arrived.changed).to.equal(true);
			expect(arrived.present).to.equal(true);
			const stored = entries.listByRange(annaId, "1970-01-01", "1970-12-31");
			expect(stored).to.have.lengthOf(1);
			expect(stored[0]).to.include({ source: "api", note: "state.present", direction: "in" });

			// a real day has different instants for coming and going; the repository rounds a punch to the minute,
			// so two writes within the same minute would share a timestamp and the pair would not be counted
			now += 120;
			const left = handlePresenceState(presenceDeps(), `users.${annaId}.present`, false);
			expect(left.changed).to.equal(true);
			// the day state is checked below with the details attached, so a failure names the cause
			expect(entries.listByRange(annaId, "1970-01-01", "1970-12-31")).to.have.lengthOf(2);
			// the write path reports the day as it recalculates it — that is what the state tree publishes
			expect(left.present, "the day of the employee is closed after leaving").to.equal(false);
			expect(entries.listByDate(annaId, left.localDate ?? "")).to.have.lengthOf(2);
		});

		it("writes nothing when the reader fires twice", () => {
			handlePresenceState(presenceDeps(), `users.${annaId}.present`, true);
			const again = handlePresenceState(presenceDeps(), `users.${annaId}.present`, true);

			expect(again.ok).to.equal(true);
			expect(again.changed).to.equal(false);
			expect(again.message).to.contain("already present");
			expect(entries.listByRange(annaId, "1970-01-01", "1970-12-31")).to.have.lengthOf(1);
		});

		it("refuses unknown employees and unusable values", () => {
			const unknown = handlePresenceState(presenceDeps(), "users.999.present", true);
			expect(unknown.ok).to.equal(false);
			expect(unknown.message).to.contain("does not exist");

			const broken = handlePresenceState(presenceDeps(), `users.${annaId}.present`, "vielleicht");
			expect(broken.ok).to.equal(false);
			expect(broken.message).to.contain("write true or false");
			expect(entries.listByRange(annaId, "1970-01-01", "1970-12-31")).to.deep.equal([]);
		});

		it("creates the presence switch as a writable state and publishes it", async () => {
			await createUserChannel(recorder, annaId);
			const common = (recorder.objects.get(`users.${annaId}.present`) as ioBroker.StateObject | undefined)
				?.common;
			expect(common).to.include({ type: "boolean", role: "switch", write: true });
			expect(common?.read ?? true).to.equal(true);

			const snapshot = readUserSnapshot({ aggregation, users, sync, userId: annaId, now });
			expect(snapshot).to.not.equal(null);
			await publishUserSnapshot(recorder, snapshot as NonNullable<typeof snapshot>);
			expect(recorder.values.get(`users.${annaId}.present`)).to.equal(snapshot?.hasOpenEntry);
		});
	});
});
