/**
 * The calendar of the time tracking: absences as iCalendar and as plain data.
 *
 * Two consumers share this module: the **calendar feed** (`GET /calendar.ics`) hands a subscription link to a
 * calendar app — for one employee or, with the token of the instance, for the whole company — and the **adapter**
 * publishes the same data to ioBroker (an `.ics` file for the `ical` adapter, `calendar.absences` as JSON for
 * scripts and dashboards).
 *
 * The document is real iCalendar: an all-day event ends **exclusively** (`DTEND` is the day after the last day,
 * otherwise every calendar drops that day), a day that still waits for its decision is `TENTATIVE`, and the `UID` of
 * an absence is derived from its row id — that is what lets a calendar app update an event instead of adding it
 * again on every refresh.
 */

import type { AbsenceWithType } from "../db/repositories/absences";

/** Media type of a calendar document. */
export const ICAL_CONTENT_TYPE = "text/calendar; charset=utf-8";

/** How long a calendar app may cache a feed (a hint — Google caches longer anyway). */
export const CALENDAR_TTL = "PT2H";

/** Name of the calendar that carries every employee (the feed of the instance and the written file). */
export const COMPANY_CALENDAR_NAME = "Abwesenheiten (Firma)";

/** Path prefix the API is mounted on (the web server uses the same default). */
export const API_PREFIX = "/api";

/**
 * The subscription link of the company calendar.
 *
 * The API lives **below the prefix** — a browser that asks the prefix-less path gets the web app and its login —
 * so the prefix has to be part of the link. The token travels in the query, encoded like any other value.
 *
 * @param host - host name or address the devices can reach
 * @param port - port of the adapter
 * @param token - token of the instance
 * @returns the URL a calendar app subscribes to
 */
export function companyFeedUrl(host: string, port: number, token: string): string {
	return `http://${host}:${port}${API_PREFIX}/calendar.ics?token=${encodeURIComponent(token)}`;
}

/** The few fields of an employee a calendar needs. */
export interface CalendarEmployee {
	/** Database id of the employee */
	id: number;
	/** Shown name */
	displayName: string;
	/** Login, used by the JSON view */
	login: string;
}

/** One event of the calendar, independent of how it is rendered. */
export interface CalendarEvent {
	/** Stable id, so a calendar app updates an event instead of adding it again */
	uid: string;
	/** First day, `YYYY-MM-DD` */
	start: string;
	/** Last day, `YYYY-MM-DD` (included in the event) */
	end: string;
	/** Title shown in the calendar */
	summary: string;
	/** True when the absence is approved and the day is taken */
	confirmed: boolean;
	/** Note of the absence, `null` when there is none */
	description: string | null;
}

/** One absence in the plain data view (`calendar.absences`). */
export interface AbsenceFeedRow {
	/** Database id of the absence */
	id: number;
	/** Database id of the employee */
	userId: number;
	/** Login of the employee */
	login: string;
	/** Shown name of the employee */
	name: string;
	/** First day, `YYYY-MM-DD` */
	from: string;
	/** Last day, `YYYY-MM-DD` */
	to: string;
	/** Code of the absence type, e.g. `U` */
	code: string;
	/** Name of the absence type, e.g. `Urlaub` */
	type: string;
	/** How much of a day the absence covers (`1` for a whole day) */
	portion: number;
	/** `approved`, `requested` or `rejected` */
	approval: string;
	/** `planned` for a day in the future, `taken` for the past */
	status: string;
	/** Note, `null` when there is none */
	note: string | null;
}

/**
 * Escapes a text for an iCalendar value.
 *
 * @param value - raw text
 * @returns the text with the characters iCalendar reserves
 */
function icalText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/**
 * Formats an instant as a UTC stamp (`YYYYMMDDTHHMMSSZ`).
 *
 * @param seconds - UTC epoch seconds
 * @returns the iCalendar timestamp
 */
