/**
 * User repository (`users`, `user_roles`, `work_profiles`).
 *
 * Every write records an audit entry in the same transaction; passwords and password hashes never end up
 * in the audit trail, only the fact that they were changed.
 */

import type { Db } from "../database";
import type { OvertimeModel } from "../../domain/calculation";
import type { WorkProfile } from "../../domain/target";
import { NotFoundError, ValidationError } from "../../errors";
import { writeAuditLog, diffFields } from "./audit";

/** A user as stored in the database. */
export interface UserRecord {
	/** Primary key */
	id: number;
	/** Unique login name */
	login: string;
	/** Hash of the password (never leaves the server) */
	passwordHash: string;
	/** SHA-1 hash of the legacy system (migration only) */
	legacySha1: string | null;
	/** Name shown in the UI */
	displayName: string;
	/** E-mail address */
	email: string | null;
	/** RFID card id */
	rfidCard: string | null;
	/** False for deactivated accounts */
	isActive: boolean;
	/** True while the user has to set a new password */
	mustChangePw: boolean;
	/** Preferred language */
	locale: string;
	/** IANA time zone of the user */
	timezone: string;
	/** Hash of the personal kiosk PIN, `null` when none is set */
	pinHash: string | null;
	/** Picture of the employee as a data URL, `null` when none is stored */
	avatar: string | null;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
	/** Instant of the last change, UTC epoch seconds */
	updatedAt: number;
	/** Instant of the last successful login, `null` if never logged in */
	lastLoginAt: number | null;
}

/** Employment parameters of a user (`work_profiles`). */
export interface WorkProfileRecord extends WorkProfile {
	/** Owner of the profile */
	userId: number;
	/** Employment level in percent */
	percent: number;
	/** Contracted hours per week at 100 % */
	weeklyHours: number;
	/** Active working days, `0;1;…` for Sunday…Saturday */
	workdays: string;
	/** First day of the employment (UTC epoch seconds) */
	startDate: number | null;
	/** Last day of the employment (UTC epoch seconds) */
	endDate: number | null;
	/** Overtime taken over from the previous year, in minutes */
	overtimeCarryover: number;
	/** Annual “Vorholzeit” in minutes */
	vorholzeitPerYear: number;
	/** Vacation days taken over from the previous year */
	vacationCarryover: number;
	/** Annual vacation entitlement in days */
	vacationPerYear: number;
	/** Overtime model used for the reports */
	overtimeModel: OvertimeModel;
	/** Country specific holiday flags (JSON), `null` = instance default */
	holidayFlags: string | null;
	/** Traceability of an imported profile */
	legacySource: string | null;
}

/** Input for creating a user. */
export interface CreateUserInput {
	/** Unique login name */
	login: string;
	/** Shown name */
	displayName: string;
	/** Password hash (already hashed by the caller) */
	passwordHash?: string;
	/** SHA-1 hash of the legacy system (migration only, never a login credential) */
	legacySha1?: string | null;
	/** E-mail address */
	email?: string | null;
	/** Preferred language, default `de-DE` */
	locale?: string;
	/** IANA time zone, default `Europe/Berlin` */
	timezone?: string;
	/** RFID card id */
	rfidCard?: string | null;
	/** Forces a password change on the next login */
	mustChangePw?: boolean;
	/** Roles to assign (all permissions are granted by the seed roles) */
	roleKeys?: string[];
	/** Id of the user who is an additional employee of the new account (self service) */
	actorId?: number | null;
	/** Client IP address */
	actorIp?: string | null;
	/** Instant of creation, defaults to now */
	now?: number;
}

/** Input for changing a user. */
export interface UpdateUserInput {
	/** Id of the changed user */
	id: number;
	/** Fields to change */
	patch: {
		displayName?: string;
		email?: string | null;
		locale?: string;
		timezone?: string;
		rfidCard?: string | null;
		isActive?: boolean;
		mustChangePw?: boolean;
		/** Password hash (already hashed by the caller) */
		passwordHash?: string;
	};
	/** Reason of the change (recorded in the audit trail) */
	reason?: string | null;
	/** Who performs the change */
	actorId: number;
	/** Client IP address of the actor */
	actorIp?: string | null;
	/** Instant of the change, defaults to now */
	now?: number;
}

