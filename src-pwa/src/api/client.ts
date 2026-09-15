/**
 * API client of the web app.
 *
 * The app calls the REST API of the adapter below `/api`. The session token travels in the `x-session-token`
 * header, the CSRF token in `x-csrf-token` (the server requires it for every write). Errors arrive as RFC 9457
 * problem documents; they keep their stable `code`, so the UI can translate them.
 *
 * The session is kept in `localStorage`: the app is a single page application without server side rendering, and
 * the token is bound to the device. A `401` clears it, so the app falls back to the login screen.
 */

import type {
	Absence,
	AbsenceType,
	AdminUser,
	BackupFile,
	Conflict,
	CreateUserInput,
	DayRange,
	Entry,
	LoginResult,
	MonthAggregate,
	Payout,
	PunchResult,
	PunchStatus,
	RoleInfo,
	SessionUser,
	UpdateUserInput,
	YearAggregate,
} from "./types";

/** Prefix the API is mounted on. */
export const API_PREFIX = "/api";

/** Storage key of the session. */
const STORAGE_KEY = "zeiterfassung.session";

/** An error as the API reports it. */
export class ApiError extends Error {
	/** HTTP status code (`0` for a network failure) */
	public readonly status: number;

	/** Stable error code of the problem document */
	public readonly code: string;

	/** Optional explanation */
	public readonly detail?: string;

