/**
 * First administrator of the instance.
 *
 * Without an account nobody can log in, so the first start creates one: the login and the start password come from
 * the instance settings, and without a configured password a random one is generated (it is written to the adapter
 * log, because there is no other way to hand it to the operator).
 *
 * The account always carries “change the password”, so the start password opens the door exactly once. As long as
 * the administrator still has that unchanged start password, the configured value is applied again on every start —
 * an operator who sets the field *after* the first start (or restores a database) therefore reaches the
 * installation. That override is deliberately limited to the unchange start password: once the password was changed
 * in the web app, a forgotten field in the instance settings can never reset it, and the caller says in the log why
 * the configured value is out of play.
 */

import { randomBytes } from "node:crypto";
import type { UsersRepository } from "../db/repositories/users";
import { hashPassword, verifyPassword } from "./auth";

/** Role key that marks an administrator. */
const ADMIN_ROLE = "admin";

/** Login used when the instance settings leave the field empty. */
export const DEFAULT_ADMIN_LOGIN = "admin";

/** Time zone used when the instance settings leave the field empty (the web app falls back to it as well). */
export const DEFAULT_TIMEZONE = "Europe/Berlin";

/** Reason written to the audit trail when the start password is taken from the instance settings. */
const RESET_REASON = "start password from the instance settings";

/**
 * Generates a start password.
 *
 * @returns random password that satisfies the password policy (letters, digits and at least ten characters)
 */
export function generateStartPassword(): string {
	return `Zf-${randomBytes(9).toString("base64url")}-7`;
}

/** What {@link ensureFirstAdministrator} did. */
export type FirstAdministratorOutcome =
	/** No administrator existed, the account was created (`password` is the start password, `generated` says why) */
	| { action: "created"; login: string; password: string; generated: boolean }
	/** The unchange start password of the existing administrator was set to the configured value */
	| { action: "start_password_reset"; login: string }
	/** The existing administrator carries the configured start password already (nothing was written) */
	| { action: "start_password_unchanged"; login: string }
	/** The administrator changed his password, so the configured start password is not used */
	| { action: "password_changed"; login: string }
	/** An administrator exists and the instance settings carry no start password */
	| { action: "existing"; login: string }
	/** The account could not be created (a taken login, a broken database) */
	| { action: "failed"; login: string; reason: string };

/**
 * Creates the first administrator when the instance has none, and keeps the configured start password working while
 * that account still carries its unchange start password.
 *
 * @param input - user storage and the instance settings
 * @param input.users - user repository of the open database
 * @param input.login - configured login of the first administrator (empty = {@link DEFAULT_ADMIN_LOGIN})
 * @param input.password - configured start password (empty = a random one is generated)
 * @param input.timezone - time zone of the new account (empty = {@link DEFAULT_TIMEZONE})
 * @param input.now - instant of the change, defaults to now
 * @returns what happened, so the caller can log it
 */
export function ensureFirstAdministrator(input: {
	users: UsersRepository;
	login?: string | null;
	password?: string | null;
	timezone?: string | null;
	now?: number;
}): FirstAdministratorOutcome {
	const login = (input.login ?? "").trim() || DEFAULT_ADMIN_LOGIN;
	const configured = (input.password ?? "").trim();
	const administrators = input.users.list().filter(user => input.users.roles(user.id).includes(ADMIN_ROLE));

	if (administrators.length > 0) {
		// Several administrators are possible: the configured login wins, otherwise the oldest account is the one
		// the instance settings describe (“the first administrator”).
		const target =
			administrators.find(user => user.login.toLowerCase() === login.toLowerCase()) ??
			[...administrators].sort((left, right) => left.id - right.id)[0];

		if (!configured) {
			return { action: "existing", login: target.login };
		}
		if (!target.mustChangePw) {
			return { action: "password_changed", login: target.login };
		}
		if (verifyPassword(configured, target.passwordHash)) {
			return { action: "start_password_unchanged", login: target.login };
		}

		input.users.update({
			id: target.id,
			patch: { passwordHash: hashPassword(configured), mustChangePw: true },
			reason: RESET_REASON,
			actorId: target.id,
			now: input.now,
		});
		return { action: "start_password_reset", login: target.login };
	}

	const password = configured || generateStartPassword();
	try {
		const user = input.users.create({
			login,
			displayName: login,
			passwordHash: hashPassword(password),
			mustChangePw: true,
			timezone: (input.timezone ?? "").trim() || DEFAULT_TIMEZONE,
			roleKeys: [ADMIN_ROLE],
			now: input.now,
		});
		return { action: "created", login: user.login, password, generated: !configured };
	} catch (error) {
		return { action: "failed", login, reason: error instanceof Error ? error.message : String(error) };
	}
}