/** Thrown when a login name is already taken. */
export class LoginExistsError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param login - login name that is already taken
	 */
	constructor(public readonly login: string) {
		super(`login "${login}" already exists`);
		this.name = "LoginExistsError";
	}
}

/** Thrown when a role key is not known. */
export class UnknownRoleError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param roleKey - unknown role key
	 */
	constructor(public readonly roleKey: string) {
		super(`unknown role "${roleKey}"`);
		this.name = "UnknownRoleError";
	}
}

/** User storage operations. */
export interface UsersRepository {
	/** Creates a user including a default work profile */
	create(input: CreateUserInput): UserRecord;
	/** Reads a user by id */
	findById(id: number): UserRecord | null;
	/** Reads a user by login (case insensitive) */
	findByLogin(login: string): UserRecord | null;
	/** Reads a user by the RFID card of the badge terminal */
	findByRfidCard(card: string): UserRecord | null;
	/** Stores or clears the personal kiosk PIN (never written to the audit trail) */
	setPin(input: {
		userId: number;
		pinHash: string | null;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): void;
	/** Stores or clears the picture of an employee (the image itself never reaches the audit trail) */
	setAvatar(input: {
		/** Id of the employee */
		userId: number;
		/** Data URL of the picture, `null` clears it */
		avatar: string | null;
		/** Who changes the picture */
		actorId: number;
		/** Client IP address of the actor */
		actorIp?: string | null;
		/** Instant of the change, defaults to now */
		now?: number;
	}): void;
	/**
	 * Replaces the legacy SHA-1 hash of an account with a real password hash (specification 2.9.1).
	 *
	 * `legacy_sha1` is cleared in the same statement, so the old hash can never be used again. Neither the
	 * old nor the new hash reaches the audit trail.
	 */
	migrateLegacyPassword(input: {
		/** Id of the migrated account */
		userId: number;
		/** New hash, created with the current scheme by the caller */
		passwordHash: string;
		/** True while the user still has to set a new password */
		mustChangePw: boolean;
		/** Who performs the migration */
		actorId: number;
		/** Client IP address of the actor */
		actorIp?: string | null;
		/** Instant of the migration, defaults to now */
		now?: number;
	}): UserRecord;
	/** All users, optionally including the deactivated ones */
	list(options?: { includeInactive?: boolean }): UserRecord[];
	/** Changes a user and audits the changed fields */
	update(input: UpdateUserInput): UserRecord;
	/** Role keys of a user (sorted) */
	roles(userId: number): string[];
	/** All roles with their permission keys, sorted by key */
	roleCatalog(): { key: string; name: string; permissions: string[] }[];
	/** Replaces the roles of a user */
	setRoles(input: {
		userId: number;
		roleKeys: string[];
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): string[];
	/** Effective permission keys of a user (sorted) */
	permissions(userId: number): string[];
	/** Checks whether a user holds all given permissions */
	hasPermissions(userId: number, required: string[]): boolean;
	/** Work profile of a user, `null` when none is stored */
	getWorkProfile(userId: number): WorkProfileRecord | null;
	/** Creates or updates the work profile */
	saveWorkProfile(input: {
		userId: number;
		profile: Partial<Omit<WorkProfileRecord, "userId">>;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): WorkProfileRecord;
	/** Stores the instant of the last successful login */
	recordLogin(userId: number, now?: number): void;
}

interface UserRow {
	id: number;
	login: string;
	password_hash: string;
	legacy_sha1: string | null;
	display_name: string;
	email: string | null;
	rfid_card: string | null;
	is_active: number;
	must_change_pw: number;
	locale: string;
	timezone: string;
	pin_hash: string | null;
	avatar: string | null;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
}

interface WorkProfileRow {
	user_id: number;
	percent: number;
	weekly_hours: number;
	workdays: string;
	start_date: number | null;
	end_date: number | null;
	overtime_carryover: number;
	vorholzeit_per_year: number;
	vacation_carryover: number;
	vacation_per_year: number;
	overtime_model: OvertimeModel;
	holiday_flags: string | null;
	legacy_source: string | null;
}

/**
 * Maps a database row to a user record.
 *
 * @param row - raw database row
 * @returns user record
 */
export function mapUserRow(row: UserRow): UserRecord {
	return {
		id: row.id,
		login: row.login,
		passwordHash: row.password_hash,
		legacySha1: row.legacy_sha1,
		displayName: row.display_name,
		email: row.email,
		rfidCard: row.rfid_card,
		isActive: row.is_active !== 0,
		mustChangePw: row.must_change_pw !== 0,
		locale: row.locale,
		timezone: row.timezone,
		pinHash: row.pin_hash,
		avatar: row.avatar,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastLoginAt: row.last_login_at,
	};
}

/**
 * Maps a database row to a work profile record.
 *
 * @param row - raw database row
 * @returns work profile record
 */
export function mapWorkProfileRow(row: WorkProfileRow): WorkProfileRecord {
	return {
		userId: row.user_id,
		percent: row.percent,
		weeklyHours: row.weekly_hours,
		workdays: row.workdays,
		startDate: row.start_date,
		endDate: row.end_date,
		overtimeCarryover: row.overtime_carryover,
		vorholzeitPerYear: row.vorholzeit_per_year,
		vacationCarryover: row.vacation_carryover,
		vacationPerYear: row.vacation_per_year,
		overtimeModel: row.overtime_model,
		holidayFlags: row.holiday_flags,
		legacySource: row.legacy_source,
	};
}

const USER_COLUMNS = `id, login, password_hash, legacy_sha1, display_name, email, rfid_card, is_active,
\tmust_change_pw, locale, timezone, pin_hash, avatar, created_at, updated_at, last_login_at`;

const PROFILE_COLUMNS = `user_id, percent, weekly_hours, workdays, start_date, end_date, overtime_carryover,
\tvorholzeit_per_year, vacation_carryover, vacation_per_year, overtime_model, holiday_flags, legacy_source`;

/** Field names of a user that are compared for the audit trail (the password is reported separately). */
const AUDITED_USER_FIELDS: (keyof UserRecord)[] = [
	"login",
	"displayName",
	"email",
	"rfidCard",
	"isActive",
	"mustChangePw",
	"locale",
	"timezone",
];

/** Field names of a work profile that are compared for the audit trail. */
/** Field names of a work profile that are compared for the audit trail. */
const AUDITED_PROFILE_FIELDS: (keyof WorkProfileRecord)[] = [
	"percent",
	"weeklyHours",
	"workdays",
	"startDate",
	"endDate",
	"overtimeCarryover",
	"vorholzeitPerYear",
	"vacationCarryover",
	"vacationPerYear",
	"overtimeModel",
	"holidayFlags",
];

/**
 * Creates the user repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createUsersRepository(db: Db): UsersRepository {
	const selectById = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`);
	const selectByLogin = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE login = ? COLLATE NOCASE`);
	const selectByRfid = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE rfid_card = ? COLLATE NOCASE LIMIT 1`);
	const setPinHash = db.prepare("UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?");
	const setAvatarData = db.prepare("UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?");
	// the legacy hash is cleared in the same statement, so it cannot be replayed afterwards
	const migrateLegacyHash = db.prepare(
		"UPDATE users SET password_hash = ?, legacy_sha1 = NULL, must_change_pw = ?, updated_at = ? WHERE id = ?",
	);
	const selectAll = db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY display_name COLLATE NOCASE, id`);
	const selectActive = db.prepare(
		`SELECT ${USER_COLUMNS} FROM users WHERE is_active = 1 ORDER BY display_name COLLATE NOCASE, id`,
	);
	const insertUser = db.prepare(
		`INSERT INTO users
		 (login, password_hash, legacy_sha1, display_name, email, rfid_card, is_active, must_change_pw,
		  locale, timezone, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateUser = db.prepare(
		`UPDATE users SET display_name = ?, email = ?, locale = ?, timezone = ?, rfid_card = ?,
		     is_active = ?, must_change_pw = ?, password_hash = ?, updated_at = ?
		 WHERE id = ?`,
	);
	const updateLastLogin = db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?");
	const insertDefaultProfile = db.prepare("INSERT OR IGNORE INTO work_profiles (user_id) VALUES (?)");
	const selectProfile = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM work_profiles WHERE user_id = ?`);
	const upsertProfile = db.prepare(
		`INSERT INTO work_profiles (${PROFILE_COLUMNS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		     percent = excluded.percent,
		     weekly_hours = excluded.weekly_hours,
		     workdays = excluded.workdays,
		     start_date = excluded.start_date,
		     end_date = excluded.end_date,
		     overtime_carryover = excluded.overtime_carryover,
		     vorholzeit_per_year = excluded.vorholzeit_per_year,
		     vacation_carryover = excluded.vacation_carryover,
		     vacation_per_year = excluded.vacation_per_year,
		     overtime_model = excluded.overtime_model,
		     holiday_flags = excluded.holiday_flags,
		     legacy_source = excluded.legacy_source`,
	);
	const selectRoles = db.prepare(
		`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key`,
	);
	const selectRoleId = db.prepare("SELECT id FROM roles WHERE key = ?");
	const deleteRoles = db.prepare("DELETE FROM user_roles WHERE user_id = ?");
	const insertRole = db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)");
	const selectPermissions = db.prepare(
		`SELECT DISTINCT p.key FROM user_roles ur
		 JOIN role_permissions rp ON rp.role_id = ur.role_id
		 JOIN permissions p ON p.id = rp.permission_id
		 WHERE ur.user_id = ? ORDER BY p.key`,
	);
	const selectRoleCatalog = db.prepare(
		`SELECT r.key AS key, r.name AS name, p.key AS permission
		 FROM roles r
		 LEFT JOIN role_permissions rp ON rp.role_id = r.id
		 LEFT JOIN permissions p ON p.id = rp.permission_id
		 ORDER BY r.key, p.key`,
	);

	const read = (id: number): UserRecord | null => {
		const row = selectById.get(id) as UserRow | undefined;
		return row ? mapUserRow(row) : null;
	};

	const readProfile = (userId: number): WorkProfileRecord | null => {
		const row = selectProfile.get(userId) as WorkProfileRow | undefined;
		return row ? mapWorkProfileRow(row) : null;
	};

	/**
	 * Defaults of a fresh work profile (identical to the column defaults of the schema).
	 *
	 * @param userId - owner of the profile
	 */
	const defaultProfile = (userId: number): WorkProfileRecord => ({
		userId,
		percent: 100,
		weeklyHours: 42.5,
		workdays: "0;1;1;1;1;1;0",
		startDate: null,
		endDate: null,
		overtimeCarryover: 0,
		vorholzeitPerYear: 0,
		vacationCarryover: 0,
		vacationPerYear: 0,
		overtimeModel: "monthly",
		holidayFlags: null,
		legacySource: null,
	});

	const resolveRoleIds = (roleKeys: string[]): number[] =>
		roleKeys.map(key => {
			const row = selectRoleId.get(key) as { id: number } | undefined;
			if (!row) {
				throw new UnknownRoleError(key);
			}
			return row.id;
		});

	const writeRoles = (userId: number, roleIds: number[]): void => {
		deleteRoles.run(userId);
		for (const roleId of roleIds) {
			insertRole.run(userId, roleId);
		}
	};

	return {
		create(input: CreateUserInput): UserRecord {
			const login = input.login.trim();
			if (!login) {
				throw new ValidationError("login must not be empty");
			}
			const existing = selectByLogin.get(login) as UserRow | undefined;
			if (existing) {
				throw new LoginExistsError(login);
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const roleKeys = input.roleKeys ?? [];
			const roleIds = resolveRoleIds(roleKeys);

			let userId = 0;
			const run = db.transaction((): void => {
				const result = insertUser.run(
					login,
					input.passwordHash ?? "",
					input.legacySha1 ?? null,
					input.displayName,
					input.email ?? null,
					input.rfidCard ?? null,
					1,
					input.mustChangePw === true ? 1 : 0,
					input.locale ?? "de-DE",
					input.timezone ?? "Europe/Berlin",
					now,
					now,
				);
				userId = Number(result.lastInsertRowid);
				insertDefaultProfile.run(userId);
				writeRoles(userId, roleIds);

				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId ?? null,
					action: "user.create",
					entity: "user",
					entityId: userId,
					detail: { login, displayName: input.displayName, roles: roleKeys.slice().sort() },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const created = read(userId);
			if (!created) {
				throw new Error(`user ${userId} disappeared right after creation`);
			}
			return created;
		},

		findById: read,

		findByLogin(login: string): UserRecord | null {
			const row = selectByLogin.get(login.trim()) as UserRow | undefined;
			return row ? mapUserRow(row) : null;
		},

		findByRfidCard(card: string): UserRecord | null {
			const row = selectByRfid.get(card.trim()) as UserRow | undefined;
			return row ? mapUserRow(row) : null;
		},

		setPin(input: {
			userId: number;
			pinHash: string | null;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): void {
			if (!read(input.userId)) {
				throw new NotFoundError(`user ${input.userId} not found`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				setPinHash.run(input.pinHash, now, input.userId);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "user.pin",
					entity: "user",
					entityId: input.userId,
					// the hash itself never reaches the audit trail
					detail: { cleared: input.pinHash === null },
					ip: input.actorIp ?? null,
				});
			});
			run();
		},

		setAvatar(input: {
			userId: number;
			avatar: string | null;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): void {
			if (!read(input.userId)) {
				throw new NotFoundError(`user ${input.userId} not found`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				setAvatarData.run(input.avatar, now, input.userId);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "user.avatar",
					entity: "user",
					entityId: input.userId,
					// the picture itself never reaches the audit trail
					detail: { cleared: input.avatar === null },
					ip: input.actorIp ?? null,
				});
			});
			run();
		},

		migrateLegacyPassword(input: {
			userId: number;
			passwordHash: string;
			mustChangePw: boolean;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): UserRecord {
			if (!read(input.userId)) {
				throw new NotFoundError(`user ${input.userId} not found`);
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				migrateLegacyHash.run(input.passwordHash, input.mustChangePw ? 1 : 0, now, input.userId);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "user.legacy_password_migrated",
					entity: "user",
					entityId: input.userId,
					// the hashes themselves never reach the audit trail
					detail: { mustChangePw: input.mustChangePw },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.userId);
			if (!updated) {
				throw new NotFoundError(`user ${input.userId} not found`);
			}
			return updated;
		},

		list(options?: { includeInactive?: boolean }): UserRecord[] {
			const rows = (options?.includeInactive === true ? selectAll : selectActive).all() as UserRow[];
			return rows.map(mapUserRow);
		},

		update(input: UpdateUserInput): UserRecord {
			const current = read(input.id);
			if (!current) {
				throw new NotFoundError(`user ${input.id} not found`);
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const next: UserRecord = {
				...current,
				displayName: input.patch.displayName ?? current.displayName,
				email: input.patch.email === undefined ? current.email : input.patch.email,
				locale: input.patch.locale ?? current.locale,
				timezone: input.patch.timezone ?? current.timezone,
				rfidCard: input.patch.rfidCard === undefined ? current.rfidCard : input.patch.rfidCard,
				isActive: input.patch.isActive ?? current.isActive,
				mustChangePw: input.patch.mustChangePw ?? current.mustChangePw,
				passwordHash: input.patch.passwordHash ?? current.passwordHash,
			};

			const changes = diffFields(
				current as unknown as Record<string, unknown>,
				next as unknown as Record<string, unknown>,
				AUDITED_USER_FIELDS as unknown as (keyof Record<string, unknown>)[],
			);
			const passwordChanged = next.passwordHash !== current.passwordHash;
			if (Object.keys(changes).length === 0 && !passwordChanged) {
				// nothing to do, keep `updated_at` untouched
				return current;
			}

			const action =
				!current.isActive && next.isActive
					? "user.activate"
					: current.isActive && !next.isActive
						? "user.deactivate"
						: "user.update";

			const run = db.transaction((): void => {
				updateUser.run(
					next.displayName,
					next.email,
					next.locale,
					next.timezone,
					next.rfidCard,
					next.isActive ? 1 : 0,
					next.mustChangePw ? 1 : 0,
					next.passwordHash,
					now,
					input.id,
				);

				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action,
					entity: "user",
					entityId: input.id,
					// never write the password hash into the audit trail
					detail: { changes, passwordChanged, reason: input.reason ?? null },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const updated = read(input.id);
			if (!updated) {
				throw new Error(`user ${input.id} disappeared right after the update`);
			}
			return updated;
		},

		roles(userId: number): string[] {
			return (selectRoles.all(userId) as { key: string }[]).map(row => row.key);
		},

		roleCatalog(): { key: string; name: string; permissions: string[] }[] {
			const rows = selectRoleCatalog.all() as { key: string; name: string; permission: string | null }[];
			const catalog = new Map<string, { key: string; name: string; permissions: string[] }>();
			for (const row of rows) {
				const entry = catalog.get(row.key) ?? { key: row.key, name: row.name, permissions: [] };
				if (row.permission) {
					entry.permissions.push(row.permission);
				}
				catalog.set(row.key, entry);
			}
			return [...catalog.values()];
		},

		setRoles(input: {
			userId: number;
			roleKeys: string[];
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): string[] {
			if (!read(input.userId)) {
				throw new NotFoundError(`user ${input.userId} not found`);
			}
			// resolve (and validate) all keys before the first write
			const roleIds = resolveRoleIds(input.roleKeys);
			const before = this.roles(input.userId);
			const after = input.roleKeys.slice().sort();

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				writeRoles(input.userId, roleIds);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "user.roles",
					entity: "user",
					entityId: input.userId,
					detail: { old: before, new: after },
					ip: input.actorIp ?? null,
				});
			});
			run();

			return this.roles(input.userId);
		},

		permissions(userId: number): string[] {
			return (selectPermissions.all(userId) as { key: string }[]).map(row => row.key);
		},

		hasPermissions(userId: number, required: string[]): boolean {
			const granted = new Set(this.permissions(userId));
			return required.every(permission => granted.has(permission));
		},

		getWorkProfile: readProfile,

		saveWorkProfile(input: {
			userId: number;
			profile: Partial<Omit<WorkProfileRecord, "userId">>;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): WorkProfileRecord {
			const current = readProfile(input.userId);
			const base = current ?? defaultProfile(input.userId);
			const next: WorkProfileRecord = { ...base, ...input.profile, userId: input.userId };

			const changes = diffFields(
				base as unknown as Record<string, unknown>,
				next as unknown as Record<string, unknown>,
				AUDITED_PROFILE_FIELDS as unknown as (keyof Record<string, unknown>)[],
			);
			if (current && Object.keys(changes).length === 0) {
				return current;
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				upsertProfile.run(
					next.userId,
					next.percent,
					next.weeklyHours,
					next.workdays,
					next.startDate,
					next.endDate,
					next.overtimeCarryover,
					next.vorholzeitPerYear,
					next.vacationCarryover,
					next.vacationPerYear,
					next.overtimeModel,
					next.holidayFlags,
					next.legacySource,
				);

				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "user.profile",
					entity: "work_profile",
					entityId: input.userId,
					detail: { created: current === null, changes },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const saved = readProfile(input.userId);
			if (!saved) {
				throw new Error(`work profile of user ${input.userId} disappeared right after the update`);
			}
			return saved;
		},

		recordLogin(userId: number, now?: number): void {
			updateLastLogin.run(now ?? Math.floor(Date.now() / 1000), userId);
		},
	};
}
