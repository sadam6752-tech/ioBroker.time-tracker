/// <reference types="mocha" />
import { createHash } from "node:crypto";
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createSettingsRepository, type SettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { checkPasswordPolicy, createAuthService, hashPassword, verifyPassword, type AuthService } from "./auth";

const SECRET = "unit-test-secret";

describe("auth service", () => {
	let db: Db;
	let users: UsersRepository;
	let settings: SettingsRepository;
	let service: AuthService;
	let annaId: number;
	let adminId: number;
	const password = "Zeit-2026-klar";

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
		users = createUsersRepository(db);
		settings = createSettingsRepository(db);
		service = createAuthService({ db, users, settings, secret: SECRET, maxFailedAttempts: 3, lockoutMinutes: 15 });

		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		service.setPassword({ userId: annaId, password, actorId: adminId, now: 1000 });
		service.setPassword({ userId: adminId, password, actorId: adminId, now: 1000 });
	});

	afterEach(() => {
		db.close();
	});

	describe("password hashing", () => {
		it("hashes with a random salt and verifies", () => {
			const first = hashPassword(password, { cost: 1024 });
			const second = hashPassword(password, { cost: 1024 });

			expect(first).to.not.equal(second);
			expect(first.startsWith("scrypt$1024$8$1$64$")).to.equal(true);
			expect(verifyPassword(password, first)).to.equal(true);
			expect(verifyPassword(password, second)).to.equal(true);
			expect(verifyPassword("wrong", first)).to.equal(false);
		});

		it("never matches malformed or foreign hashes", () => {
			expect(verifyPassword(password, "")).to.equal(false);
			expect(verifyPassword(password, "plain-text")).to.equal(false);
			expect(verifyPassword(password, "$5$rounds=5000$salt$hash")).to.equal(false);
			expect(verifyPassword(password, hashPassword(password, { cost: 1024 }).replace(/\$64\$/, "$32$"))).to.equal(
				false,
			);
		});

		it("checks the password policy", () => {
			expect(checkPasswordPolicy("kurz1")).to.equal("too_short");
			expect(checkPasswordPolicy("nurBuchstaben")).to.equal("no_digit");
			expect(checkPasswordPolicy("1234567890")).to.equal("no_letter");
			expect(checkPasswordPolicy("Zeit-2026-klar")).to.equal(null);
			expect(checkPasswordPolicy("kurz1", { minLength: 4 })).to.equal(null);
		});
	});

	describe("login", () => {
		it("opens a session and stores only the hash of the token", () => {
			const result = service.login({
				login: "anna",
				password,
				userAgent: "Mozilla/5.0 test",
				ip: "10.0.0.4",
				now: 2000,
			});

			expect(result.ok).to.equal(true);
			if (!result.ok) {
				return;
			}
			expect(result.token.length).to.be.greaterThan(20);
			expect(result.csrfToken).to.equal(service.csrfToken(result.token));
			// default lifetime: 720 minutes
			expect(result.expiresAt).to.equal(2000 + 720 * 60);
			expect(result.user).to.deep.equal({
				id: annaId,
				login: "anna",
				displayName: "Anna",
				locale: "de-DE",
				timezone: "Europe/Zurich",
				mustChangePw: false,
			});
			expect(JSON.stringify(result.user)).to.not.contain("scrypt");

			const row = db.prepare("SELECT id, user_id AS userId, user_agent AS userAgent, ip FROM sessions").get() as {
				id: string;
				userId: number;
				userAgent: string;
				ip: string;
			};
			expect(row.id).to.equal(createHash("sha256").update(result.token).digest("hex"));
			expect(row.userId).to.equal(annaId);
			expect(row.userAgent).to.equal("Mozilla/5.0 test");
			expect(row.ip).to.equal("10.0.0.4");
			expect(users.findById(annaId)?.lastLoginAt).to.equal(2000);
			expect(countAudit("auth.login")).to.equal(1);
			expect(service.sessions(annaId, 2000)).to.have.lengthOf(1);
		});

		it("uses the configured session lifetime", () => {
			settings.set("session_ttl_minutes", 30);

			const result = service.login({ login: "anna", password, now: 2000 });

			expect(result.ok && result.expiresAt).to.equal(2000 + 30 * 60);
		});

		it("rejects wrong passwords, unknown users and inactive accounts with the same error", () => {
			const wrong = service.login({ login: "anna", password: "falsch-1234", ip: "10.0.0.5", now: 2000 });
			const unknown = service.login({ login: "niemand", password, now: 2000 });

			expect(wrong).to.deep.equal({ ok: false, error: "invalid_credentials" });
			expect(unknown).to.deep.equal({ ok: false, error: "invalid_credentials" });
			// the internal reason is audited, the password never is
			const rows = db
				.prepare("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id")
				.all() as { detail: string }[];
			expect(rows.map(row => JSON.parse(row.detail).reason)).to.deep.equal(["wrong_password", "unknown_user"]);
			expect(rows.every(row => !row.detail.includes("falsch-1234"))).to.equal(true);

			users.update({ id: annaId, patch: { isActive: false }, actorId: adminId });
			expect(service.login({ login: "anna", password, now: 2000 })).to.deep.equal({
				ok: false,
				error: "invalid_credentials",
			});
			expect(lastDetail("auth.login_failed").reason).to.equal("inactive_user");
		});

		it("never accepts the legacy hash as a credential", () => {
			const legacyId = users.create({
				login: "legacy",
				displayName: "Legacy",
				legacySha1: "5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8",
			}).id;

			const result = service.login({ login: "legacy", password: "password", now: 2000 });

			expect(result).to.deep.equal({ ok: false, error: "invalid_credentials" });
			expect(lastDetail("auth.login_failed").reason).to.equal("no_password");
			expect(service.sessions(legacyId, 2000)).to.deep.equal([]);
		});

		it("locks a login after repeated failures and releases it after the window", () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				expect(service.login({ login: "anna", password: "falsch-1234", now: 2000 }).ok).to.equal(false);
			}

			const locked = service.login({ login: "anna", password, now: 2000 });
			expect(locked).to.deep.equal({ ok: false, error: "locked_out" });
			expect(countAudit("auth.login_locked")).to.equal(1);
			expect(lastDetail("auth.login_locked").login).to.equal("anna");

			// after the lock window the login works again
			expect(service.login({ login: "anna", password, now: 2000 + 15 * 60 + 1 }).ok).to.equal(true);
		});

		it("resets the failure counter on a successful login", () => {
			service.login({ login: "anna", password: "falsch-1234", now: 2000 });
			service.login({ login: "anna", password: "falsch-1234", now: 2000 });
			expect(service.login({ login: "anna", password, now: 2000 }).ok).to.equal(true);

			service.login({ login: "anna", password: "falsch-1234", now: 2001 });
			service.login({ login: "anna", password: "falsch-1234", now: 2001 });
			// two failures after the reset are not enough for a lock
			expect(service.login({ login: "anna", password, now: 2001 }).ok).to.equal(true);
		});
	});

	describe("sessions", () => {
		/**
		 * Logs in and returns the token.
		 *
		 * @param login - login name
		 * @param now - instant of the login
		 * @returns session token
		 */
		function tokenFor(login: string, now: number): string {
			const result = service.login({ login, password, now });
			if (!result.ok) {
				throw new Error(`login failed for ${login}`);
			}
			return result.token;
		}

		it("authenticates a valid session and checks permissions", () => {
			const employee = tokenFor("anna", 2000);
			const admin = tokenFor("admin", 2000);

			const allowed = service.authenticate({ token: employee, permission: "time.punch", now: 2000 });
			expect(allowed.ok).to.equal(true);
			if (allowed.ok) {
				expect(allowed.context.user.login).to.equal("anna");
				expect(allowed.context.permissions).to.deep.equal([
					"absence.request",
					"report.view_own",
					"time.edit_own",
					"time.punch",
				]);
			}

			expect(service.authenticate({ token: employee, permission: "user.create", now: 2000 })).to.deep.equal({
				ok: false,
				error: "permission_denied",
			});
			expect(service.authenticate({ token: admin, permission: "user.create", now: 2000 }).ok).to.equal(true);
			expect(service.authenticate({ token: "", now: 2000 })).to.deep.equal({ ok: false, error: "no_session" });
		});

		it("rejects unknown, revoked and expired sessions", () => {
			const token = tokenFor("anna", 2000);

			expect(service.authenticate({ token: "fremd-token", now: 2000 })).to.deep.equal({
				ok: false,
				error: "no_session",
			});
			expect(service.logout({ token, ip: "10.0.0.8", now: 2100 })).to.equal(true);
			expect(service.authenticate({ token, now: 2100 })).to.deep.equal({ ok: false, error: "no_session" });
			expect(service.logout({ token, now: 2100 })).to.equal(false);

			const later = tokenFor("anna", 3000);
			expect(service.authenticate({ token: later, now: 3000 + 720 * 60 })).to.deep.equal({
				ok: false,
				error: "session_expired",
			});
			expect(countAudit("auth.logout")).to.equal(1);
		});

		it("renews a session in its second half", () => {
			const token = tokenFor("anna", 2000);
			const ttl = 720 * 60;

			// early in the lifetime nothing is written
			const early = service.authenticate({ token, now: 2000 + 60 });
			expect(early.ok && early.context.expiresAt).to.equal(2000 + ttl);

			const late = service.authenticate({ token, now: 2000 + ttl - 60 });
			expect(late.ok && late.context.expiresAt).to.equal(2000 + ttl - 60 + ttl);
			// the extension is stored
			expect(service.sessions(annaId, 2000 + ttl)[0].expiresAt).to.equal(2000 + ttl - 60 + ttl);
		});

		it("rejects sessions of deactivated users", () => {
			const token = tokenFor("anna", 2000);
			users.update({ id: annaId, patch: { isActive: false }, actorId: adminId });

			expect(service.authenticate({ token, now: 2000 })).to.deep.equal({ ok: false, error: "user_inactive" });
		});

		it("ends all sessions of a user", () => {
			const first = tokenFor("anna", 2000);
			const second = tokenFor("anna", 2001);
			tokenFor("admin", 2000);

			expect(service.revokeSessions({ userId: annaId, actorId: adminId, now: 3000 })).to.equal(2);
			expect(service.authenticate({ token: first, now: 3000 })).to.deep.equal({ ok: false, error: "no_session" });
			expect(service.authenticate({ token: second, now: 3000 })).to.deep.equal({
				ok: false,
				error: "no_session",
			});
			expect(countAudit("auth.revoke_all")).to.equal(1);

			// nothing left to revoke
			expect(service.revokeSessions({ userId: annaId, actorId: adminId, now: 3001 })).to.equal(0);
			expect(countAudit("auth.revoke_all")).to.equal(1);
		});

		it("purges expired and revoked sessions", () => {
			const token = tokenFor("anna", 2000);
			service.logout({ token, now: 2001 });
			tokenFor("anna", 2002);

			// one revoked session, the second one expired by then
			expect(service.purge(2002 + 720 * 60)).to.equal(2);
			expect(service.sessions(annaId, 2002)).to.deep.equal([]);
		});
	});

	describe("csrf", () => {
		it("binds the token to the session and the secret", () => {
			const result = service.login({ login: "anna", password, now: 2000 });
			if (!result.ok) {
				throw new Error("login failed");
			}

			expect(service.verifyCsrf({ token: result.token, csrfToken: result.csrfToken })).to.equal(true);
			expect(service.verifyCsrf({ token: result.token, csrfToken: "fremd" })).to.equal(false);
			expect(service.verifyCsrf({ token: "anderer-token", csrfToken: result.csrfToken })).to.equal(false);
			expect(service.verifyCsrf({ token: result.token, csrfToken: "" })).to.equal(false);

			// a service with another secret produces different tokens
			const other = createAuthService({ db, users, settings, secret: "anderes-geheimnis" });
			expect(other.verifyCsrf({ token: result.token, csrfToken: result.csrfToken })).to.equal(false);
		});
	});

	describe("setPassword", () => {
		it("enforces the policy, replaces the hash and audits it", () => {
			expect(() => service.setPassword({ userId: annaId, password: "kurz", actorId: adminId })).to.throw(
				"password does not fulfil the policy",
			);
			// the old password still works
			expect(service.login({ login: "anna", password, now: 2000 }).ok).to.equal(true);
			const auditsBefore = countAudit("auth.password_set");

			service.setPassword({
				userId: annaId,
				password: "Neues-Passwort-2026",
				mustChangePw: true,
				actorId: adminId,
				actorIp: "10.0.0.9",
				now: 3000,
			});

			expect(service.login({ login: "anna", password, now: 3001 }).ok).to.equal(false);
			const login = service.login({ login: "anna", password: "Neues-Passwort-2026", now: 3001 });
			expect(login.ok && login.user.mustChangePw).to.equal(true);
			expect(countAudit("auth.password_set")).to.equal(auditsBefore + 1);
			expect(lastDetail("auth.password_set")).to.deep.equal({ mustChangePw: true });
			// the user audit knows that the password changed, without the hash
			const userAudit = db
				.prepare("SELECT detail FROM audit_log WHERE action = 'user.update' ORDER BY id DESC LIMIT 1")
				.get() as { detail: string };
			expect(JSON.parse(userAudit.detail).passwordChanged).to.equal(true);
			expect(userAudit.detail).to.not.contain("Neues-Passwort-2026");
		});
	});
});
