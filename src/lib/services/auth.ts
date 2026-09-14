/**
 * Authentication and session service.
 *
 * Passwords are stored as **scrypt** hashes (params are part of the stored string, so the cost can be raised
 * later without invalidating existing hashes). Sessions use opaque random tokens; only the SHA-256 hash of a
 * token is stored, so a leaked database never exposes usable session tokens.
 *
 * Every login, failed attempt, lockout and logout is audited. Failed attempts are counted per login name and
 * lock the account for a while (process-local, which is what a single adapter instance needs).
 *
 * The legacy SHA-1 hash of the old system is a migration aid only and is never accepted as a login credential.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/database";
import type { SettingsRepository } from "../db/repositories/settings";
import type { UserRecord, UsersRepository } from "../db/repositories/users";
import { ValidationError } from "../errors";
import { writeAuditLog } from "../db/repositories/audit";

/** Cost parameters of a stored password hash. */
export interface PasswordHashOptions {
	/** CPU/memory cost (`N`) */
	cost?: number;
	/** Block size (`r`) */
	blockSize?: number;
	/** Parallelisation (`p`) */
	parallelization?: number;
	/** Length of the derived key in bytes */
	keyLength?: number;
}

/** Rules a new password has to fulfil. */
export interface PasswordPolicy {
	/** Minimum length, default 10 */
	minLength?: number;
	/** Require at least one digit, default true */
	requireDigit?: boolean;
	/** Require at least one letter, default true */
	requireLetter?: boolean;
}

/** A user as it may leave the server (never contains hashes). */
export interface PublicUser {
	/** Primary key */
	id: number;
	/** Login name */
	login: string;
	/** Shown name */
	displayName: string;
	/** Preferred language */
	locale: string;
	/** IANA time zone */
	timezone: string;
	/** True while the user has to set a new password */
	mustChangePw: boolean;
}

/** Input for a login. */
export interface LoginInput {
	/** Login name (case insensitive) */
	login: string;
	/** Plain password */
	password: string;
	/** Browser/device information, stored with the session */
	userAgent?: string | null;
	/** Client IP address */
	ip?: string | null;
	/** Instant of the login, defaults to now */
	now?: number;
}

/** Result of a login attempt. */
export type LoginResult =
	| {
			/** Login succeeded */
			ok: true;
			/** Session token (only returned once, never stored in plain form) */
			token: string;
			/** Token that has to be sent back for state changing requests */
			csrfToken: string;
			/** Instant the session expires, UTC epoch seconds */
			expiresAt: number;
			/** Authenticated user without hashes */
			user: PublicUser;
	  }
	| {
			/** Login failed */
			ok: false;
			/** Reason, always generic towards the client */
			error: "invalid_credentials" | "locked_out";
	  };

/** Reason why a request was not authenticated. */
export type AuthError = "no_session" | "session_expired" | "user_inactive" | "permission_denied";

/** Result of authenticating a request. */
export type AuthResult =
	| {
			/** Session is valid */
			ok: true;
			/** Authenticated context */
			context: AuthContext;
	  }
	| {
			/** Session is not usable */
			ok: false;
			/** Reason of the rejection */
			error: AuthError;
	  };

/** Everything a request handler needs to know about the caller. */
export interface AuthContext {
	/** Session id (hash of the token) */
	sessionId: string;
	/** Instant the session expires */
	expiresAt: number;
	/** Authenticated user without hashes */
	user: PublicUser;
	/** Effective permission keys of the user */
	permissions: string[];
}

/** A session as shown to an administrator (without the token). */
export interface SessionInfo {
	/** Session id (hash of the token) */
	id: string;
	/** Owner of the session */
	userId: number;
	/** Instant of creation */
	createdAt: number;
	/** Instant of expiry */
	expiresAt: number;
	/** Browser/device information */
	userAgent: string | null;
	/** Client IP address */
	ip: string | null;
	/** True when the session was ended */
	revoked: boolean;
}

/** Data sources of the authentication service. */
export interface AuthDeps {
	/** Open database handle */
	db: Db;
	/** User storage */
	users: UsersRepository;
	/** Instance settings (session lifetime) */
	settings: SettingsRepository;
	/** Secret used to sign CSRF tokens */
	secret: string;
	/** Session lifetime in minutes when the setting is missing (default 720) */
	defaultTtlMinutes?: number;
	/** Failed attempts before a login is locked (default 10) */
	maxFailedAttempts?: number;
	/** Minutes a login stays locked (default 15) */
	lockoutMinutes?: number;
	/** Policy for new passwords */
	policy?: PasswordPolicy;
}

