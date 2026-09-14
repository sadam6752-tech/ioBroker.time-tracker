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

/** Result of a punch. */
export interface PunchResult {
	entry: Entry;
	created: boolean;
	day: DayAggregate;
	rounded?: { from: number; to: number; roundMinutes: number };
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

/** The caller as `GET /auth/me` reports it. */
export interface SessionUser {
	id: number;
	login: string;
	displayName: string;
	timezone: string;
	language: string;
	isActive: boolean;
}

/** Result of a login. */
export interface LoginResult {
	token: string;
	csrfToken: string;
	expiresAt: number;
	user: SessionUser;
}
