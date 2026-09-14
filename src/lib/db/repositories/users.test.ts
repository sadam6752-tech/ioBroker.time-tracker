/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository, diffFields, LoginExistsError, UnknownRoleError, type UsersRepository } from "./users";
import type { OvertimeModel } from "../../domain/calculation";

describe("users repository", () => {
	let db: Db;
	let repo: UsersRepository;

	/**
	 * Counts the audit rows of one action.
	 *
	 * @param action - action key, e.g. `user.update`
	 * @returns number of rows
	 */
	function countAudit(action: string): number {
		const row = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?").get(action) as {
			count: number;
		};
		return row.count;
	}

	/**
	 * Reads the newest audit row of one action.
	 *
	 * @param action - action key
	 * @returns detail object of the row
	 */
	function lastDetail(action: string): Record<string, unknown> {
		const row = db.prepare("SELECT detail FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1").get(action) as
			{ detail: string } | undefined;
		if (!row) {
			throw new Error(`no audit row for ${action}`);
		}
		return JSON.parse(row.detail) as Record<string, unknown>;
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		repo = createUsersRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("create", () => {
		it("creates a user with a default work profile and audits it", () => {
			const user = repo.create({
				login: "anna",
				displayName: "Anna Muster",
				email: "anna@example.org",
				roleKeys: ["employee"],
				now: 1000,
			});

			expect(user.id).to.be.greaterThan(0);
			expect(user.login).to.equal("anna");
			expect(user.locale).to.equal("de-DE");
			expect(user.timezone).to.equal("Europe/Zurich");
			expect(user.isActive).to.equal(true);
			expect(user.mustChangePw).to.equal(false);
			expect(user.createdAt).to.equal(1000);
			expect(user.updatedAt).to.equal(1000);
			expect(user.lastLoginAt).to.equal(null);

			const profile = repo.getWorkProfile(user.id);
			expect(profile).to.not.equal(null);
			expect(profile?.percent).to.equal(100);
			expect(profile?.weeklyHours).to.equal(42.5);
			expect(profile?.workdays).to.equal("0;1;1;1;1;1;0");
			expect(profile?.overtimeModel).to.equal("monthly");
			expect(profile?.vacationPerYear).to.equal(0);

			expect(repo.roles(user.id)).to.deep.equal(["employee"]);
			expect(countAudit("user.create")).to.equal(1);
			expect(lastDetail("user.create")).to.deep.equal({
				login: "anna",
				displayName: "Anna Muster",
				roles: ["employee"],
			});
		});

		it("trims the login and rejects duplicates regardless of case", () => {
			repo.create({ login: "  anna  ", displayName: "Anna" });

			expect(repo.findByLogin("anna")?.login).to.equal("anna");
			expect(repo.findByLogin("ANNA")?.displayName).to.equal("Anna");

			expect(() => repo.create({ login: "ANNA", displayName: "Other" })).to.throw(LoginExistsError);
			expect(repo.list()).to.have.lengthOf(1);
		});

		it("rejects an empty login", () => {
			expect(() => repo.create({ login: "   ", displayName: "Nobody" })).to.throw("login must not be empty");
		});

		it("rejects unknown roles without creating the user", () => {
			expect(() => repo.create({ login: "bob", displayName: "Bob", roleKeys: ["boss"] })).to.throw(
				UnknownRoleError,
			);
			expect(repo.list({ includeInactive: true })).to.deep.equal([]);
			expect(countAudit("user.create")).to.equal(0);
		});
	});

	describe("roles and permissions", () => {
		it("resolves the effective permissions of a role", () => {
			const admin = repo.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] });
			const employee = repo.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] });

			expect(repo.permissions(admin.id)).to.have.lengthOf(33);
			expect(repo.permissions(employee.id)).to.deep.equal([
				"absence.request",
				"report.view_own",
				"time.edit_own",
				"time.punch",
			]);
			expect(repo.hasPermissions(employee.id, ["time.punch", "time.edit_own"])).to.equal(true);
			expect(repo.hasPermissions(employee.id, ["user.create"])).to.equal(false);
			expect(repo.hasPermissions(admin.id, ["user.create", "settings.edit"])).to.equal(true);
			expect(repo.hasPermissions(employee.id, [])).to.equal(true);
		});

		it("replaces the roles and audits the difference", () => {
			const user = repo.create({
				login: "anna",
				displayName: "Anna",
				roleKeys: ["employee", "manager"],
				now: 1000,
			});
			expect(repo.roles(user.id)).to.deep.equal(["employee", "manager"]);

			const after = repo.setRoles({
				userId: user.id,
				roleKeys: ["manager", "admin"],
				actorId: user.id,
				now: 2000,
			});

			expect(after).to.deep.equal(["admin", "manager"]);
			expect(repo.roles(user.id)).to.deep.equal(["admin", "manager"]);
			expect(lastDetail("user.roles")).to.deep.equal({ old: ["employee", "manager"], new: ["admin", "manager"] });
		});

		it("keeps the roles when an unknown key is passed", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] });

			expect(() => repo.setRoles({ userId: user.id, roleKeys: ["nope"], actorId: user.id })).to.throw(
				UnknownRoleError,
			);
			expect(repo.roles(user.id)).to.deep.equal(["employee"]);
		});
	});

	describe("update", () => {
		it("changes the profile data and audits the changed fields", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", now: 1000 });

			const updated = repo.update({
				id: user.id,
				patch: { displayName: "Anna Muster", email: "anna@example.org" },
				reason: "marriage",
				actorId: user.id,
				now: 2000,
			});

			expect(updated.displayName).to.equal("Anna Muster");
			expect(updated.email).to.equal("anna@example.org");
			expect(updated.updatedAt).to.equal(2000);
			expect(countAudit("user.update")).to.equal(1);
			const detail = lastDetail("user.update");
			expect(detail.reason).to.equal("marriage");
			expect(detail.passwordChanged).to.equal(false);
			expect(Object.keys(detail.changes as Record<string, unknown>).sort()).to.deep.equal([
				"displayName",
				"email",
			]);
		});

		it("does nothing when no value changes", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", now: 1000 });

			const unchanged = repo.update({
				id: user.id,
				patch: { displayName: "Anna", email: null },
				actorId: user.id,
				now: 2000,
			});

			expect(unchanged.updatedAt).to.equal(1000);
			expect(countAudit("user.update")).to.equal(0);
		});

		it("never writes the password hash into the audit trail", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", passwordHash: "old-hash", now: 1000 });

			const updated = repo.update({
				id: user.id,
				patch: { passwordHash: "new-hash", mustChangePw: true },
				actorId: user.id,
				now: 2000,
			});

			expect(updated.passwordHash).to.equal("new-hash");
			expect(updated.mustChangePw).to.equal(true);
			const detail = lastDetail("user.update");
			expect(detail.passwordChanged).to.equal(true);
			expect(JSON.stringify(detail)).to.not.contain("new-hash");
			expect(JSON.stringify(detail)).to.not.contain("old-hash");
		});

		it("reports deactivation and activation with dedicated actions", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", now: 1000 });

			const inactive = repo.update({ id: user.id, patch: { isActive: false }, actorId: user.id, now: 2000 });
			expect(inactive.isActive).to.equal(false);
			expect(countAudit("user.deactivate")).to.equal(1);
			expect(lastDetail("user.deactivate").changes).to.deep.equal({ isActive: { old: true, new: false } });

			expect(repo.list()).to.deep.equal([]);
			expect(repo.list({ includeInactive: true })).to.have.lengthOf(1);

			const active = repo.update({ id: user.id, patch: { isActive: true }, actorId: user.id, now: 3000 });
			expect(active.isActive).to.equal(true);
			expect(countAudit("user.activate")).to.equal(1);
			expect(repo.list()).to.have.lengthOf(1);
		});

		it("throws for an unknown user", () => {
			expect(() => repo.update({ id: 999, patch: { displayName: "Ghost" }, actorId: 1 })).to.throw(
				"user 999 not found",
			);
		});
	});

	describe("listing and login", () => {
		it("sorts the list by display name and hides inactive users", () => {
			repo.create({ login: "zoe", displayName: "Zoe" });
			repo.create({ login: "anna", displayName: "anna" });
			const gone = repo.create({ login: "old", displayName: "Aaron" });
			repo.update({ id: gone.id, patch: { isActive: false }, actorId: gone.id });

			expect(repo.list().map(user => user.displayName)).to.deep.equal(["anna", "Zoe"]);
			// case insensitive order: "Aaron" sorts before "anna" (binary collation would put it after "Zoe")
			expect(repo.list({ includeInactive: true }).map(user => user.displayName)).to.deep.equal([
				"Aaron",
				"anna",
				"Zoe",
			]);
		});

		it("stores the instant of the last login", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", now: 1000 });
			repo.recordLogin(user.id, 5000);

			expect(repo.findById(user.id)?.lastLoginAt).to.equal(5000);
		});

		it("returns empty results for unknown users", () => {
			expect(repo.findById(999)).to.equal(null);
			expect(repo.findByLogin("nobody")).to.equal(null);
			expect(repo.getWorkProfile(999)).to.equal(null);
			expect(repo.roles(999)).to.deep.equal([]);
			expect(repo.permissions(999)).to.deep.equal([]);
		});
	});

	describe("work profile", () => {
		it("creates the profile when none exists and audits the creation", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", now: 1000 });
			db.prepare("DELETE FROM work_profiles WHERE user_id = ?").run(user.id);

			const profile = repo.saveWorkProfile({
				userId: user.id,
				profile: { percent: 80, weeklyHours: 40, vacationPerYear: 25, overtimeModel: "yearly" },
				actorId: user.id,
				now: 2000,
			});

			expect(profile.percent).to.equal(80);
			expect(profile.vacationPerYear).to.equal(25);
			expect(profile.overtimeModel).to.equal("yearly");
			const detail = lastDetail("user.profile");
			expect(detail.created).to.equal(true);
			expect(Object.keys(detail.changes as Record<string, unknown>).sort()).to.deep.equal([
				"overtimeModel",
				"percent",
				"vacationPerYear",
				"weeklyHours",
			]);
		});

		it("updates only the given fields and skips unchanged writes", () => {
			const user = repo.create({ login: "anna", displayName: "Anna", now: 1000 });

			const profile = repo.saveWorkProfile({
				userId: user.id,
				profile: { percent: 60, overtimeCarryover: 1440, workdays: "0;0;1;1;1;1;0" },
				actorId: user.id,
				now: 2000,
			});

			expect(profile.percent).to.equal(60);
			expect(profile.overtimeCarryover).to.equal(1440);
			// untouched values keep their default
			expect(profile.weeklyHours).to.equal(42.5);
			expect(countAudit("user.profile")).to.equal(1);
			expect(lastDetail("user.profile").changes).to.deep.equal({
				percent: { old: 100, new: 60 },
				workdays: { old: "0;1;1;1;1;1;0", new: "0;0;1;1;1;1;0" },
				overtimeCarryover: { old: 0, new: 1440 },
			});

			const again = repo.saveWorkProfile({
				userId: user.id,
				profile: { percent: 60, workdays: "0;0;1;1;1;1;0" },
				actorId: user.id,
				now: 3000,
			});
			expect(again.percent).to.equal(60);
			// no second audit entry for an unchanged profile
			expect(countAudit("user.profile")).to.equal(1);
		});

		it("rejects an invalid overtime model", () => {
			const user = repo.create({ login: "anna", displayName: "Anna" });

			expect(() =>
				repo.saveWorkProfile({
					userId: user.id,
					profile: { overtimeModel: "weekly" as unknown as OvertimeModel },
					actorId: user.id,
				}),
			).to.throw();
			// the profile is unchanged
			expect(repo.getWorkProfile(user.id)?.overtimeModel).to.equal("monthly");
			expect(countAudit("user.profile")).to.equal(0);
		});
	});

	describe("diffFields", () => {
		it("compares typed records field by field", () => {
			expect(diffFields({ a: 1, b: "x" }, { a: 1, b: "y" }, ["a", "b"])).to.deep.equal({
				b: { old: "x", new: "y" },
			});
			expect(diffFields({ a: 1 }, { a: 1 }, ["a"])).to.deep.equal({});
			// null and undefined are different values
			expect(
				diffFields({ a: null as string | null | undefined }, { a: undefined as string | null | undefined }, [
					"a",
				]),
			).to.deep.equal({ a: { old: null, new: undefined } });
		});
	});
});