	/**
	 * Creates the error.
	 *
	 * @param status - HTTP status code
	 * @param code - stable error code
	 * @param detail - optional explanation
	 */
	constructor(status: number, code: string, detail?: string) {
		super(`${status} ${code}${detail ? `: ${detail}` : ""}`);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}

/** Stored session. */
export interface StoredSession {
	/**
	 * Session token — only present for sessions that were created before the cookie switch (an older tab).
	 * New sessions keep the credential in an `httpOnly` cookie, where no script inside the page can read it.
	 */
	token?: string;
	/** CSRF token for writes */
	csrfToken: string;
	/** Expiry, UTC epoch seconds */
	expiresAt: number;
	/** The logged in user */
	user: SessionUser;
}

/** The API client. */
export interface ApiClient {
	/** Current session or `null` */
	session(): StoredSession | null;
	/** URL of the live event stream (`null` without a session) */
	streamUrl(): string | null;
	/** Logs in and stores the session */
	login(login: string, password: string): Promise<StoredSession>;
	/** Ends the session on the server and locally */
	logout(): Promise<void>;
	/** Forgets the local session (for example after a `401`) */
	forget(): void;
	/** Current user, roles and permissions */
	me(): Promise<{ user: SessionUser | null; permissions: string[]; expiresAt?: number }>;
	/** Changes the own password; all sessions end afterwards */
	changePassword(password: string): Promise<void>;
	/** Punches, optionally rounded to the quick step */
	punch(options?: { quick?: boolean; tsUtc?: number; note?: string; idempotencyKey?: string }): Promise<PunchResult>;
	/** Status of the day and the next direction */
	status(): Promise<PunchStatus>;
	/** Days of a local date range */
	days(from: string, to: string): Promise<DayRange>;
	/** A month plus the totals of its year */
	month(year: number, month: number): Promise<{ month: MonthAggregate; year: YearAggregate }>;
	/** The twelve months of a year */
	months(year: number): Promise<{ year: YearAggregate; months: (MonthAggregate | null)[] }>;
	/** Year totals */
	year(year: number): Promise<YearAggregate>;
	/** Paid out overtime of a year (own account) */
	payouts(year: number): Promise<{ totalMinutes: number; payouts: Payout[] }>;
	/** Punches of a range */
	entries(from: string, to: string): Promise<Entry[]>;
	/** Absences of a year */
	absences(year: number): Promise<Absence[]>;
	/** Absence types the caller may use */
	absenceTypes(): Promise<AbsenceType[]>;
	/** Requests an absence */
	createAbsence(input: {
		typeCode: string;
		dateFrom: string;
		dateTo?: string;
		dayPortion?: number;
		note?: string;
	}): Promise<Absence>;
	/** Sends queued punches of the offline queue */
	sync(punches: { idempotencyKey: string; tsUtc: number; direction?: string; note?: string }[]): Promise<{
		accepted: number;
		duplicates: number;
		conflicts: number;
		recalculated: string[];
	}>;
	/** Open conflicts */
	conflicts(): Promise<Conflict[]>;
	/** Resolves a conflict */
	resolve(entryId: number, action: "accept" | "dismiss", reason?: string): Promise<unknown>;
	/** Downloads the monthly work time statement of the own account */
	downloadReport(kind: "xls" | "pdf", year: number, month: number): Promise<DownloadFile>;
	/** Employees, optionally including the deactivated ones */
	users(includeInactive?: boolean): Promise<AdminUser[]>;
	/** Role catalogue */
	roles(): Promise<RoleInfo[]>;
	/** Creates an employee */
	createUser(input: CreateUserInput): Promise<AdminUser>;
	/** Changes an employee */
	updateUser(id: number, patch: UpdateUserInput): Promise<AdminUser>;
	/** Sets the badge PIN of an employee (empty value removes it) */
	setPin(id: number, pin: string): Promise<void>;
	/** Kiosk terminals including the revoked ones */
	terminals(): Promise<AdminTerminal[]>;
	/** Creates a terminal; the device token is part of the answer exactly once */
	createTerminal(input: {
		name: string;
		location?: string;
		pinRequired?: boolean;
	}): Promise<{ terminal: AdminTerminal; deviceToken: string }>;
	/** Revokes a terminal, its device token stops working immediately */
	revokeTerminal(id: number): Promise<void>;
	/** Instance settings, keyed by their technical name */
	settings(): Promise<Record<string, string>>;
	/** Changes instance settings (only editable keys are accepted) */
	updateSettings(patch: Record<string, string>): Promise<Record<string, string>>;
	/** The last legacy import runs */
	importRuns(): Promise<ImportRunRecord[]>;
	/** Public holidays of a year, optionally limited to a region */
	holidays(year: number, region?: string): Promise<HolidayRecord[]>;
	/** Adds a public holiday */
	createHoliday(input: { date: string; name: string; region?: string }): Promise<HolidayRecord>;
	/** Removes a public holiday */
	deleteHoliday(id: number): Promise<void>;
	/** Signed badge/NFC tags */
	rfidTags(): Promise<RfidTagRecord[]>;
	/** Creates a tag; the link to write onto it is part of the answer */
	createTag(input: {
		userId: number;
		label?: string;
		ttlDays?: number;
	}): Promise<{ tag: RfidTagRecord; url: string }>;
	/** Deletes a tag */
	deleteTag(id: number): Promise<void>;
	/** Figures of a date range, per employee and in total */
	statistics(from: string, to: string, userId?: number): Promise<StatisticsResult>;
	/** Redeems a scanned badge link (public, no session needed) */
	scanTag(token: string): Promise<ScanResult>;
	/** Starts a legacy import run */
	runImport(input: {
		baseDir?: string;
		mode: "dry-run" | "commit";
		resetImport?: boolean;
		timezone?: string;
	}): Promise<ImportReport>;
	/** Known database backups and the retention */
	backups(): Promise<{ retentionDays: number; backups: BackupFile[] }>;
	/** Takes a database backup */
	createBackup(): Promise<{ backup: BackupFile; removed: string[] }>;
	/** Status of the kiosk terminal */
	terminalStatus(): Promise<TerminalStatus>;
	/** Exchanges the device token of a terminal for a short lived terminal session */
	terminalSession(deviceToken: string): Promise<TerminalSessionResult>;
	/** Employees the terminal may punch for */
	terminalUsers(terminalSession: string): Promise<{ users: TerminalUser[] }>;
	/** Punches for an employee (badge or user plus PIN) */
	terminalPunch(input: {
		terminalSession: string;
		badge?: string;
		userId?: number;
		pin?: string;
	}): Promise<TerminalPunchResult>;
	/** Keeps the terminal session alive */
	terminalHeartbeat(
		terminalSession: string,
	): Promise<{ status: string; serverTime: number; timezone: string; expiresAt: number }>;
}

/** A downloaded file. */
export interface DownloadFile {
	/** Content of the file */
	blob: Blob;
	/** File name the API suggests */
	fileName: string;
}

/** Status of the kiosk terminal (`GET /terminal/status`). */
export interface TerminalStatus {
	/** True when the terminal is switched on in the adapter settings */
	enabled: boolean;
	/** Server time, UTC epoch seconds */
	serverTime: number;
	/** Time zone the terminal displays its clock in */
	timezone: string;
	/** Adapter version */
	version: string;
}

/** A terminal session (`POST /terminal/session`). */
export interface TerminalSessionResult {
	/** Short lived session of this device */
	terminalSession: string;
	/** Instant the session expires, UTC epoch seconds */
	expiresAt: number;
	/** Device the session belongs to */
	terminal: { name: string; location: string | null; pinRequired: boolean };
}

/** Minimal employee entry of the terminal (`GET /terminal/users`). */
export interface TerminalUser {
	/** Database id */
	id: number;
	/** Shown name */
	displayName: string;
}

/** Result of a punch at the terminal (`POST /terminal/punch`). */
export interface TerminalPunchResult {
	/** Employee the punch belongs to */
	user: { id: number; displayName: string };
	/** The stored punch */
	entry: { id: number; tsUtc: number; direction: "in" | "out" | "auto"; localDate: string };
	/** Figures of that day */
	day: { workedMin: number; targetMin: number; balanceMin: number; hasOpenEntry: boolean };
}

/** A kiosk terminal as the administration sees it (`GET /terminals`). */
export interface AdminTerminal {
	/** Primary key */
	id: number;
	/** Display name */
	name: string;
	/** Optional location */
	location: string | null;
	/** True when a badge has to be combined with the personal PIN */
	pinRequired: boolean;
	/** False for revoked devices */
	isActive: boolean;
	/** Instant the device token expires, `null` = never */
	expiresAt: number | null;
	/** Instant of the last heartbeat */
	lastSeenAt: number | null;
	/** Instant of creation */
	createdAt: number;
}

/** A legacy import run as the administration sees it (`GET /import/runs`). */
export interface ImportRunRecord {
	/** Primary key of the `import_runs` row */
	id: number;
	/** Source system, e.g. `smalltime` */
	source: string;
	/** Folder that was read */
	sourcePath: string | null;
	/** Instant the run started, UTC epoch seconds */
	startedAt: number;
	/** Instant the run finished, `null` while it is running */
	finishedAt: number | null;
	/** `dry-run` or `commit` */
	mode: string;
	/** `ok`, `mismatch` or `failed` */
	status: string;
	/** Time zone the legacy punches were interpreted in */
	timezoneAssumed: string | null;
	/** Counters as stored JSON text */
	stats: string | null;
	/** Warnings as stored JSON text */
	warnings: string | null;
	/** Employee that started the run */
	actorId: number | null;
}

/** The report of a legacy import run (`POST /import/run`). */
export interface ImportReport {
	/** Id of the `import_runs` row */
	runId: number;
	/** Mode the run was started with */
	mode: string;
	/** Outcome of the run */
	status: string;
	/** Installation folder that was read */
	baseDir: string;
	/** Time zone the punches were interpreted in */
	timezoneAssumed: string;
	/** Counters of the run */
	stats: Record<string, number>;
	/** Remarks, including the ones of the parsers */
	warnings: string[];
}

/** A public holiday (`GET /holidays`). */
export interface HolidayRecord {
	/** Primary key */
	id: number;
	/** Date (`YYYY-MM-DD`) */
	date: string;
	/** Name of the holiday */
	name: string;
	/** Region it belongs to, `null` for all */
	region: string | null;
}

/** A signed badge/NFC tag (`GET /rfid/tags`). */
export interface RfidTagRecord {
	/** Primary key */
	id: number;
	/** Uid written on the tag */
	uid: string | null;
	/** Employee the tag belongs to */
	userId: number;
	/** Optional label */
	label: string | null;
	/** Instant the link on the tag expires, UTC epoch seconds */
	expiresAt: number | null;
	/** Instant of creation */
	createdAt: number;
}

/** One employee row of the statistics (`GET /reports/statistics`). */
export interface StatisticsRow {
	/** Employee id */
	userId: number;
	/** Shown name */
	displayName: string;
	/** Minutes worked in the range */
	workedMin: number;
	/** Target minutes of the range */
	targetMin: number;
	/** Balance in minutes (worked minus target) */
	balanceMin: number;
	/** Days of the range that are still open */
	openDays: number;
}

/** Result of the statistics (`GET /reports/statistics`). */
export interface StatisticsResult {
	/** First day of the range */
	from: string;
	/** Last day of the range */
	to: string;
	/** One row per employee */
	users: StatisticsRow[];
	/** Sum over all shown employees */
	totals: { workedMin: number; targetMin: number; balanceMin: number; openDays: number };
}

/** Result of a scanned badge (`POST /rfid/scan`). */
export interface ScanResult {
	/** Employee the punch belongs to */
	user?: { id: number; displayName: string };
	/** The stored punch */
	entry?: { tsUtc: number; direction: string; localDate: string };
	/** Figures of that day */
	day?: { workedMin: number; targetMin: number; balanceMin: number; hasOpenEntry: boolean };
}

/**
 * Builds a query string.
 *
 * @param query - parameters, `null`/`undefined` are skipped
 * @returns query string starting with `?` or an empty string
 */
export function buildQuery(query: Record<string, string | number | boolean | null | undefined> = {}): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === null || value === undefined) {
			continue;
		}
		search.set(key, String(value));
	}
	const encoded = search.toString();
	return encoded ? `?${encoded}` : "";
}

