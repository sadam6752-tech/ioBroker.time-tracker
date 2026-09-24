/// <reference types="mocha" />
import { expect } from "chai";
import type { AbsenceWithType } from "../db/repositories/absences";
import {
	absenceEvents,
	absenceFeed,
	calendarDocument,
	companyFeedUrl,
	dayAfter,
	shiftDate,
	type CalendarEmployee,
} from "./calendar";

/**
 * Builds an absence with sensible defaults.
 *
 * @param overrides - values that differ from the default
 * @returns the absence
 */
function absence(overrides: Partial<AbsenceWithType> = {}): AbsenceWithType {
	return {
		id: 1,
		userId: 7,
		typeId: 3,
		dateFrom: "2026-09-07",
		dateTo: "2026-09-11",
		dayPortion: 1,
		hours: null,
		status: "planned",
		approval: "requested",
		decidedAt: null,
		decidedBy: null,
		decisionNote: null,
		note: null,
		createdAt: 1_800_000_000,
		createdBy: 7,
		typeCode: "F",
		typeName: "Ferien",
		paid: true,
		factor: 100,
		reduceVacation: true,
		...overrides,
	};
}

/** The employees of the tests. */
const employees = new Map<number, CalendarEmployee>([
	[7, { id: 7, displayName: "Anna Muster", login: "anna" }],
	[8, { id: 8, displayName: "Ben Beispiel", login: "ben" }],
]);

describe("calendar service", () => {
	it("ends an all-day event on the day after the last one", () => {
		expect(dayAfter("2026-09-11")).to.equal("2026-09-12");
		// the turn of the month and of the year, and a leap year
		expect(dayAfter("2026-12-31")).to.equal("2027-01-01");
		expect(dayAfter("2028-02-28")).to.equal("2028-02-29");
	});

	it("shifts a date over the turn of the month and of the year", () => {
		expect(shiftDate("2026-03-01", -1)).to.equal("2026-02-28");
		expect(shiftDate("2026-12-31", 1)).to.equal("2027-01-01");
	});

	it("names the portion and the employee only where they are needed", () => {
		const half = absence({ dayPortion: 0.5 });
		expect(absenceEvents([half], employees, false)[0]?.summary).to.equal("Ferien (F) (0.5)");
		expect(absenceEvents([half], employees, true)[0]?.summary).to.equal("Anna Muster: Ferien (F) (0.5)");
		// an absence of somebody the calendar does not know keeps its title
		expect(absenceEvents([absence({ userId: 99 })], employees, true)[0]?.summary).to.equal("Ferien (F)");
	});

	it("keeps the state of the day, the note and the id an app updates with", () => {
		const events = absenceEvents([absence({ approval: "approved", note: "abgesprochen" })], employees, false);
		expect(events[0]?.confirmed).to.equal(true);
		expect(events[0]?.description).to.equal("abgesprochen");
		expect(events[0]?.uid).to.equal("absence-1@time-tracker");
		expect(absenceEvents([absence()], employees, false)[0]?.confirmed).to.equal(false);
	});

	it("writes a document a calendar app can read", () => {
		const document = calendarDocument(
			"Abwesenheiten (Firma)",
			absenceEvents(
				[absence({ approval: "approved", note: "Zeile 1\nZeile 2, mit Komma; und Semikolon" })],
				employees,
				true,
			),
			1_800_000_000,
		);

		expect(document.startsWith("BEGIN:VCALENDAR\r\n")).to.equal(true);
		expect(document.endsWith("END:VCALENDAR\r\n")).to.equal(true);
		expect(document).to.contain("X-WR-CALNAME:Abwesenheiten (Firma)");
		expect(document).to.contain("DTSTART;VALUE=DATE:20260907");
		// DTEND is exclusive: the 12th ends an absence that lasts until the 11th
		expect(document).to.contain("DTEND;VALUE=DATE:20260912");
		expect(document).to.contain("STATUS:CONFIRMED");
		expect(document).to.contain("SUMMARY:Anna Muster: Ferien (F)");
		// a comma, a semicolon and a line break are escaped
		expect(document).to.contain("DESCRIPTION:Zeile 1\\nZeile 2\\, mit Komma\\; und Semikolon");
		expect(document).to.contain("DTSTAMP:20270115T080000Z");
	});

	it("builds the subscription link of the company below the API prefix", () => {
		// without the prefix a browser gets the web app and its login instead of the calendar
		expect(companyFeedUrl("iobroker.lan", 8092, "abc123")).to.equal(
			"http://iobroker.lan:8092/api/calendar.ics?token=abc123",
		);
		// a token that is not plain stays usable
		expect(companyFeedUrl("10.0.0.2", 8093, "a b/c")).to.equal(
			"http://10.0.0.2:8093/api/calendar.ics?token=a%20b%2Fc",
		);
	});

	it("lists the absences of the plain data view sorted by day", () => {
		const rows = absenceFeed(
			[
				absence({ id: 2, userId: 8, dateFrom: "2026-09-07", typeCode: "W", typeName: "Weiterbildung" }),
				absence({
					id: 1,
					dateFrom: "2026-08-01",
					dateTo: "2026-08-01",
					approval: "approved",
					status: "taken",
					note: "Notiz",
				}),
			],
			employees,
		);

		expect(rows.map(row => row.id)).to.deep.equal([1, 2]);
		expect(rows[0]).to.deep.equal({
			id: 1,
			userId: 7,
			login: "anna",
			name: "Anna Muster",
			from: "2026-08-01",
			to: "2026-08-01",
			code: "F",
			type: "Ferien",
			portion: 1,
			approval: "approved",
			status: "taken",
			note: "Notiz",
		});
		expect(rows[1]?.login).to.equal("ben");
	});
});
