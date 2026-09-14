/**
 * Monthly work time statement as a PDF.
 *
 * `/api/reports/pdf` returns this file. It shows the same content as the Excel statement (header block, one row
 * per day, totals, absences, signature lines), drawn with `pdfkit`.
 *
 * **Fonts:** the built-in PDF fonts (`Helvetica`) only cover Latin-1, so Cyrillic (`ru`, `uk`) and Chinese
 * (`zh-cn`) cannot be rendered with them. Instead of producing empty boxes, the renderer refuses those
 * languages with a clear error until a Unicode font is configured (`report_font_path` setting, a `.ttf`/`.otf`
 * that covers the script). Latin statements work without any additional file, which keeps the adapter package
 * free of a multi-megabyte font.
 *
 * Text is written **uncompressed** (`compress: false`): a monthly statement is a few kilobytes, and an
 * uncompressed content stream keeps the file verifiable (and testable) without a PDF library.
 */

import * as fs from "node:fs";
import PDFDocument from "pdfkit";
import { ValidationError } from "../errors";
import type { ReportInput } from "./types";

/** Input of the PDF statement. */
export type PdfStatementInput = ReportInput & {
	/** Name of the generator, e.g. `zeiterfassung 0.0.1` */
	generator: string;
	/** Path of a Unicode font (`.ttf`/`.otf`), `null`/empty to use the built-in fonts */
	fontPath?: string | null;
};

/** Languages whose script the built-in PDF fonts cannot display. */
const NON_LATIN_LANGUAGES = new Set(["ru", "uk", "zh-cn"]);

/** Fonts the renderer works with. */
interface FontChoice {
	/** Font of the regular text */
	regular: string;
	/** Font of the headings */
	bold: string;
	/** True when a file of the administrator is used */
	embedded: boolean;
}

/** Margins and column geometry of the statement (A4 portrait, points). */
const LAYOUT = {
	margin: 40,
	fontSize: 9,
	lineHeight: 14,
	columns: [
		{ key: "date", x: 40, width: 118, align: "left" },
		{ key: "timeIn", x: 158, width: 34, align: "right" },
		{ key: "timeOut", x: 194, width: 34, align: "right" },
		{ key: "worked", x: 232, width: 42, align: "right" },
		{ key: "breaks", x: 276, width: 36, align: "right" },
		{ key: "target", x: 314, width: 42, align: "right" },
		{ key: "balance", x: 358, width: 42, align: "right" },
		{ key: "absence", x: 402, width: 40, align: "left" },
		{ key: "note", x: 444, width: 111, align: "left" },
	],
} as const;

/**
 * Chooses the fonts of a statement.
 *
 * @param language - language key of the labels, e.g. `ru`
 * @param fontPath - configured font file
 * @returns the fonts to use
 */
function chooseFonts(language: string, fontPath: string | null | undefined): FontChoice {
	const configured = (fontPath ?? "").trim();
	if (configured !== "" && fs.existsSync(configured)) {
		// one file is used for regular and bold text: a statement must not depend on a second file being there
		return { regular: configured, bold: configured, embedded: true };
	}
	if (NON_LATIN_LANGUAGES.has(language)) {
		throw new ValidationError(
			`language "${language}" needs a Unicode font: set report_font_path to a .ttf/.otf file that covers the script`,
		);
	}
	return { regular: "Helvetica", bold: "Helvetica-Bold", embedded: false };
}

/**
 * Formats a local date for display.
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param locale - locale of the employee
 * @returns formatted date, e.g. `Mo, 14.09.2026`
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
 * Formats minutes as `H:MM`.
 *
 * @param minutes - duration in minutes
 * @returns formatted duration, e.g. `9:30`
 */
function formatMinutes(minutes: number): string {
	const sign = minutes < 0 ? "-" : "";
	const absolute = Math.abs(minutes);
	return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
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
	return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "short", timeStyle: "short" }).format(
		new Date(tsUtc * 1000),
	);
}

/**
 * Builds the monthly statement as a PDF.
 *
 * @param input - employee, month, days, absences, labels and font
 * @returns the document as bytes
 */
