/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository, type AbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService, type AggregationService } from "../services/aggregation";
import { createBackupService, type BackupService } from "../services/backup";
import { createSyncService, type SyncService } from "../services/sync";
import { handleMessage, type MessageDeps } from "./messages";

describe("adapter messages", () => {
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let absences: AbsencesRepository;
	let settings: SettingsRepository;
	let aggregation: AggregationService;
	let sync: SyncService;
	let backup: BackupService;
	let deps: MessageDeps;
	let annaId: number;
	let clock: number;

	beforeEach(() => {
		clock = Date.UTC(2026, 8, 18, 6, 30) / 1000;
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		absences = createAbsencesRepository(db);
		const holidays = createHolidaysRepository(db);
		const rules = createRulesRepository(db);
		settings = createSettingsRepository(db);
		users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] });
		annaId = users.create({ login: "anna", displayName: "Anna Weber", roleKeys: ["employee"] }).id;
		aggregation = createAggregationService({ db, users, entries, absences, holidays, rules, settings });
		sync = createSyncService({ db, entries, users, aggregation });
		backup = createBackupService({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), "zt-msg-")), now: () => clock });
		deps = { users, entries, absences, settings, aggregation, sync, backup, version: "9.9.9", now: () => clock };
	});

	afterEach(() => {
		db.close();
	});

	const failure = async (command: string, payload: unknown): Promise<string> =>
		handleMessage(deps, command, payload).then(
			() => "",
			(error: Error) => error.message,
		);

	it("punches for an employee named by login or id", async () => {
		const first = await handleMessage(deps, "punch", { user: "anna" });
		expect(first.ok).to.equal(true);
		expect(first.data).to.deep.include({ userId: annaId });
		const stored = entries.listByDate(annaId, "2026-09-18");
		expect(stored).to.have.length(1);
		expect(stored[0]).to.deep.include({ direction: "in", source: "api", note: "sendTo.punch" });

		const second = await handleMessage(deps, "punch", { user: annaId, note: "vom Skript" });
		expect(entries.listByDate(annaId, "2026-09-18")).to.have.length(2);
		expect(second.message).to.contain("Anna Weber");

		expect(await failure("punch", { user: "niemand" })).to.match(/no employee/);
		expect(await failure("punch", {})).to.match(/user is required/);
	});

	it("sets the presence and answers whether it changed", async () => {
		const opened = await handleMessage(deps, "present", { user: "anna", present: true });
		expect(opened.data).to.deep.include({ userId: annaId, present: true, changed: true });

		// the same write again changes nothing: a reader that fires twice is harmless
		const again = await handleMessage(deps, "present", { user: "anna", present: true });
		expect(again.data).to.deep.include({ present: true, changed: false });

		// two minutes later: with the same instant the out-punch would not pair with the in-punch
		clock += 120;
		const closed = await handleMessage(deps, "present", { user: "anna", present: false });
		expect(closed.data).to.deep.include({ present: false, changed: true });
		expect(await failure("present", { user: "anna" })).to.match(/present is required/);
	});

	it("answers the figures of an employee", async () => {
		await handleMessage(deps, "punch", { user: "anna" });
		const status = await handleMessage(deps, "status", { user: "Anna Weber" });
		expect(status.data).to.deep.include({ userId: annaId, displayName: "Anna Weber", hasOpenEntry: true });
		expect(status.data).to.have.property("workedMinutes");
		expect(status.data).to.have.property("monthWorkedMinutes");
		expect(status.data).to.have.property("yearBalanceMinutes");
	});

	it("builds a monthly statement as base64", async () => {
		await handleMessage(deps, "punch", { user: "anna" });
		const base64Of = (data: Record<string, unknown> | undefined): string =>
			typeof data?.base64 === "string" ? data.base64 : "";

		const pdf = await handleMessage(deps, "report", { user: "anna", period: "2026-09" });
		expect(pdf.data).to.deep.include({ fileName: "time-tracker-anna-2026-09.pdf", mimeType: "application/pdf" });
		const bytes = Buffer.from(base64Of(pdf.data), "base64");
		expect(bytes.subarray(0, 4).toString("latin1")).to.equal("%PDF");

		const xls = await handleMessage(deps, "report", { user: "anna", period: "2026-09", format: "xlsx" });
		expect(xls.data).to.deep.include({ fileName: "time-tracker-anna-2026-09.xlsx" });
		expect(Buffer.from(base64Of(xls.data), "base64").length).to.be.greaterThan(0);

		expect(await failure("report", { user: "anna", period: "September" })).to.match(/YYYY-MM/);
		expect(await failure("report", { user: "anna", format: "docx" })).to.match(/pdf or xlsx/);
	});

	it("writes a backup, refuses an unknown command and reports a missing backup service", async () => {
		const created = await handleMessage(deps, "backup", {});
		expect(created.ok).to.equal(true);
		const name = typeof created.data?.name === "string" ? created.data.name : "";
		expect(name).to.contain("time-tracker-");

		const withoutBackup = await handleMessage({ ...deps, backup: undefined }, "backup", {}).then(
			() => "",
			(error: Error) => error.message,
		);
		expect(withoutBackup).to.match(/no backup service/);
		expect(await failure("quatsch", {})).to.match(/unknown command/);
	});
});