function icalStamp(seconds: number): string {
	return new Date(seconds * 1000)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/**
 * The day after a local date.
 *
 * iCalendar ends an all-day event **exclusively**: a vacation from the 5th to the 9th has to carry `DTEND` as the
 * 10th, otherwise every calendar shows it one day short.
 *
 * @param date - local date `YYYY-MM-DD`
 * @returns the following day
 */
export function dayAfter(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Shifts a local date by whole days.
 *
 * @param date - local date `YYYY-MM-DD`
 * @param days - days to add (negative values go back)
 * @returns the shifted date
 */
export function shiftDate(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Turns absences into calendar events.
 *
 * A half day cannot be an all-day event, so its portion travels in the summary. `withEmployee` puts the name of the
 * employee in front — that is what the calendar of the whole company needs, while the own calendar does not repeat
 * it.
 *
 * @param absences - absences of the period
 * @param employees - the employees the absences belong to
 * @param withEmployee - true to name the employee in the summary
 * @returns the events
 */
export function absenceEvents(
	absences: AbsenceWithType[],
	employees: Map<number, CalendarEmployee>,
	withEmployee: boolean,
): CalendarEvent[] {
	return absences.map(absence => {
		const portion = absence.dayPortion < 1 ? ` (${absence.dayPortion})` : "";
		const employee = employees.get(absence.userId);
		const own = `${absence.typeName} (${absence.typeCode})${portion}`;
		return {
			uid: `absence-${absence.id}@time-tracker`,
			start: absence.dateFrom,
			end: absence.dateTo,
			summary: withEmployee && employee ? `${employee.displayName}: ${own}` : own,
			confirmed: absence.approval === "approved",
			description: absence.note,
		};
	});
}
/**
 * Builds a `VCALENDAR` document.
 *
 * @param name - name of the calendar (the employee, or the company)
 * @param events - events to write
 * @param stamp - instant of the answer (`DTSTAMP`)
 * @returns the iCalendar document
 */
export function calendarDocument(name: string, events: CalendarEvent[], stamp: number): string {
	const lines: (string | null)[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//ioBroker//time-tracker//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		`X-WR-CALNAME:${icalText(name)}`,
		`REFRESH-INTERVAL;VALUE=DURATION:${CALENDAR_TTL}`,
		`X-PUBLISHED-TTL:${CALENDAR_TTL}`,
	];
	for (const event of events) {
		lines.push(
			"BEGIN:VEVENT",
			`UID:${event.uid}`,
			`DTSTAMP:${icalStamp(stamp)}`,
			`DTSTART;VALUE=DATE:${event.start.replace(/-/g, "")}`,
			`DTEND;VALUE=DATE:${dayAfter(event.end).replace(/-/g, "")}`,
			`SUMMARY:${icalText(event.summary)}`,
			event.confirmed ? "STATUS:CONFIRMED" : "STATUS:TENTATIVE",
			event.description ? `DESCRIPTION:${icalText(event.description)}` : null,
			"TRANSP:TRANSPARENT",
			"END:VEVENT",
		);
	}
	lines.push("END:VCALENDAR");
	return `${lines.filter(line => line !== null).join("\r\n")}\r\n`;
}

/**
 * The plain data view of the absences, for scripts and dashboards.
 *
 * The list is sorted by day, employee name and type, so it reads like the calendar does.
 *
 * @param absences - absences of the period
 * @param employees - the employees the absences belong to
 * @returns the rows
 */
export function absenceFeed(absences: AbsenceWithType[], employees: Map<number, CalendarEmployee>): AbsenceFeedRow[] {
	return absences
		.map(absence => {
			const employee = employees.get(absence.userId);
			return {
				id: absence.id,
				userId: absence.userId,
				login: employee?.login ?? "",
				name: employee?.displayName ?? "",
				from: absence.dateFrom,
				to: absence.dateTo,
				code: absence.typeCode,
				type: absence.typeName,
				portion: absence.dayPortion,
				approval: absence.approval,
				status: absence.status,
				note: absence.note,
			};
		})
		.sort(
			(left, right) =>
				left.from.localeCompare(right.from) ||
				left.name.localeCompare(right.name) ||
				left.code.localeCompare(right.code),
		);
}
