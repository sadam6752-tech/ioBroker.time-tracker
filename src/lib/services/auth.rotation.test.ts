/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAuthService, type AuthService } from "./auth";

const SECRET = "rotation-test-secret";
const password = "Zeit-2026-klar";

describe("session rotation", () => {
	let db: Db;
	let users: UsersRepository;
	let auth: AuthService;
	let annaId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);

		// the seeded setting (720 minutes) wins over the default of the service, so it is set explicitly here
		const settings = createSettingsRepository(db);
		settings.set("session_ttl_minutes", "60", null, 1000);
		auth = createAuthService({
			db,
			users,
			settings,
			secret: SECRET,
			defaultTtlMinutes: 60,
		});

		const adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		auth.setPassword({ userId: annaId, password, actorId: adminId, now: 1000 });
	});

	/**
	 * Opens a session for anna.
	 *
	 * @param now - instant of the login
	 * @returns the session token
	 */
	function login(now: number): string {
		const started = auth.login({ login: "anna", password, now });
		if (!started.ok) {
			throw new Error("the login for the rotation tests failed");
		}
		return started.token;
	}

	it("leaves a young session alone", () => {
		const token = login(1000);

		// the lifetime is 60 minutes, so half of it (but at least 15 minutes) has to pass first
		expect(auth.rotateIfDue({ token, now: 1000 + 899 })).to.equal(null);
		expect(auth.rotateIfDue({ token, now: 1000 + 1799 })).to.equal(null);
	});

	it("replaces the token of a session that has been in use for a while", () => {
		const token = login(1000);
		const now = 1000 + 1800;

		const rotated = auth.rotateIfDue({ token, now });
		expect(rotated, "the rotation is due after half of the lifetime").to.not.equal(null);
		expect(rotated?.token).to.not.equal(token);
		expect(rotated?.expiresAt).to.equal(now + 60 * 60);

		// the old token is dead with its row, the new one carries the same session on
		expect(auth.authenticate({ token, now }).ok).to.equal(false);
		const afterwards = auth.authenticate({ token: rotated?.token ?? "", now });
		expect(afterwards.ok).to.equal(true);
		if (afterwards.ok) {
			expect(afterwards.context.user.login).to.equal("anna");
			expect(afterwards.context.user.id).to.equal(annaId);
		}

		// the renewed session also has the full lifetime again, so it is not rotated right away
		expect(auth.rotateIfDue({ token: rotated?.token ?? "", now: now + 1 })).to.equal(null);
	});

	it("does not renew an unknown or expired token", () => {
		const token = login(1000);

		expect(auth.rotateIfDue({ token: "gibt-es-nicht", now: 1000 + 1800 })).to.equal(null);
		// the session expired long ago: there is nothing left to rotate
		expect(auth.rotateIfDue({ token, now: 1000 + 60 * 60 + 1 })).to.equal(null);
	});
});