/** Authentication operations. */
export interface AuthService {
	/** Verifies a login and opens a session */
	login(input: LoginInput): LoginResult;
	/** Ends a session */
	logout(input: { token: string; actorId?: number | null; ip?: string | null; now?: number }): boolean;
	/** Checks a session token, optionally requiring a permission */
	authenticate(input: { token: string; permission?: string; now?: number }): AuthResult;
	/** Ends all sessions of a user (e.g. after a password change) */
	revokeSessions(input: { userId: number; actorId: number; now?: number }): number;
	/** Active sessions of a user */
	sessions(userId: number, now?: number): SessionInfo[];
	/** Deletes sessions that expired before the given instant */
	purge(now?: number): number;
	/** Token that protects state changing requests of a session */
	csrfToken(token: string): string;
	/** Checks a CSRF token */
	verifyCsrf(input: { token: string; csrfToken: string }): boolean;
	/** Sets a new password (hashed) after checking the policy */
	setPassword(input: {
		userId: number;
		password: string;
		mustChangePw?: boolean;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): void;
}

/** Default cost parameters (interactive login, ~50 ms on a modern machine). */
const DEFAULT_HASH: Required<PasswordHashOptions> = {
	cost: 16384,
	blockSize: 8,
	parallelization: 1,
	keyLength: 64,
};

const HASH_PREFIX = "scrypt";

/**
 * Hashes a password with scrypt.
 *
 * @param password - plain password
 * @param options - cost parameters
 * @returns stored representation `scrypt$N$r$p$keyLength$salt$hash`
 */
export function hashPassword(password: string, options: PasswordHashOptions = {}): string {
	const cost = options.cost ?? DEFAULT_HASH.cost;
	const blockSize = options.blockSize ?? DEFAULT_HASH.blockSize;
	const parallelization = options.parallelization ?? DEFAULT_HASH.parallelization;
	const keyLength = options.keyLength ?? DEFAULT_HASH.keyLength;
	const salt = randomBytes(16);
	const derived = scryptSync(password, salt, keyLength, {
		N: cost,
		r: blockSize,
		p: parallelization,
		maxmem: 256 * cost * blockSize,
	});

	return [
		HASH_PREFIX,
		cost,
		blockSize,
		parallelization,
		keyLength,
		salt.toString("base64"),
		derived.toString("base64"),
	].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Malformed or unsupported hashes (e.g. an empty column for imported users) never match.
 *
 * @param password - plain password
 * @param stored - stored representation
 * @returns true when the password matches
 */
export function verifyPassword(password: string, stored: string): boolean {
	const parts = (stored ?? "").split("$");
	if (parts.length !== 7 || parts[0] !== HASH_PREFIX) {
		return false;
	}
	const cost = Number(parts[1]);
	const blockSize = Number(parts[2]);
	const parallelization = Number(parts[3]);
	const keyLength = Number(parts[4]);
	if (![cost, blockSize, parallelization, keyLength].every(value => Number.isInteger(value) && value > 0)) {
		return false;
	}

	let expected: Buffer;
	try {
		expected = Buffer.from(parts[6], "base64");
	} catch {
		return false;
	}
	if (expected.length !== keyLength) {
		return false;
	}

	const derived = scryptSync(password, Buffer.from(parts[5], "base64"), keyLength, {
		N: cost,
		r: blockSize,
		p: parallelization,
		maxmem: 256 * cost * blockSize,
	});
	return timingSafeEqual(derived, expected);
}

/**
 * Checks a new password against the policy.
 *
 * @param password - plain password
 * @param policy - rules to apply
 * @returns the violated rule or `null`
 */
export function checkPasswordPolicy(password: string, policy: PasswordPolicy = {}): string | null {
	const minLength = policy.minLength ?? 10;
	if (password.length < minLength) {
		return "too_short";
	}
	if ((policy.requireLetter ?? true) && !/[A-Za-z]/.test(password)) {
		return "no_letter";
	}
	if ((policy.requireDigit ?? true) && !/\d/.test(password)) {
		return "no_digit";
	}
	return null;
}

/**
 * Creates the authentication service.
 *
 * @param deps - data sources and policy
 * @returns service instance
 */
export function createAuthService(deps: AuthDeps): AuthService {
	const { db, users, settings, secret } = deps;
	const defaultTtl = deps.defaultTtlMinutes ?? 720;
	const maxFailed = deps.maxFailedAttempts ?? 10;
	const lockoutSeconds = (deps.lockoutMinutes ?? 15) * 60;
	const policy = deps.policy ?? {};

	/** Failed attempts per login name (process-local, which is enough for one adapter instance). */
	const failures = new Map<string, { count: number; blockedUntil: number }>();

	const selectSession = db.prepare(
		`SELECT id, user_id AS userId, created_at AS createdAt, expires_at AS expiresAt,
		        user_agent AS userAgent, ip, revoked
		 FROM sessions WHERE id = ?`,
	);
	const selectUserSessions = db.prepare(
		`SELECT id, user_id AS userId, created_at AS createdAt, expires_at AS expiresAt,
		        user_agent AS userAgent, ip, revoked
		 FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ?
		 ORDER BY created_at DESC`,
	);
	const insertSession = db.prepare(
		`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip, revoked)
		 VALUES (?, ?, ?, ?, ?, ?, 0)`,
	);
	const revokeSession = db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?");
	const revokeUserSessions = db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0");
	const extendSession = db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?");
	const purgeSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked = 1");

	/**
	 * Only the hash of a token is stored, so a database leak cannot be replayed.
	 *
	 * @param token - session token as it was handed to the client
	 * @returns SHA-256 hash used as session id
	 */
	const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

	const ttlSeconds = (): number =>
		Math.max(1, Math.round(settings.getNumber("session_ttl_minutes", defaultTtl))) * 60;

	const publicUser = (user: UserRecord): PublicUser => ({
		id: user.id,
		login: user.login,
		displayName: user.displayName,
		locale: user.locale,
		timezone: user.timezone,
		mustChangePw: user.mustChangePw,
	});

	const readSession = (sessionId: string): SessionInfo | null => {
		const row = selectSession.get(sessionId) as (Omit<SessionInfo, "revoked"> & { revoked: number }) | undefined;
		return row ? { ...row, revoked: row.revoked !== 0 } : null;
	};

	return {
		login(input: LoginInput): LoginResult {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const key = input.login.trim().toLowerCase();
			const previous = failures.get(key);

			if (previous && previous.blockedUntil > now) {
				writeAuditLog(db, {
					atUtc: now,
					action: "auth.login_locked",
					entity: "user",
					entityId: null,
					detail: { login: input.login.trim(), blockedUntil: previous.blockedUntil },
					ip: input.ip ?? null,
				});
				return { ok: false, error: "locked_out" };
			}

			/**
			 * Counts a failed attempt and locks the login once the limit is reached.
			 *
			 * @param reason - internal reason (never sent to the client)
			 * @param userId - known user id, `null` when the login is unknown
			 * @returns the generic failure result
			 */
			const registerFailure = (reason: string, userId: number | null): LoginResult => {
				const expiredLock = previous !== undefined && previous.blockedUntil > 0 && previous.blockedUntil <= now;
				const count = previous === undefined || expiredLock ? 1 : previous.count + 1;
				const blockedUntil = count >= maxFailed ? now + lockoutSeconds : 0;
				failures.set(key, { count, blockedUntil });

				writeAuditLog(db, {
					atUtc: now,
					action: "auth.login_failed",
					entity: "user",
					entityId: userId,
					detail: { login: input.login.trim(), reason, attempts: count, blockedUntil },
					ip: input.ip ?? null,
				});
				return { ok: false, error: "invalid_credentials" };
			};

			const user = users.findByLogin(input.login);
			if (!user) {
				return registerFailure("unknown_user", null);
			}
			if (!user.isActive) {
				return registerFailure("inactive_user", user.id);
			}
			if (!user.passwordHash) {
				// imported users without a password cannot log in (the legacy hash is not a credential)
				return registerFailure("no_password", user.id);
			}
			if (!verifyPassword(input.password, user.passwordHash)) {
				return registerFailure("wrong_password", user.id);
			}

			failures.delete(key);
			const token = randomBytes(32).toString("base64url");
			const sessionId = hashToken(token);
			const expiresAt = now + ttlSeconds();

			const run = db.transaction((): void => {
				insertSession.run(sessionId, user.id, now, expiresAt, input.userAgent ?? null, input.ip ?? null);
				writeAuditLog(db, {
					atUtc: now,
					actorId: user.id,
					action: "auth.login",
					entity: "session",
					entityId: sessionId,
					detail: { login: user.login, userAgent: input.userAgent ?? null },
					ip: input.ip ?? null,
				});
			});
			run();
			users.recordLogin(user.id, now);

			return { ok: true, token, csrfToken: this.csrfToken(token), expiresAt, user: publicUser(user) };
		},

		logout(input: { token: string; actorId?: number | null; ip?: string | null; now?: number }): boolean {
			const token = input.token?.trim() ?? "";
			if (!token) {
				return false;
			}
			const sessionId = hashToken(token);
			const session = readSession(sessionId);
			if (!session || session.revoked) {
				return false;
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				revokeSession.run(sessionId);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId ?? session.userId,
					action: "auth.logout",
					entity: "session",
					entityId: sessionId,
					detail: { userId: session.userId },
					ip: input.ip ?? null,
				});
			});
			run();
			return true;
		},

