/**
 * Kiosk terminals (`kiosk_terminals`).
 *
 * A terminal authenticates with a **device token** that is handed out exactly once (only its SHA-256 hash is
 * stored) and that can be revoked and given an expiry. A device exchanges the token for a **short lived
 * session**, which is stored as a hash as well and is extended by the heartbeat of the device. The repository
 * never returns a token or a session — it only ever sees their hashes.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../database";
import { NotFoundError, ValidationError } from "../../errors";
import { writeAuditLog } from "./audit";

/** A kiosk terminal as it is stored (without any secret). */
export interface TerminalRecord {
	/** Primary key */
	id: number;
	/** Display name, e.g. `Werkstatt` */
	name: string;
	/** Optional location of the device */
	location: string | null;
	/** True when a badge has to be combined with the personal PIN */
	pinRequired: boolean;
	/** False for revoked devices */
	isActive: boolean;
	/** Instant the device token expires, `null` = never */
	expiresAt: number | null;
	/** Instant of the last heartbeat, `null` if the device never called */
	lastSeenAt: number | null;
	/** Instant the current session expires, `null` when there is none */
	sessionExpiresAt: number | null;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
	/** Employees shown on this terminal; an empty list means “all employees” */
	userIds: number[];
}

/** Terminal storage operations. */
export interface TerminalsRepository {
	/** Creates a terminal and returns its device token (the only time it is visible) */
	create(input: {
		name: string;
		location?: string | null;
		pinRequired?: boolean;
		/** Employees shown on the terminal; leave it out for “all employees” */
		userIds?: number[];
		/** Days until the device token expires, `null` = never */
		ttlDays?: number | null;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): { terminal: TerminalRecord; deviceToken: string };
	/** All terminals, optionally including the revoked ones */
	list(options?: { includeInactive?: boolean }): TerminalRecord[];
	/** Reads a terminal by id */
	findById(id: number): TerminalRecord | null;
	/** Resolves a device token (checks revocation and expiry) */
	findByToken(deviceToken: string, now?: number): TerminalRecord | null;
	/** Starts a session for a device and returns the session token (replaces a running session) */
	startSession(input: { id: number; ttlMinutes: number; now?: number }): {
		terminalSession: string;
		expiresAt: number;
	};
	/** Resolves a session token (checks revocation and expiry) */
	findBySession(terminalSession: string, now?: number): TerminalRecord | null;
	/** Extends a session and records the heartbeat */
	touch(input: { id: number; ttlMinutes: number; now?: number }): { expiresAt: number };
	/** Replaces the employees of a terminal (an empty list means “all employees”) */
	setUsers(input: {
		id: number;
		userIds: number[];
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): TerminalRecord;
	/** Deactivates a terminal and ends its session */
	revoke(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
}

/**
 * Builds the hash of a token (device token or session).
 *
 * @param token - token in clear text
 * @returns hex encoded SHA-256 hash
 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a random token.
 *
 * @returns base64url encoded token
 */
export function newToken(): string {
	return randomBytes(32).toString("base64url");
}

interface TerminalRow {
	id: number;
	name: string;
	location: string | null;
	pin_required: number;
	is_active: number;
	expires_at: number | null;
	last_seen_at: number | null;
	session_expires_at: number | null;
	created_at: number;
}

const TERMINAL_COLUMNS = `id, name, location, pin_required, is_active, expires_at, last_seen_at,
	session_expires_at, created_at`;

/**
 * Maps a database row to a terminal record (without its employees — they live in `terminal_users`).
 *
 * @param row - raw database row
 * @returns terminal record
 */
function mapTerminalRow(row: TerminalRow): Omit<TerminalRecord, "userIds"> {
	return {
		id: row.id,
		name: row.name,
		location: row.location,
		pinRequired: row.pin_required !== 0,
		isActive: row.is_active !== 0,
		expiresAt: row.expires_at,
		lastSeenAt: row.last_seen_at,
		sessionExpiresAt: row.session_expires_at,
		createdAt: row.created_at,
	};
}

/**
 * Creates the terminals repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createTerminalsRepository(db: Db): TerminalsRepository {
	const insertTerminal = db.prepare(
		`INSERT INTO kiosk_terminals (name, location, token_hash, pin_required, is_active, expires_at, created_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?)`,
	);
	const selectById = db.prepare(`SELECT ${TERMINAL_COLUMNS} FROM kiosk_terminals WHERE id = ?`);
	const selectByToken = db.prepare(`SELECT ${TERMINAL_COLUMNS} FROM kiosk_terminals WHERE token_hash = ?`);
	const selectBySession = db.prepare(`SELECT ${TERMINAL_COLUMNS} FROM kiosk_terminals WHERE session_hash = ?`);
	const selectAll = db.prepare(`SELECT ${TERMINAL_COLUMNS} FROM kiosk_terminals ORDER BY name COLLATE NOCASE, id`);
	const selectActive = db.prepare(
		`SELECT ${TERMINAL_COLUMNS} FROM kiosk_terminals WHERE is_active = 1 ORDER BY name COLLATE NOCASE, id`,
	);
	const updateSession = db.prepare(
		"UPDATE kiosk_terminals SET session_hash = ?, session_expires_at = ? WHERE id = ?",
	);
	const updateHeartbeat = db.prepare(
		"UPDATE kiosk_terminals SET session_expires_at = ?, last_seen_at = ? WHERE id = ?",
	);
	const deactivate = db.prepare(
		"UPDATE kiosk_terminals SET is_active = 0, session_hash = NULL, session_expires_at = NULL WHERE id = ?",
	);
	const selectUsers = db.prepare(
		"SELECT user_id AS userId FROM terminal_users WHERE terminal_id = ? ORDER BY user_id",
	);
	const deleteUsers = db.prepare("DELETE FROM terminal_users WHERE terminal_id = ?");
	const insertUser = db.prepare(
		"INSERT OR IGNORE INTO terminal_users (terminal_id, user_id, created_at) VALUES (?, ?, ?)",
	);

	/**
	 * Attaches the employees of a terminal.
	 *
	 * @param record - terminal without its employees
	 * @returns the terminal with its employees (an empty list means “all employees”)
	 */
	const withUsers = (record: Omit<TerminalRecord, "userIds">): TerminalRecord => ({
		...record,
		userIds: (selectUsers.all(record.id) as { userId: number }[]).map(row => row.userId),
	});

	/**
	 * Reads a terminal.
	 *
	 * @param id - terminal id
	 * @returns terminal or `null`
	 */
	const read = (id: number): TerminalRecord | null => {
		const row = selectById.get(id) as TerminalRow | undefined;
		return row ? withUsers(mapTerminalRow(row)) : null;
	};

	/**
	 * Checks whether a device may still be used.
	 *
	 * @param record - terminal
	 * @param now - instant
	 * @returns true when the device is active and its token has not expired
	 */
	const usable = (record: Omit<TerminalRecord, "userIds">, now: number): boolean =>
		record.isActive && (record.expiresAt === null || record.expiresAt > now);

	return {
		create(input: {
			name: string;
			location?: string | null;
			pinRequired?: boolean;
			userIds?: number[];
			ttlDays?: number | null;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): { terminal: TerminalRecord; deviceToken: string } {
			const name = input.name.trim();
			if (!name) {
				throw new ValidationError("name is required");
			}
			const ttlDays = input.ttlDays ?? null;
			if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays <= 0)) {
				throw new ValidationError(`ttlDays must be a positive whole number (got ${input.ttlDays})`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const deviceToken = newToken();
			const expiresAt = ttlDays === null ? null : now + ttlDays * 86400;
			const userIds = [...new Set(input.userIds ?? [])];

			let terminalId = 0;
			const run = db.transaction((): void => {
				const result = insertTerminal.run(
					name,
					input.location ?? null,
					hashToken(deviceToken),
					(input.pinRequired ?? true) ? 1 : 0,
					expiresAt,
					now,
				);
				terminalId = Number(result.lastInsertRowid);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "terminal.create",
					entity: "kiosk_terminal",
					entityId: terminalId,
					// the token itself is never part of the audit trail
					detail: {
						name,
						location: input.location ?? null,
						pinRequired: input.pinRequired ?? true,
						expiresAt,
						userIds,
					},
					ip: input.actorIp ?? null,
				});
				// the employees of this terminal (none = all employees)
				for (const userId of userIds) {
					insertUser.run(terminalId, userId, now);
				}
			});
			run();

			const terminal = read(terminalId);
			if (!terminal) {
				throw new Error(`terminal ${terminalId} disappeared right after creation`);
			}
			return { terminal, deviceToken };
		},

		list(options?: { includeInactive?: boolean }): TerminalRecord[] {
			const rows = (options?.includeInactive === true ? selectAll : selectActive).all() as TerminalRow[];
			return rows.map(row => withUsers(mapTerminalRow(row)));
		},

		findById: read,

		findByToken(deviceToken: string, now?: number): TerminalRecord | null {
			const row = selectByToken.get(hashToken(deviceToken)) as TerminalRow | undefined;
			if (!row) {
				return null;
			}
			const record = mapTerminalRow(row);
			return usable(record, now ?? Math.floor(Date.now() / 1000)) ? withUsers(record) : null;
		},

		startSession(input: { id: number; ttlMinutes: number; now?: number }): {
			terminalSession: string;
			expiresAt: number;
		} {
			const terminal = read(input.id);
			if (!terminal) {
				throw new NotFoundError(`terminal ${input.id} not found`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const expiresAt = now + input.ttlMinutes * 60;
			const terminalSession = newToken();
			// a new session replaces a running one, so a stolen session cannot be used in parallel
			updateSession.run(hashToken(terminalSession), expiresAt, input.id);
			return { terminalSession, expiresAt };
		},

		findBySession(terminalSession: string, now?: number): TerminalRecord | null {
			const row = selectBySession.get(hashToken(terminalSession)) as TerminalRow | undefined;
			if (!row) {
				return null;
			}
			const record = mapTerminalRow(row);
			const at = now ?? Math.floor(Date.now() / 1000);
			if (!usable(record, at) || record.sessionExpiresAt === null || record.sessionExpiresAt <= at) {
				return null;
			}
			return withUsers(record);
		},

		touch(input: { id: number; ttlMinutes: number; now?: number }): { expiresAt: number } {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const expiresAt = now + input.ttlMinutes * 60;
			updateHeartbeat.run(expiresAt, now, input.id);
			return { expiresAt };
		},

		setUsers(input: {
			id: number;
			userIds: number[];
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): TerminalRecord {
			const terminal = read(input.id);
			if (!terminal) {
				throw new NotFoundError(`terminal ${input.id} not found`);
			}
			const userIds = [...new Set(input.userIds)];
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deleteUsers.run(input.id);
				for (const userId of userIds) {
					insertUser.run(input.id, userId, now);
				}
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "terminal.users",
					entity: "kiosk_terminal",
					entityId: input.id,
					detail: { name: terminal.name, userIds },
					ip: input.actorIp ?? null,
				});
			});
			run();

			return read(input.id) ?? terminal;
		},

		revoke(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const terminal = read(input.id);
			if (!terminal || !terminal.isActive) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deactivate.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "terminal.revoke",
					entity: "kiosk_terminal",
					entityId: input.id,
					detail: { name: terminal.name },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},
	};
}
