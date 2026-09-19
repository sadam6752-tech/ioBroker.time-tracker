/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository } from "./users";
import {
	createAutomationsRepository,
	maskToWeekdays,
	weekdaysToMask,
	type AutomationKind,
	type AutomationsRepository,
} from "./automations";

describe("automations repository", () => {
	let db: Db;
	let repo: AutomationsRepository;
	let annaId: number;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		const users = createUsersRepository(db);
		repo = createAutomationsRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	it("stores a clock out rule and audits it", () => {
		const rule = repo.save({
			kind: "clockOut",
			atMinute: 20 * 60,
			label: "Feierabend",
			actorId: adminId,
			now: 1000,
		});
		expect(rule).to.deep.include({
			kind: "clockOut",
			atMinute: 1200,
			afterMinutes: null,
			userId: null,
			isActive: true,
		});
		expect(repo.list()).to.have.length(1);
		const audit = db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get() as { action: string };
		expect(audit.action).to.equal("automation_rule.create");
	});

	it("keeps the window of a rule valid", () => {
		expect(() => repo.save({ kind: "clockOut", actorId: adminId })).to.throw("atMinute");
		expect(() => repo.save({ kind: "breakReminder", actorId: adminId })).to.throw("afterMinutes");
		expect(() =>
			repo.save({ kind: "quatsch" as unknown as AutomationKind, atMinute: 600, actorId: adminId }),
		).to.throw("kind must be");
		expect(() => repo.save({ kind: "clockOut", atMinute: 1500, actorId: adminId })).to.throw("between 0 and 1439");

		// the reminder has no fixed time, a timed rule has no length
		const reminder = repo.save({ kind: "breakReminder", afterMinutes: 360, actorId: adminId });
		expect(reminder).to.deep.include({ atMinute: null, afterMinutes: 360 });
		expect(repo.list()).to.have.length(1);
	});

	it("asks before a rule runs twice on the same day", () => {
		const rule = repo.save({ kind: "clockOut", atMinute: 1200, actorId: adminId });
		expect(repo.hasRun({ ruleId: rule.id, userId: annaId, period: "2026-09-18" })).to.equal(false);
		expect(
			repo.recordRun({
				ruleId: rule.id,
				userId: annaId,
				period: "2026-09-18",
				action: "clocked out",
				now: 5000,
			}),
		).to.equal(true);
		// the second call changes nothing: a punch is never written twice
		expect(
			repo.recordRun({ ruleId: rule.id, userId: annaId, period: "2026-09-18", action: "clocked out" }),
		).to.equal(false);
		expect(repo.hasRun({ ruleId: rule.id, userId: annaId, period: "2026-09-18" })).to.equal(true);

		// another day is another run
		expect(
			repo.recordRun({ ruleId: rule.id, userId: annaId, period: "2026-09-19", action: "clocked out" }),
		).to.equal(true);
		expect(repo.runs({ ruleId: rule.id })).to.have.length(2);
		expect(repo.runs({ ruleId: rule.id, period: "2026-09-18" })[0]).to.deep.include({
			userId: annaId,
			action: "clocked out",
		});
	});

	it("updates only what changed and deletes the runs with the rule", () => {
		const rule = repo.save({ kind: "missingPunch", atMinute: 1320, actorId: adminId });
		const same = repo.save({ id: rule.id, kind: "missingPunch", atMinute: 1320, actorId: adminId });
		expect(same.id).to.equal(rule.id);
		expect(repo.list({ includeInactive: true })).to.have.length(1);

		repo.recordRun({ ruleId: rule.id, userId: annaId, period: "2026-09-18", action: "warned" });
		expect(repo.remove({ id: rule.id, actorId: adminId })).to.equal(true);
		expect(repo.list({ includeInactive: true })).to.be.empty;
		expect(repo.runs({ ruleId: rule.id })).to.be.empty;
	});
});