/**
 * Creates the API client.
 *
 * @param storage - storage used for the session (defaults to `localStorage`)
 * @returns the client
 */
export function createApiClient(storage: Storage = window.localStorage): ApiClient {
	/**
	 * Reads the stored session.
	 *
	 * @param store - storage
	 * @returns session or `null`
	 */
	function readSession(store: Storage): StoredSession | null {
		try {
			const raw = store.getItem(STORAGE_KEY);
			if (!raw) {
				return null;
			}
			const parsed = JSON.parse(raw) as StoredSession;
			// a session without a token is fine: the credential itself lives in the httpOnly cookie
			return parsed?.user ? parsed : null;
		} catch {
			return null;
		}
	}

	let cached: StoredSession | null = readSession(storage);

	/**
	 * Stores the session.
	 *
	 * @param session - session or `null` to remove it
	 */
	function writeSession(session: StoredSession | null): void {
		cached = session;
		if (!session) {
			storage.removeItem(STORAGE_KEY);
			return;
		}
		storage.setItem(STORAGE_KEY, JSON.stringify(session));
	}

	/**
	 * Sends a request through the API.
	 *
	 * @param method - HTTP method
	 * @param path - path below `/api`
	 * @param options - body, query and headers
	 * @param options.body - body object (serialised as JSON)
	 * @param options.query - query parameters
	 * @param options.anonymous - true to send without the session
	 * @param options.headers - additional headers
	 * @returns parsed response body
	 */
	async function request<T>(
		method: string,
		path: string,
		options: {
			body?: unknown;
			query?: Record<string, string | number | boolean | null | undefined>;
			anonymous?: boolean;
			headers?: Record<string, string>;
		} = {},
	): Promise<T> {
		const headers: Record<string, string> = { ...(options.headers ?? {}) };
		if (options.body !== undefined) {
			headers["content-type"] = "application/json";
		}
		if (!options.anonymous && cached) {
			if (cached.token) {
				// only sessions from before the cookie switch still carry the token in storage
				headers["x-session-token"] = cached.token;
			}
			headers["x-csrf-token"] = cached.csrfToken;
		}

		let response: Response;
		try {
			response = await fetch(`${API_PREFIX}${path}${buildQuery(options.query)}`, {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				credentials: "same-origin",
			});
		} catch (error) {
			// the browser reports a refused connection; the UI shows the offline hint
			throw new ApiError(0, "network_error", error instanceof Error ? error.message : "network error");
		}

		if (response.status === 204) {
			return undefined as T;
		}

		const text = await response.text();
		const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

		if (!response.ok) {
			const code = typeof payload.code === "string" ? payload.code : "unknown_error";
			const detail = typeof payload.detail === "string" ? payload.detail : undefined;
			if (response.status === 401) {
				// the session is gone or expired: the app has to log in again
				writeSession(null);
			}
			throw new ApiError(response.status, code, detail);
		}

		return payload as T;
	}

	/**
	 * Reads the file name out of a `content-disposition` header.
	 *
	 * @param header - value of the header
	 * @returns the file name or `null`
	 */
	function dispositionFileName(header: string | null): string | null {
		const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? "");
		return match ? decodeURIComponent(match[1]) : null;
	}

	/**
	 * Fetches a download and returns its bytes with the suggested file name.
	 *
	 * Downloads cannot be opened as a plain link: the API needs the session token, which a navigation would not
	 * send. The response is therefore read as a blob and handed to the caller.
	 *
	 * @param path - path below the API prefix
	 * @param query - query parameters
	 * @returns blob and file name
	 */
	async function requestDownload(path: string, query: Record<string, string | number>): Promise<DownloadFile> {
		const headers: Record<string, string> = {};
		if (cached) {
			if (cached.token) {
				// only sessions from before the cookie switch still carry the token in storage
				headers["x-session-token"] = cached.token;
			}
			headers["x-csrf-token"] = cached.csrfToken;
		}

		let response: Response;
		try {
			response = await fetch(`${API_PREFIX}${path}${buildQuery(query)}`, {
				headers,
				credentials: "same-origin",
			});
		} catch (error) {
			throw new ApiError(0, "network_error", error instanceof Error ? error.message : "network error");
		}

		if (!response.ok) {
			// a failed download is a problem document, so the usual error handling applies
			const details = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
			throw new ApiError(response.status, details.code ?? "unknown_error", details.detail);
		}

		return {
			blob: await response.blob(),
			fileName:
				dispositionFileName(response.headers.get("content-disposition")) ?? path.split("/").pop() ?? "download",
		};
	}

	return {
		session: () => cached,

		streamUrl(): string | null {
			if (!cached) {
				return null;
			}
			// the web app is served from the same origin as the API, so the page's host is the one to call
			const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
			const base = `${scheme}//${window.location.host}${API_PREFIX}/stream`;
			// a browser sends the session cookie with the handshake; only older sessions still need the token
			return cached.token ? `${base}?token=${encodeURIComponent(cached.token)}` : base;
		},

		forget: () => writeSession(null),

		// kiosk terminal: it has no user session, so every call is anonymous — the device token is exchanged
		// for a short lived terminal session that is carried in the body or the query

		terminalStatus: () => request<TerminalStatus>("GET", "/terminal/status", { anonymous: true }),

		terminalSession: (deviceToken: string) =>
			request<TerminalSessionResult>("POST", "/terminal/session", { body: { deviceToken }, anonymous: true }),

		terminalUsers: (terminalSession: string) =>
			request<{ users: TerminalUser[] }>("GET", "/terminal/users", {
				query: { terminalSession },
				anonymous: true,
			}),

		terminalPunch: (input: { terminalSession: string; badge?: string; userId?: number; pin?: string }) =>
			request<TerminalPunchResult>("POST", "/terminal/punch", { body: input, anonymous: true }),

		terminalHeartbeat: (terminalSession: string) =>
			request<{ status: string; serverTime: number; timezone: string; expiresAt: number }>(
				"POST",
				"/terminal/heartbeat",
				{ body: { terminalSession }, anonymous: true },
			),

		async login(login: string, password: string): Promise<StoredSession> {
			const result = await request<LoginResult>("POST", "/auth/login", {
				body: { login, password },
				anonymous: true,
			});
			const session: StoredSession = {
				// the token itself stays in the httpOnly cookie the server just set — it is not written to storage
				csrfToken: result.csrfToken,
				expiresAt: result.expiresAt,
				user: result.user,
			};
			writeSession(session);
			return session;
		},

		async logout(): Promise<void> {
			if (cached) {
				try {
					await request<void>("POST", "/auth/logout");
				} catch {
					// the session is dropped locally even when the server cannot be reached
				}
			}
			writeSession(null);
		},

		async me() {
			const result = await request<{
				user: SessionUser | null;
				permissions: string[];
				expiresAt?: number;
				csrfToken?: string;
			}>("GET", "/auth/me");

			// A session that only exists as a cookie (a fresh tab, a restored cookie) is adopted here — together
			// with the CSRF token the page needs for writes, which no script can read out of the cookie itself.
			if (result.user) {
				writeSession({
					csrfToken: result.csrfToken ?? cached?.csrfToken ?? "",
					expiresAt: result.expiresAt ?? cached?.expiresAt ?? 0,
					user: result.user,
					...(cached?.token ? { token: cached.token } : {}),
				});
			}
			return result;
		},

		async changePassword(password: string): Promise<void> {
			try {
				await request<void>("POST", "/auth/password", { body: { password } });
			} finally {
				// a password change ends all sessions, including this one
				writeSession(null);
			}
		},

		punch: options =>
			request<PunchResult>("POST", options?.quick ? "/punch/quick" : "/punch", {
				body: {
					...(options?.tsUtc ? { tsUtc: options.tsUtc } : {}),
					...(options?.note ? { note: options.note } : {}),
					...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
				},
			}),

		status: () => request<PunchStatus>("GET", "/punch/status"),

		days: (from, to) => request<DayRange>("GET", "/aggregates/day", { query: { from, to } }),

		month: (year, month) =>
			request<{ month: MonthAggregate; year: YearAggregate }>("GET", "/aggregates/month", {
				query: { year, month },
			}),

		months: year => request("GET", "/aggregates/month", { query: { year } }),

		year: year => request<YearAggregate>("GET", "/aggregates/year", { query: { year } }),

		payouts: year =>
			request<{ totalMinutes: number; payouts: Payout[] }>("GET", "/payouts", { query: { year, month: "" } }),

		async entries(from, to): Promise<Entry[]> {
			const result = await request<{ entries: Entry[] }>("GET", "/entries", { query: { from, to } });
			return result.entries ?? [];
		},

		async absences(year): Promise<Absence[]> {
			const result = await request<{ absences: Absence[] }>("GET", "/absences", { query: { year } });
			return result.absences ?? [];
		},

		async absenceTypes(): Promise<AbsenceType[]> {
			const result = await request<{ types: AbsenceType[] }>("GET", "/absence-types");
			return result.types ?? [];
		},

		async createAbsence(input): Promise<Absence> {
			const result = await request<{ absence: Absence }>("POST", "/absences", { body: input });
			return result.absence;
		},

		sync: punches => request("POST", "/entries/sync", { body: { punches } }),

		async conflicts(): Promise<Conflict[]> {
			const result = await request<{ conflicts: Conflict[] }>("GET", "/entries/conflicts");
			return result.conflicts ?? [];
		},

		resolve: (entryId, action, reason) =>
			request("POST", `/entries/${entryId}/resolve`, { body: { action, ...(reason ? { reason } : {}) } }),

		downloadReport: (kind, year, month) => requestDownload(`/reports/${kind}`, { year, month }),

		async users(includeInactive = false): Promise<AdminUser[]> {
			const result = await request<{ users: AdminUser[] }>("GET", "/users", {
				query: { includeInactive: includeInactive ? "true" : "false" },
			});
			return result.users ?? [];
		},

		async roles(): Promise<RoleInfo[]> {
			const result = await request<{ roles: RoleInfo[] }>("GET", "/roles");
			return result.roles ?? [];
		},

		async createUser(input): Promise<AdminUser> {
			const result = await request<{ user: AdminUser }>("POST", "/users", { body: input });
			return result.user;
		},

		async updateUser(id, patch): Promise<AdminUser> {
			const result = await request<{ user: AdminUser }>("PATCH", `/users/${id}`, { body: patch });
			return result.user;
		},

		async setPin(id, pin): Promise<void> {
			await request("POST", `/users/${id}/pin`, { body: { pin } });
		},

		async terminals(): Promise<AdminTerminal[]> {
			const result = await request<{ terminals: AdminTerminal[] }>("GET", "/terminals");
			return result.terminals ?? [];
		},

		async createTerminal(input) {
			return request<{ terminal: AdminTerminal; deviceToken: string }>("POST", "/terminals", { body: input });
		},

		async revokeTerminal(id: number): Promise<void> {
			await request<void>("DELETE", `/terminals/${id}`);
		},

		async settings(): Promise<Record<string, string>> {
			const result = await request<{ settings: Record<string, string> }>("GET", "/settings");
			return result.settings ?? {};
		},

		async updateSettings(patch) {
			const result = await request<{ settings: Record<string, string> }>("PUT", "/settings", { body: patch });
			return result.settings ?? {};
		},

		async importRuns(): Promise<ImportRunRecord[]> {
			const result = await request<{ runs: ImportRunRecord[] }>("GET", "/import/runs");
			return result.runs ?? [];
		},

		async runImport(input) {
			// the route answers with the report itself; an envelope is unwrapped just in case
			const result = await request<ImportReport & { report?: ImportReport }>("POST", "/import/run", {
				body: input,
			});
			return result.report ?? result;
		},

		async holidays(year: number, region?: string): Promise<HolidayRecord[]> {
			const result = await request<{ holidays: HolidayRecord[] }>("GET", "/holidays", {
				query: { year, ...(region ? { region } : {}) },
			});
			return result.holidays ?? [];
		},

		async createHoliday(input) {
			const result = await request<{ holiday: HolidayRecord }>("POST", "/holidays", { body: input });
			return result.holiday;
		},

		async deleteHoliday(id: number): Promise<void> {
			await request<void>("DELETE", `/holidays/${id}`);
		},

		async rfidTags(): Promise<RfidTagRecord[]> {
			const result = await request<{ tags: RfidTagRecord[] }>("GET", "/rfid/tags");
			return result.tags ?? [];
		},

		async createTag(input) {
			return request<{ tag: RfidTagRecord; url: string }>("POST", "/rfid/tags", { body: input });
		},

		async deleteTag(id: number): Promise<void> {
			await request<void>("DELETE", `/rfid/tags/${id}`);
		},

		async statistics(from: string, to: string, userId?: number): Promise<StatisticsResult> {
			return request<StatisticsResult>("GET", "/reports/statistics", {
				query: { from, to, ...(userId ? { userId } : {}) },
			});
		},

		async scanTag(token: string): Promise<ScanResult> {
			// the route is public on purpose: the tag carries its own signature, so a scan needs no session
			return request<ScanResult>("POST", "/rfid/scan", { body: { token }, anonymous: true });
		},

		backups: () => request("GET", "/backup"),

		createBackup: () => request("POST", "/backup"),
	};
}

