/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { hashPassword, verifyPassword } from "./auth";
import {
	DEFAULT_ADMIN_LOGIN,
	DEFAULT_TIMEZONE,
	ensureFirstAdministrator,
	generateStartPassword,
} from "./firstAdministrator";

describe("first administrator", () => {
	let db: Db;
	let users: UsersRepository;
	const configured = "Start-2026-klar!";
	const changed = "Gewechselt-2026!";

	/**
	 * Counts the audit rows of one action.
	 *
	 * @param action - action key
	 * @returns number of rows
	 */
	function countAudit(action: string): number {
		return (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?").get(action) as { count: number })
			.count;
	}

	/**
	 * Reads the stored hash of a login.
	 *
	 * @param login - login name
	 * @returns stored hash
	 */
	function hashOf(login: string): string {
		return users.findByLogin(login)?.passwordHash ?? "";
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates the administrator with the configured start password", () => {
		const outcome = ensureFirstAdministrator({
			users,
			login: " chef ",
			password: configured,
			timezone: "Europe/Zurich",
		});

		expect(outcome).to.include({ action: "created", login: "chef", generated: false });
		const user = users.findByLogin("chef");
		expect(user?.displayName).to.equal("chef");
		expect(user?.mustChangePw).to.equal(true);
		expect(user?.timezone).to.equal("Europe/Zurich");
		expect(users.roles(user?.id ?? 0)).to.deep.equal(["admin"]);
		expect(verifyPassword(configured, hashOf("chef"))).to.equal(true);
		expect(countAudit("user.create")).to.equal(1);
	});

	it("falls back to the default login, the default time zone and a generated password", () => {
		const outcome = ensureFirstAdministrator({ users });

		expect(outcome).to.include({ action: "created", login: DEFAULT_ADMIN_LOGIN, generated: true });
		const password = (outcome as { password: string }).password;
		expect(password).to.match(/^Zf-[A-Za-z0-9_-]{12}-7$/);
		expect(verifyPassword(password, hashOf(DEFAULT_ADMIN_LOGIN))).to.equal(true);
		expect(users.findByLogin(DEFAULT_ADMIN_LOGIN)?.timezone).to.equal(DEFAULT_TIMEZONE);
	});

	it("takes the configured start password over while the account still has its start password", () => {
		const created = ensureFirstAdministrator({ users });
		const generated = (created as { password: string }).password;

		const outcome = ensureFirstAdministrator({ users, password: configured });

		expect(outcome).to.include({ action: "start_password_reset", login: DEFAULT_ADMIN_LOGIN });
		expect(verifyPassword(configured, hashOf(DEFAULT_ADMIN_LOGIN))).to.equal(true);
		expect(verifyPassword(generated, hashOf(DEFAULT_ADMIN_LOGIN))).to.equal(false);
		expect(users.findByLogin(DEFAULT_ADMIN_LOGIN)?.mustChangePw).to.equal(true);
		expect(countAudit("user.update")).to.equal(1);
	});

	it("leaves a start password that is already configured alone", () => {
		ensureFirstAdministrator({ users, password: configured });

		const outcome = ensureFirstAdministrator({ users, password: configured });

		expect(outcome).to.include({ action: "start_password_unchanged", login: DEFAULT_ADMIN_LOGIN });
		expect(verifyPassword(configured, hashOf(DEFAULT_ADMIN_LOGIN))).to.equal(true);
		expect(countAudit("user.update")).to.equal(0);
	});

	it("never touches the password once the administrator changed it", () => {
		ensureFirstAdministrator({ users, password: configured });
		const admin = users.findByLogin(DEFAULT_ADMIN_LOGIN);
		users.update({
			id: admin?.id ?? 0,
			patch: { passwordHash: hashPassword(changed), mustChangePw: false },
			actorId: admin?.id ?? 0,
		});

		const outcome = ensureFirstAdministrator({ users, password: configured });

		expect(outcome).to.include({ action: "password_changed", login: DEFAULT_ADMIN_LOGIN });
		expect(verifyPassword(changed, hashOf(DEFAULT_ADMIN_LOGIN))).to.equal(true);
		expect(verifyPassword(configured, hashOf(DEFAULT_ADMIN_LOGIN))).to.equal(false);
		expect(users.findByLogin(DEFAULT_ADMIN_LOGIN)?.mustChangePw).to.equal(false);
	});

	it("stays away from an existing administrator without a configured start password", () => {
		ensureFirstAdministrator({ users, password: configured });

		const outcome = ensureFirstAdministrator({ users });

		expect(outcome).to.include({ action: "existing", login: DEFAULT_ADMIN_LOGIN });
		expect(users.list().length).to.equal(1);
		expect(countAudit("user.update")).to.equal(0);
	});

	it("prefers the administrator the configured login names", () => {
		const oldest = users.create({
			login: "erster",
			displayName: "Erster",
			passwordHash: hashPassword(changed),
			mustChangePw: true,
			roleKeys: ["admin"],
		});
		users.create({
			login: "admin",
			displayName: "Admin",
			passwordHash: hashPassword(changed),
			mustChangePw: true,
			roleKeys: ["admin"],
		});

		const outcome = ensureFirstAdministrator({ users, login: "admin", password: configured });

		expect(outcome).to.include({ action: "start_password_reset", login: "admin" });
		expect(verifyPassword(configured, hashOf("admin"))).to.equal(true);
		expect(verifyPassword(changed, hashOf("erster"))).to.equal(true);
		expect(verifyPassword(configured, users.findById(oldest.id)?.passwordHash ?? "")).to.equal(false);
	});

	it("falls back to the oldest administrator when the configured login is nobody's", () => {
		const oldest = users.create({
			login: "erster",
			displayName: "Erster",
			passwordHash: hashPassword(changed),
			mustChangePw: true,
			roleKeys: ["admin"],
		});
		users.create({
			login: "zweiter",
			displayName: "Zweiter",
			passwordHash: hashPassword(changed),
			mustChangePw: true,
			roleKeys: ["admin"],
		});

		const outcome = ensureFirstAdministrator({ users, login: "chef", password: configured });

		expect(outcome).to.include({ action: "start_password_reset", login: "erster" });
		expect(verifyPassword(configured, users.findById(oldest.id)?.passwordHash ?? "")).to.equal(true);
	});

	it("reports a login that is already taken by a deactivated account", () => {
		const other = users.create({ login: DEFAULT_ADMIN_LOGIN, displayName: "Alt", roleKeys: ["employee"] });
		users.update({ id: other.id, patch: { isActive: false }, actorId: other.id });

		const outcome = ensureFirstAdministrator({ users, password: configured });

		expect(outcome.action).to.equal("failed");
		expect((outcome as { reason: string }).reason).to.include("already exists");
	});

	it("generates a password that satisfies the password policy", () => {
		const password = generateStartPassword();

		expect(password).to.match(/^Zf-[A-Za-z0-9_-]{12}-7$/);
		expect(password).to.have.lengthOf(17);
	});
});
