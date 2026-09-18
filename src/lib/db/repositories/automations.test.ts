/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository } from "./users";
import { createAutomationsRepository, type AutomationKind, type AutomationsRepository } from "./automations";

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
		expect(repo.hasRun({ ruleId: rule.id, userId: annaId, localDate: "2026-09-18" })).to.equal(false);
		expect(
			repo.recordRun({
				ruleId: rule.id,
				userId: annaId,
				localDate: "2026-09-18",
				action: "clocked out",
				now: 5000,
			}),
		).to.equal(true);
		// the second call changes nothing: a punch is never written twice
		expect(
			repo.recordRun({ ruleId: rule.id, userId: annaId, localDate: "2026-09-18", action: "clocked out" }),
		).to.equal(false);
		expect(repo.hasRun({ ruleId: rule.id, userId: annaId, localDate: "2026-09-18" })).to.equal(true);

		// another day is another run
		expect(
			repo.recordRun({ ruleId: rule.id, userId: annaId, localDate: "2026-09-19", action: "clocked out" }),
		).to.equal(true);
		expect(repo.runs({ ruleId: rule.id })).to.have.length(2);
		expect(repo.runs({ ruleId: rule.id, localDate: "2026-09-18" })[0]).to.deep.include({
			userId: annaId,
			action: "clocked out",
		});
	});

	it("updates only what changed and deletes the runs with the rule", () => {
		const rule = repo.save({ kind: "missingPunch", atMinute: 1320, actorId: adminId });
		const same = repo.save({ id: rule.id, kind: "missingPunch", atMinute: 1320, actorId: adminId });
		expect(same.id).to.equal(rule.id);
		expect(repo.list({ includeInactive: true })).to.have.length(1);

		repo.recordRun({ ruleId: rule.id, userId: annaId, localDate: "2026-09-18", action: "warned" });
		expect(repo.remove({ id: rule.id, actorId: adminId })).to.equal(true);
		expect(repo.list({ includeInactive: true })).to.be.empty;
		expect(repo.runs({ ruleId: rule.id })).to.be.empty;
	});
});