export async function buildMonthStatement(input: PdfStatementInput): Promise<Buffer> {
	const { labels, locale, user } = input;
	const fonts = chooseFonts(input.language, input.fontPath);
	const from = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
	const lastDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
	const to = `${input.year}-${String(input.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
	const generated = formatStamp(input.generatedAt, locale, user.timezone);

	const doc = new PDFDocument({
		size: "A4",
		margin: LAYOUT.margin,
		// an uncompressed stream keeps the statement checkable without a PDF reader
		compress: false,
		info: {
			Title: `${labels.title} ${input.year}-${String(input.month).padStart(2, "0")}`,
			Author: input.generator,
			Creator: input.generator,
			Producer: input.generator,
			Subject: `${user.displayName} (${user.login})`,
		},
	});

	const chunks: Buffer[] = [];
	doc.on("data", (chunk: Buffer) => chunks.push(chunk));
	const finished = new Promise<void>(resolve => doc.on("end", resolve));

	const pageBottom = doc.page.height - LAYOUT.margin - 24;

	/**
	 * Draws one line of the day table.
	 *
	 * @param values - column values by key
	 * @param options - styling
	 * @param options.bold - true for headings and totals
	 * @param options.color - text colour
	 * @param options.topBorder - true to draw a line above the row
	 */
	const drawRow = (
		values: Record<string, string>,
		options: { bold?: boolean; color?: string; topBorder?: boolean } = {},
	): void => {
		const y = doc.y;
		if (options.topBorder) {
			doc.moveTo(LAYOUT.margin, y - 3)
				.lineTo(doc.page.width - LAYOUT.margin, y - 3)
				.lineWidth(0.5)
				.strokeColor("#9aa5b1")
				.stroke();
			doc.y = y;
		}
		doc.font(options.bold ? fonts.bold : fonts.regular).fontSize(LAYOUT.fontSize);
		doc.fillColor(options.color ?? "#000000");
		for (const column of LAYOUT.columns) {
			doc.text(values[column.key] ?? "", column.x, y, {
				width: column.width,
				align: column.align,
				lineBreak: false,
			});
		}
		doc.y = y + LAYOUT.lineHeight;
	};

	/** Draws the column headings and the line below them. */
	const drawHeaderRow = (): void => {
		drawRow(
			{
				date: labels.date,
				timeIn: labels.timeIn,
				timeOut: labels.timeOut,
				worked: labels.worked,
				breaks: labels.breaks,
				target: labels.target,
				balance: labels.balance,
				absence: labels.absence,
				note: labels.note,
			},
			{ bold: true },
		);
		doc.moveTo(LAYOUT.margin, doc.y - 3)
			.lineTo(doc.page.width - LAYOUT.margin, doc.y - 3)
			.lineWidth(0.5)
			.strokeColor("#9aa5b1")
			.stroke();
	};

	// --- header block ---------------------------------------------------------
	doc.font(fonts.bold).fontSize(16).fillColor("#000000").text(labels.title);
	doc.moveDown(0.3);
	doc.font(fonts.regular).fontSize(10);
	doc.text(`${labels.employee}: ${user.displayName} (${user.login})`);
	doc.text(`${labels.period}: ${formatDate(from, locale)} - ${formatDate(to, locale)}`);
	doc.text(`${labels.created}: ${generated}`);
	doc.moveDown(0.8);

	// --- days -----------------------------------------------------------------
	drawHeaderRow();
	const totals = { worked: 0, breaks: 0, target: 0, balance: 0 };

	for (const day of input.days) {
		// one more page when the month does not fit (defensive: 31 rows always fit on one A4 page)
		if (doc.y + LAYOUT.lineHeight > pageBottom) {
			doc.addPage();
			doc.font(fonts.regular).fontSize(8).fillColor("#757575").text(labels.title, LAYOUT.margin, LAYOUT.margin);
			doc.moveDown(0.5);
			drawHeaderRow();
		}

		const notes: string[] = [];
		if (day.isHoliday) {
			notes.push(labels.holiday);
		}
		if (day.hasOpenEntry) {
			notes.push(labels.openEntry);
		}

		drawRow(
			{
				date: formatDate(day.localDate, locale),
				timeIn: formatTime(day.firstInUtc, user.timezone, locale),
				timeOut: formatTime(day.lastOutUtc, user.timezone, locale),
				worked: formatMinutes(day.workedMin),
				breaks: formatMinutes(day.breakMin),
				target: formatMinutes(day.targetMin),
				balance: formatMinutes(day.balanceMin),
				absence: day.absenceCode ?? "",
				note: notes.join(", "),
			},
			{
				color: day.balanceMin < 0 ? "#c62828" : day.isHoliday || day.workedMin === 0 ? "#757575" : "#000000",
			},
		);

		totals.worked += day.workedMin;
		totals.breaks += day.breakMin;
		totals.target += day.targetMin;
		totals.balance += day.balanceMin;
	}

	drawRow(
		{
			date: labels.total,
			worked: formatMinutes(totals.worked),
			breaks: formatMinutes(totals.breaks),
			target: formatMinutes(totals.target),
			balance: formatMinutes(totals.balance),
			absence: `${labels.days}: ${input.days.length}`,
		},
		{ bold: true, color: totals.balance < 0 ? "#c62828" : "#000000", topBorder: true },
	);

	// --- absences -------------------------------------------------------------
	if (input.absences.length > 0) {
		doc.moveDown(1);
		doc.font(fonts.bold).fontSize(10).fillColor("#000000").text(labels.absences);
		doc.moveDown(0.3);
		for (const absence of input.absences) {
			const portion = absence.dayPortion === 0.5 ? labels.halfDay : labels.fullDay;
			doc.font(fonts.regular)
				.fontSize(LAYOUT.fontSize)
				.fillColor("#000000")
				.text(
					`${absence.typeCode} - ${absence.typeName}: ${formatDate(absence.dateFrom, locale)} - ${formatDate(
						absence.dateTo,
						locale,
					)}, ${portion}${absence.hours === null ? "" : `, ${absence.hours} h`}`,
				);
		}
	}

	// --- signatures -----------------------------------------------------------
	doc.moveDown(2);
	const signatureY = doc.y;
	doc.font(fonts.regular)
		.fontSize(LAYOUT.fontSize)
		.fillColor("#000000")
		.text(`${labels.signatureEmployee}: ______________________________`, LAYOUT.margin, signatureY, {
			width: 260,
			lineBreak: false,
		});
	doc.text(`${labels.signatureManager}: ______________________________`, 320, signatureY, {
		width: 235,
		lineBreak: false,
	});

	// --- footer on every page -------------------------------------------------
	const range = doc.bufferedPageRange();
	for (let index = 0; index < range.count; index++) {
		doc.switchToPage(range.start + index);
		doc.font(fonts.regular)
			.fontSize(8)
			.fillColor("#757575")
			.text(
				`${input.generator} - ${labels.title} ${input.year}-${String(input.month).padStart(2, "0")} - ${
					index + 1
				}/${range.count}`,
				LAYOUT.margin,
				doc.page.height - LAYOUT.margin,
				{ width: doc.page.width - 2 * LAYOUT.margin, align: "center", lineBreak: false },
			);
	}

	doc.end();
	await finished;
	return Buffer.concat(chunks);
}