		authenticate(input: { token: string; permission?: string; now?: number }): AuthResult {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const token = input.token?.trim() ?? "";
			if (!token) {
				return { ok: false, error: "no_session" };
			}

			const session = readSession(hashToken(token));
			if (!session || session.revoked) {
				return { ok: false, error: "no_session" };
			}
			if (session.expiresAt <= now) {
				return { ok: false, error: "session_expired" };
			}

			const user = users.findById(session.userId);
			if (!user || !user.isActive) {
				return { ok: false, error: "user_inactive" };
			}

			const permissions = users.permissions(user.id);
			if (input.permission && !permissions.includes(input.permission)) {
				return { ok: false, error: "permission_denied" };
			}

			// sliding renewal: extend the session in its second half
			const ttl = ttlSeconds();
			if (session.expiresAt - now < ttl / 2) {
				const next = now + ttl;
				extendSession.run(next, session.id);
				session.expiresAt = next;
			}

			return {
				ok: true,
				context: {
					sessionId: session.id,
					expiresAt: session.expiresAt,
					user: publicUser(user),
					permissions,
				},
			};
		},

		revokeSessions(input: { userId: number; actorId: number; now?: number }): number {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			let revoked = 0;
			const run = db.transaction((): void => {
				revoked = revokeUserSessions.run(input.userId).changes;
				if (revoked > 0) {
					writeAuditLog(db, {
						atUtc: now,
						actorId: input.actorId,
						action: "auth.revoke_all",
						entity: "user",
						entityId: input.userId,
						detail: { sessions: revoked },
					});
				}
			});
			run();
			return revoked;
		},

