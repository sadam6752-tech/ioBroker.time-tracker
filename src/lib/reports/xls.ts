/**
 * Monthly work time statement as an Excel workbook.
 *
 * `/api/reports/xls` returns this file. The layout is a statement, not a data dump: a header block with the
 * employee and the period, one row per day of the month, a totals row, the absences of the month and the two
 * signature lines at the end.
 *
 * Two details matter for correctness:
 *  - durations are written as **numbers** (minutes / 1440) with the number format `[h]:mm`. Excel then shows
 *    `9:30`, can sum them and keeps them usable; a text like `9:30` would look right but break every formula.
 *  - dates and times are formatted through `Intl` with the locale and time zone of the **employee**, so the
 *    statement matches the person it describes (`users.locale`, `users.timezone`).
 */

import ExcelJS from "exceljs";
import type { ReportAbsence, ReportInput } from "./types";

export type { ReportAbsence };

/** Input of the monthly statement. */
export type MonthReportInput = ReportInput & {
	/** Name of the generator, e.g. `zeiterfassung 0.0.1` */
	generator: string;
};

/** Number format that shows a duration in minutes as `[h]:mm`. */
const DURATION_FORMAT = "[h]:mm";

/** Header row of the day table. */
const HEADER_ROW = 6;

/** Line below the day table where the totals row is written. */
const FIRST_DAY_ROW = HEADER_ROW + 1;

/**
 * Formats a local date for display.
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param locale - locale of the employee
 * @returns formatted date, e.g. `Mo., 14.09.2026`
 */