describe("weekdays and repeat of an automation rule", () => {
	let db: Db;
	let repo: AutomationsRepository;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		repo = createAutomationsRepository(db);
		adminId = createUsersRepository(db).create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	it("keeps the days of the week and the repeat", () => {
		const rule = repo.save({
			kind: "clockOut",
			atMinute: 20 * 60,
			weekdays: [1, 2, 3, 4, 5],
			repeat: "week",
			actorId: adminId,
		});
		expect(rule.weekdays).to.deep.equal([1, 2, 3, 4, 5]);
		expect(rule.repeat).to.equal("week");
		// reading it back gives the same selection
		expect(repo.findById(rule.id)).to.deep.include({ weekdays: [1, 2, 3, 4, 5], repeat: "week" });

		// a change of the days only is a change
		const changed = repo.save({
			id: rule.id,
			kind: "clockOut",
			atMinute: 20 * 60,
			weekdays: [6, 7],
			actorId: adminId,
		});
		expect(changed.weekdays).to.deep.equal([6, 7]);
		expect(changed.repeat).to.equal("week");
	});

	it("runs every day once a day when nothing is chosen", () => {
		const rule = repo.save({ kind: "clockOut", atMinute: 20 * 60, actorId: adminId });
		expect(rule.weekdays).to.deep.equal([1, 2, 3, 4, 5, 6, 7]);
		expect(rule.repeat).to.equal("day");
	});

	it("refuses a day that does not exist and an unknown repeat", () => {
		expect(() => repo.save({ kind: "clockOut", atMinute: 1200, weekdays: [0], actorId: adminId })).to.throw(/1..7/);
		expect(() => repo.save({ kind: "clockOut", atMinute: 1200, weekdays: [], actorId: adminId })).to.throw(
			/at least one day/,
		);
		expect(() =>
			repo.save({
				kind: "clockOut",
				atMinute: 1200,
				repeat: "month" as unknown as "day",
				actorId: adminId,
			}),
		).to.throw(/day.*week/);
	});

	it("keeps one run per period, so a weekly rule can run again next week", () => {
		const rule = repo.save({ kind: "clockOut", atMinute: 1200, repeat: "week", actorId: adminId });
		expect(
			repo.recordRun({ ruleId: rule.id, userId: adminId, period: "2026-W38", action: "clocked out" }),
		).to.equal(true);
		// the same week is a second call, the week after is not
		expect(
			repo.recordRun({ ruleId: rule.id, userId: adminId, period: "2026-W38", action: "clocked out" }),
		).to.equal(false);
		expect(repo.hasRun({ ruleId: rule.id, userId: adminId, period: "2026-W38" })).to.equal(true);
		expect(repo.hasRun({ ruleId: rule.id, userId: adminId, period: "2026-W39" })).to.equal(false);
		expect(
			repo.recordRun({ ruleId: rule.id, userId: adminId, period: "2026-W39", action: "clocked out" }),
		).to.equal(true);
	});

	it("turns the stored mask into days and back", () => {
		expect(maskToWeekdays(127)).to.deep.equal([1, 2, 3, 4, 5, 6, 7]);
		expect(maskToWeekdays(weekdaysToMask([1, 3, 5]))).to.deep.equal([1, 3, 5]);
		// an empty mask means every day, so a rule can never fall silent by accident
		expect(maskToWeekdays(0)).to.deep.equal([1, 2, 3, 4, 5, 6, 7]);
	});
});

describe("the kind clockIn in the repository", () => {
	let db: Db;
	let repo: AutomationsRepository;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		repo = createAutomationsRepository(db);
		adminId = createUsersRepository(db).create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	it("accepts the kind and keeps it", () => {
		const rule = repo.save({ kind: "clockIn", atMinute: 8 * 60, label: "Arbeitsbeginn", actorId: adminId });
		expect(rule).to.deep.include({ kind: "clockIn", atMinute: 480, afterMinutes: null });
		expect(repo.findById(rule.id)?.kind).to.equal("clockIn");

		// the other kinds still work, and a wrong one is refused
		expect(repo.save({ kind: "clockOut", atMinute: 1200, actorId: adminId }).kind).to.equal("clockOut");
		expect(() => repo.save({ kind: "quatsch" as unknown as "clockIn", atMinute: 1200, actorId: adminId })).to.throw(
			/kind must be one of/,
		);
	});

	it("takes the runs of a deleted rule with it", () => {
		const rule = repo.save({ kind: "clockIn", atMinute: 480, actorId: adminId });
		repo.recordRun({ ruleId: rule.id, userId: adminId, period: "2026-09-18", action: "clocked in" });
		expect(repo.runs({ limit: 10 })).to.have.length(1);
		repo.remove({ id: rule.id, actorId: adminId });
		expect(repo.runs({ limit: 10 })).to.be.empty;
	});
});
