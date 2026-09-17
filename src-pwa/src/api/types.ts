/**
 * Shapes of the API responses the web app uses.
 *
 * They mirror the JSON of the adapter's REST API (mounted below `/api`). Times are UTC epoch seconds, durations
 * are whole minutes — the translation into the user's time zone happens in the UI.
 */

/** Day aggregate as the API returns it. */
export interface DayAggregate {
	userId: number;
	localDate: string;
	workedMin: number;
	breakMin: number;
	targetMin: number;
	balanceMin: number;
	absenceCode: string | null;
	isHoliday: boolean;
	firstInUtc: number | null;
	lastOutUtc: number | null;
	hasOpenEntry: boolean;
	updatedAt: number;
}

/** Month aggregate as the API returns it. */
export interface MonthAggregate {
	userId: number;
	year: number;
	month: number;
	workedMin: number;
	targetMin: number;
	balanceMin: number;
	overtimeMin: number;
	vacationDays: number;
	updatedAt: number;
}

/** Year aggregate as the API returns it. */
export interface YearAggregate {
	userId: number;
	year: number;
	workedMin: number;
	targetMin: number;
	balanceMin: number;
	overtimeMin: number;
	vacationDays: number;
	vacationUsed: number;
	vacationCarryover: number;
	updatedAt: number;
}

/** A stored punch. */
export interface Entry {
	id: number;
	userId: number;
	tsUtc: number;
	clientTsUtc: number | null;
	localDate: string;
	direction: "in" | "out";
	source: string;
	note: string | null;
	revision: number;
	syncState: string;
}

/** Branding of the installation, as `GET /branding` returns it. */
export interface Branding {
	/** Accent colour (`#rrggbb`), `null` when none is configured */
	color: string | null;
	/** Address of the company logo, `null` when none is stored */
	logoUrl: string | null;
	/** Address of the background picture, `null` when none is stored */
	backgroundUrl: string | null;
}

/** One change of a punch, as `GET /entries/:id/audit` reports it. */
export interface EntryAuditRow {
	/** Id of the audit row */
	id: number;
	/** Kind of change: `create`, `update` or `delete` */
	action: string;
	/** Changed fields with their old and new value, `null` when nothing was compared */
	changes: Record<string, { old: unknown; new: unknown }> | null;
	/** Revision after the change */
	revision: number | null;
	/** Why the change was made (corrections carry one, normal punches do not) */
	reason: string | null;
	/** Who made the change (`0` means the adapter itself) */
	actorId: number;
	/** Shown name of that actor, `null` when it is no longer known */
	actorName: string | null;
	/** Instant of the change, UTC epoch seconds */
	atUtc: number;
}

/** Result of a punch. */
export interface PunchResult {
	entry: Entry;
	created: boolean;
	day: DayAggregate;
	rounded?: { from: number; to: number; roundMinutes: number };
}

/** A payout as `GET /payouts` returns it. */
export interface Payout {
	id: number;
	userId: number;
	year: number;
	month: number | null;
	minutes: number;
	amount: number | null;
	note: string | null;
	createdAt: number;
	createdBy: number | null;
}

/** Current status of the caller, as `GET /punch/status` answers it. */
export interface PunchStatus {
	date: string;
	day: DayAggregate;
	hasOpenEntry: boolean;
	lastEntry: Entry | null;
	nextDirection: "in" | "out";
}

/** A day range, as `GET /aggregates/day?from=&to=` answers it. */
export interface DayRange {
	from: string;
	to: string;
	days: DayAggregate[];
	workedMin: number;
	targetMin: number;
	balanceMin: number;
	openDays: number;
}

/** An absence. */
export interface Absence {
	id: number;
	userId: number;
	typeCode: string;
	typeName?: string;
	dateFrom: string;
	dateTo: string;
	dayPortion: number;
	hours: number | null;
	status: string;
	note: string | null;
}

/** An absence type as `GET /absence-types` returns it. */
export interface AbsenceType {
	id: number;
	userId: number | null;
	code: string;
	name: string;
	paid: boolean;
	factor: number;
	reduceVacation: boolean;
	isActive: boolean;
}

/** An open synchronisation conflict. */
export interface Conflict {
	id: number;
	entryId?: number;
	userId: number;
	localDate: string;
	tsUtc: number;
	clientTsUtc: number | null;
	note: string | null;
}

/** An employee as the administration sees it. */
export interface AdminUser {
	/** Database id */
	id: number;
	/** Login name */
	login: string;
	/** Shown name */
	displayName: string;
	/** Optional e-mail */
	email: string | null;
	/** Badge code, when one is stored */
	rfidCard: string | null;
	/** False for deactivated accounts */
	isActive: boolean;
	/** True when the user has to change the password at the next sign in */
	mustChangePw: boolean;
	/** Language of the user */
	locale: string;
	/** Time zone of the user */
	timezone: string;
	/** Role keys of the user */
	roles: string[];
	/** Address of the picture of the employee, `null` when none is stored */
	avatarUrl: string | null;
}

/** A role of the catalogue. */
export interface RoleInfo {
	/** Stable key, e.g. `admin` */
	key: string;
	/** Shown name */
	name: string;
	/** Permissions the role grants */
	permissions: string[];
}

/** Employment parameters of an employee (`work_profiles`). */
export interface WorkProfile {
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
	overtimeModel: "cumulative" | "yearly" | "monthly";
	/** Country specific holiday flags (JSON), `null` = instance default */
	holidayFlags: string | null;
	/** Minutes of the break per day that are paid (0 = the break is not paid at all) */
	pausePaidMinutes: number;
}

/** One database backup. */
export interface BackupFile {
	/** File name */
	name: string;
	/** Size in bytes */
	sizeBytes: number;
	/** Instant it belongs to, UTC epoch seconds */
	createdAt: number;
}

/** A restore that waits for the next start of the adapter. */
export interface PendingRestore {
	/** Name of the file that will be applied */
	name: string;
	/** Who queued it, `null` for the system */
	actorId: number | null;
	/** Instant it was queued, UTC epoch seconds */
	queuedAt: number;
	/** Size in bytes */
	sizeBytes: number;
	/** Number of employees in the file */
	users: number;
	/** Number of punches in the file */
	entries: number;
}

/** Input for creating an employee. */
export interface CreateUserInput {
	/** Login name */
	login: string;
	/** Shown name */
	displayName: string;
	/** Initial password */
	password: string;
	/** Roles of the new account */
	roleKeys: string[];
}

/** Changeable fields of an employee. */
export interface UpdateUserInput {
	/** Shown name */
	displayName?: string;
	/** Activates or deactivates the account */
	isActive?: boolean;
	/** Roles of the account */
	roleKeys?: string[];
	/** New password */
	password?: string;
	/** Data URL of a new picture, `null` removes the stored one */
	avatar?: string | null;
}

/** The caller as `GET /auth/me` reports it. */
export interface SessionUser {
	id: number;
	login: string;
	displayName: string;
	timezone: string;
	language: string;
	isActive: boolean;
	/** True while the start password (or a password from the old system) still has to be replaced */
	mustChangePw: boolean;
}

/** Result of a login. */
export interface LoginResult {
	token: string;
	csrfToken: string;
	expiresAt: number;
	user: SessionUser;
}