function formatDate(date: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: "short",
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T12:00:00Z`));
}

/**
 * Formats an instant as time of day in a time zone.
 *
 * @param tsUtc - UTC epoch seconds or `null`
 * @param timeZone - IANA time zone of the employee
 * @param locale - locale of the employee
 * @returns formatted time or an empty string
 */
function formatTime(tsUtc: number | null, timeZone: string, locale: string): string {
	if (tsUtc === null) {
		return "";
	}
	return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(
		new Date(tsUtc * 1000),
	);
}

/**
 * Converts minutes into the fraction of a day Excel uses for durations.
 *
 * @param minutes - duration in minutes
 * @returns value for a cell with the `[h]:mm` format
 */
function duration(minutes: number): number {
	return minutes / 1440;
}

/**
 * Formats an instant for the header block.
 *
 * @param tsUtc - UTC epoch seconds
 * @param locale - locale of the employee
 * @param timeZone - IANA time zone of the employee
 * @returns formatted date and time
 */
function formatStamp(tsUtc: number, locale: string, timeZone: string): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		dateStyle: "short",
		timeStyle: "short",
	}).format(new Date(tsUtc * 1000));
}

/**
 * Builds the monthly statement as an Excel workbook.
 *
 * @param input - employee, month, days, absences and labels
 * @returns the workbook as bytes
 */
export async function buildMonthReport(input: MonthReportInput): Promise<Buffer> {
	const { labels, locale, user } = input;
	const workbook = new ExcelJS.Workbook();
	workbook.creator = input.generator;
	workbook.created = new Date(input.generatedAt * 1000);
	workbook.modified = workbook.created;

	// the sheet name is technical and stays readable in every language
	const sheet = workbook.addWorksheet(`${input.year}-${String(input.month).padStart(2, "0")}`, {
		views: [{ state: "frozen", ySplit: HEADER_ROW }],
	});

	sheet.columns = [
		{ key: "date", width: 24 },
		{ key: "timeIn", width: 9 },
		{ key: "timeOut", width: 9 },
		{ key: "worked", width: 11 },
		{ key: "breaks", width: 9 },
		{ key: "paidBreaks", width: 12 },
		{ key: "target", width: 10 },
		{ key: "balance", width: 10 },
		{ key: "absence", width: 12 },
		{ key: "note", width: 18 },
	];

	// --- header block ---------------------------------------------------------
	const from = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
	const lastDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
	const to = `${input.year}-${String(input.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

	const title = sheet.getCell("A1");
	title.value = labels.title;
	title.font = { bold: true, size: 14 };
	sheet.mergeCells("A1:J1");

	sheet.getCell("A2").value = `${labels.employee}: ${user.displayName} (${user.login})`;
	sheet.getCell("A3").value = `${labels.period}: ${formatDate(from, locale)} - ${formatDate(to, locale)}`;
	sheet.getCell("A4").value = `${labels.created}: ${formatStamp(input.generatedAt, locale, user.timezone)}`;
	for (const row of [2, 3, 4]) {
		sheet.getRow(row).font = { size: 10 };
	}

	// --- header of the day table ---------------------------------------------
	const header = sheet.getRow(HEADER_ROW);
	header.values = [
		labels.date,
		labels.timeIn,
		labels.timeOut,
		labels.worked,
		labels.breaks,
		labels.paidBreaks,
		labels.target,
		labels.balance,
		labels.absence,
		labels.note,
	];
	header.font = { bold: true };
	for (let column = 1; column <= 10; column++) {
		const cell = header.getCell(column);
		cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F5" } };
		cell.border = { bottom: { style: "thin", color: { argb: "FF9AA5B1" } } };
	}

	// --- one row per day ------------------------------------------------------
	let rowIndex = FIRST_DAY_ROW;
	const totals = { worked: 0, breaks: 0, paidBreaks: 0, target: 0, balance: 0 };

	for (const day of input.days) {
		const row = sheet.getRow(rowIndex++);
		const notes: string[] = [];
		if (day.isHoliday) {
			notes.push(labels.holiday);
		}
		if (day.hasOpenEntry) {
			notes.push(labels.openEntry);
		}

		row.values = [
			formatDate(day.localDate, locale),
			formatTime(day.firstInUtc, user.timezone, locale),
			formatTime(day.lastOutUtc, user.timezone, locale),
			duration(day.workedMin),
			duration(day.breakMin),
			duration(day.paidBreakMin),
			duration(day.targetMin),
			duration(day.balanceMin),
			day.absenceCode ?? "",
			notes.join(", "),
		];
		for (const column of [4, 5, 6, 7, 8]) {
			row.getCell(column).numFmt = DURATION_FORMAT;
		}
		// a negative balance is the one number a reader looks for
		if (day.balanceMin < 0) {
			row.getCell(8).font = { color: { argb: "FFC62828" } };
		}
		if (day.isHoliday || day.workedMin === 0) {
			row.getCell(1).font = { color: { argb: "FF757575" } };
		}

		totals.worked += day.workedMin;
		totals.breaks += day.breakMin;
		totals.paidBreaks += day.paidBreakMin;
		totals.target += day.targetMin;
		totals.balance += day.balanceMin;
	}

	// --- totals ---------------------------------------------------------------
	const totalRow = sheet.getRow(rowIndex);
	totalRow.values = [
		labels.total,
		"",
		"",
		duration(totals.worked),
		duration(totals.breaks),
		duration(totals.paidBreaks),
		duration(totals.target),
		duration(totals.balance),
		`${labels.days}: ${input.days.length}`,
		"",
	];
	totalRow.font = { bold: true };
	for (const column of [4, 5, 6, 7, 8]) {
		const cell = totalRow.getCell(column);
		cell.numFmt = DURATION_FORMAT;
		cell.border = { top: { style: "thin", color: { argb: "FF9AA5B1" } } };
	}
	if (totals.balance < 0) {
		totalRow.getCell(8).font = { bold: true, color: { argb: "FFC62828" } };
	}
	rowIndex += 1;

	// --- absences of the month ------------------------------------------------
	if (input.absences.length > 0) {
		rowIndex += 2;
		const section = sheet.getRow(rowIndex);
		section.values = [labels.absences];
		section.font = { bold: true };

		const sectionHeader = sheet.getRow(rowIndex + 1);
		sectionHeader.values = [labels.absence, labels.from, labels.to, labels.portion, ""];
		sectionHeader.font = { bold: true, size: 10 };

		for (const absence of input.absences) {
			const row = sheet.getRow(rowIndex + 2 + input.absences.indexOf(absence));
			const portion = absence.dayPortion === 0.5 ? labels.halfDay : labels.fullDay;
			row.values = [
				`${absence.typeCode} - ${absence.typeName}`,
				formatDate(absence.dateFrom, locale),
				formatDate(absence.dateTo, locale),
				portion,
				absence.hours === null ? "" : `${absence.hours} h`,
			];
		}
		rowIndex += 2 + input.absences.length;
	}

	// --- signatures -----------------------------------------------------------
	rowIndex += 2;
	sheet.getCell(`A${rowIndex}`).value = `${labels.signatureEmployee}: ______________________`;
	sheet.getCell(`F${rowIndex}`).value = `${labels.signatureManager}: ______________________`;
	sheet.getRow(rowIndex).font = { size: 10 };

	return Buffer.from(await workbook.xlsx.writeBuffer());
}