		sessions(userId: number, now?: number): SessionInfo[] {
			const reference = now ?? Math.floor(Date.now() / 1000);
			const rows = selectUserSessions.all(userId, reference) as (Omit<SessionInfo, "revoked"> & {
				revoked: number;
			})[];
			return rows.map(row => ({ ...row, revoked: row.revoked !== 0 }));
		},

		purge(now?: number): number {
			return purgeSessions.run(now ?? Math.floor(Date.now() / 1000)).changes;
		},

		csrfToken(token: string): string {
			return createHmac("sha256", secret).update(token).digest("base64url");
		},

		verifyCsrf(input: { token: string; csrfToken: string }): boolean {
			const expected = this.csrfToken(input.token ?? "");
			const provided = input.csrfToken ?? "";
			if (expected.length !== provided.length) {
				return false;
			}
			return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
		},

		setPassword(input: {
			userId: number;
			password: string;
			mustChangePw?: boolean;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): void {
			const violated = checkPasswordPolicy(input.password, policy);
			if (violated) {
				throw new ValidationError(`password does not fulfil the policy (${violated})`);
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const mustChangePw = input.mustChangePw ?? false;
			// the user repository audits the change without the hash
			users.update({
				id: input.userId,
				patch: { passwordHash: hashPassword(input.password), mustChangePw },
				reason: mustChangePw ? "password reset by an administrator" : "password changed",
				actorId: input.actorId,
				actorIp: input.actorIp ?? null,
				now,
			});
			writeAuditLog(db, {
				atUtc: now,
				actorId: input.actorId,
				action: "auth.password_set",
				entity: "user",
				entityId: input.userId,
				detail: { mustChangePw },
				ip: input.actorIp ?? null,
			});
		},
	};
}