/** The client used by the app. */
export const api = createApiClient();

/**
 * Reads the calendar date of an instant in a time zone.
 *
 * @param tsUtc - UTC epoch seconds
 * @param timeZone - IANA time zone
 * @returns local date, `YYYY-MM-DD`
 */
export function localDate(tsUtc: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(tsUtc * 1000));
}

/**
 * Formats minutes as `H:MM`.
 *
 * @param minutes - duration in minutes
 * @returns formatted duration
 */
export function formatMinutes(minutes: number): string {
	const sign = minutes < 0 ? "-" : "";
	const absolute = Math.abs(Math.round(minutes));
	return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

/**
 * Formats an instant as time of day in a time zone.
 *
 * @param tsUtc - UTC epoch seconds or `null`
 * @param timeZone - IANA time zone
 * @param locales - locale(s) used for the format
 * @returns formatted time or an empty string
 */
export function formatTime(tsUtc: number | null, timeZone: string, locales?: string): string {
	if (tsUtc === null) {
		return "";
	}
	return new Intl.DateTimeFormat(locales, { timeZone, hour: "2-digit", minute: "2-digit" }).format(
		new Date(tsUtc * 1000),
	);
}

/**
 * Formats a local date for display.
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param locales - locale(s) used for the format
 * @returns formatted date
 */
export function formatDate(date: string, locales?: string): string {
	return new Intl.DateTimeFormat(locales, { dateStyle: "medium", timeZone: "UTC" }).format(
		new Date(`${date}T12:00:00Z`),
	);
}

/**
 * Formats a local date as weekday and day, e.g. for the calendar list.
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param locales - locale(s) used for the format
 * @returns formatted date
 */
export function formatWeekday(date: string, locales?: string): string {
	return new Intl.DateTimeFormat(locales, {
		weekday: "short",
		day: "2-digit",
		month: "2-digit",
		timeZone: "UTC",
	}).format(new Date(`${date}T12:00:00Z`));
}
