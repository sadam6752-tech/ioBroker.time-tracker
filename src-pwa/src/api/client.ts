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
	Conflict,
	DayRange,
	Entry,
	LoginResult,
	MonthAggregate,
	Payout,
	PunchResult,
	PunchStatus,
	SessionUser,
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
	/** Session token */
	token: string;
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
			return parsed?.token ? parsed : null;
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
	 * Sends a request to the API.
	 *
	 * @param method - HTTP method
	 * @param path - path below the API prefix
	 * @param options - body, query parameters and headers
	 * @param options.body - request body (serialised as JSON)
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
			headers["x-session-token"] = cached.token;
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

	return {
		session: () => cached,

		streamUrl(): string | null {
			if (!cached) {
				return null;
			}
			// the web app is served from the same origin as the API, so the page's host is the one to call
			const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
			return `${scheme}//${window.location.host}${API_PREFIX}/stream?token=${encodeURIComponent(cached.token)}`;
		},

		forget: () => writeSession(null),

		async login(login: string, password: string): Promise<StoredSession> {
			const result = await request<LoginResult>("POST", "/auth/login", {
				body: { login, password },
				anonymous: true,
			});
			const session: StoredSession = {
				token: result.token,
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

		me: () => request("GET", "/auth/me"),

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
