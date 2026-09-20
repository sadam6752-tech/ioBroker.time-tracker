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
import type { ReportLabels } from "./labels";
import type { ReportInput } from "./types";

/** Input of the PDF statement. */
export type PdfStatementInput = ReportInput & {
	/** Name of the generator, e.g. `time-tracker 0.0.1` */
	generator: string;
	/** Path of a Unicode font (`.ttf`/`.otf`), `null`/empty to use the built-in fonts */
	fontPath?: string | null;
};

/** Languages whose script the built-in PDF fonts cannot display. */
const NON_LATIN_LANGUAGES = new Set(["ru", "uk", "zh-cn"]);

/** Characters WinAnsiEncoding knows in addition to Latin-1 — anything else cannot be drawn by the built-in fonts. */
const WIN_ANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/**
 * Reports whether the built-in fonts can draw a text.
 *
 * The built-in fonts use WinAnsiEncoding, which covers Latin-1 and a handful of typographic characters. A Polish
 * "Nieobecność" is outside of it: the renderer would draw nonsense instead of the word, so such a text counts as
 * undrawable.
 *
 * @param text - text to check
 * @returns true when every character is part of WinAnsiEncoding
 */
function fitsBuiltInFont(text: string): boolean {
	return [...text].every(character => character.charCodeAt(0) <= 0xff || WIN_ANSI_EXTRAS.includes(character));
}

/** Fonts the renderer works with. */
interface FontChoice {
	/** Font of the regular text */
	regular: string;
	/** Font of the headings */
	bold: string;
	/** True when a file of the administrator is used */
	embedded: boolean;
}

/** Margins and text sizes of the statement (A4 portrait, points). */
const LAYOUT = {
	margin: 40,
	fontSize: 9,
	lineHeight: 14,
} as const;

/** Distance between two columns, so that texts never touch. */
const COLUMN_PADDING = 6;

/**
 * Font sizes tried for the column headings, the largest first.
 *
 * A heading has to stay on one line: "Arbeitszeit" is about 57 points wide at 9 points, the Ukrainian
 * "Відпрацьовано" needs even more, and this renderer breaks a word when the column is too narrow for it (the
 * option `lineBreak: false` does not prevent that). The headings are therefore measured and the size steps down
 * until every one of them fits.
 */
const HEADER_SIZES = [9, 8, 7, 6.5] as const;

/** The columns of the day table, in the order they are drawn. */
const COLUMNS: {
	/** Key in the values object and in the labels */
	key: keyof ReportLabels;
	/** Alignment of the text inside the cell */
	align: "left" | "right";
	/** A typical value: the column is at least wide enough for it */
	sample: string;
	/** Share of the width left over after each column got what it needs */
	grow: number;
}[] = [
	{ key: "date", align: "left", sample: "Mi., 30.09.2026", grow: 0.35 },
	{ key: "timeIn", align: "right", sample: "08:00", grow: 0 },
	{ key: "timeOut", align: "right", sample: "08:00", grow: 0 },
	{ key: "worked", align: "right", sample: "00:00", grow: 0 },
	{ key: "breaks", align: "right", sample: "00:00", grow: 0 },
	{ key: "paidBreaks", align: "right", sample: "00:00", grow: 0 },
	{ key: "target", align: "right", sample: "00:00", grow: 0 },
	{ key: "balance", align: "right", sample: "-00:00", grow: 0 },
	{ key: "absence", align: "left", sample: "F 50 %", grow: 0 },
	{ key: "note", align: "left", sample: "Feiertag, offen", grow: 0.65 },
];

/** A column with the position and the width the renderer measured. */
interface MeasuredColumn {
	/** Key in the values object */
	key: keyof ReportLabels;
	/** Left edge in points */
	x: number;
	/** Width in points */
	width: number;
	/** Alignment of the text inside the cell */
	align: "left" | "right";
}

/**
 * Chooses the fonts of a statement.
 *
 * @param language - language key of the labels, e.g. `ru`
 * @param fontPath - configured font file
 * @param labels - labels of the employee's language
 * @returns the fonts to use
 */
function chooseFonts(language: string, fontPath: string | null | undefined, labels: ReportLabels): FontChoice {
	const configured = (fontPath ?? "").trim();
	if (configured !== "" && fs.existsSync(configured)) {
		// one file is used for regular and bold text: a statement must not depend on a second file being there
		return { regular: configured, bold: configured, embedded: true };
	}
	// the language list is the fast path; the labels catch a language whose letters are outside WinAnsiEncoding
	// (Polish "Nieobecność", "święto" or "cały dzień") — drawing them would produce nonsense, not a statement
	const undrawable = Object.values(labels).filter(text => !fitsBuiltInFont(text));
	if (NON_LATIN_LANGUAGES.has(language) || undrawable.length > 0) {
		throw new ValidationError(
			`language "${language}" needs a Unicode font: set report_font_path to a .ttf/.otf file that covers the script`,
		);
	}
	return { regular: "Helvetica", bold: "Helvetica-Bold", embedded: false };
}

/**
 * Measures the columns of the day table.
 *
 * Every column is at least as wide as its heading, so a heading never has to be broken: a column sized for the
 * value "9:30" would otherwise split "Arbeitszeit" in the middle of the word. The width left over after that
 * goes to the date and to the note — the two columns that carry free text.
 *
 * @param doc - document the texts are measured on
 * @param fonts - fonts of the statement
 * @param labels - labels of the employee's language
 * @param samples - the texts of a column, so the column is wide enough for every one of them
 * @returns the columns and the font size of the heading row
 */
function measureColumns(
	doc: PDFKit.PDFDocument,
	fonts: FontChoice,
	labels: ReportLabels,
	samples: Partial<Record<keyof ReportLabels, string[]>>,
): { columns: MeasuredColumn[]; headerSize: number } {
	const available = doc.page.width - 2 * LAYOUT.margin;
	const smallest = HEADER_SIZES.length - 1;

	for (const [index, size] of HEADER_SIZES.entries()) {
		const needed = COLUMNS.map(column => {
			doc.font(fonts.bold).fontSize(size);
			const heading = doc.widthOfString(labels[column.key]);
			doc.font(fonts.regular).fontSize(LAYOUT.fontSize);
			// every value of the column is measured: a total is wider than a single day ("187:00" against
			// "8:00"), and measuring only a sample would break that number in the middle
			const texts = samples[column.key] ?? [column.sample];
			const value = Math.max(
				...(texts.length > 0 ? texts : [column.sample]).map(text => doc.widthOfString(text)),
			);
			// two paddings: one is the gap to the next column, the other keeps the text off the edge — a text that
			// fills its box to the last point is wrapped (or cut) after the last character by the renderer
			return Math.max(heading, value) + 2 * COLUMN_PADDING;
		});
		const total = needed.reduce((sum, width) => sum + width, 0);
		if (total > available && index < smallest) {
			continue;
		}

		const leftover = Math.max(0, available - total);
		let x = LAYOUT.margin;
		const columns = COLUMNS.map((column, position) => {
			const width = needed[position] + leftover * column.grow;
			const measured: MeasuredColumn = { key: column.key, x, width, align: column.align };
			x += width;
			return measured;
		});
		return { columns, headerSize: size };
	}

	// not reachable: the smallest size always fits
	return { columns: [], headerSize: HEADER_SIZES[smallest] };
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
	const fonts = chooseFonts(input.language, input.fontPath, labels);
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
	 * Returns the longer of two texts.
	 *
	 * @param first - first text
	 * @param second - second text
	 * @returns the longer text
	 */
	// The values of every column are summed up here: the totals are drawn in the row below and their width is
	// what the columns are measured against, so a total like "187:00" gets the room it needs.
	const totals = input.days.reduce(
		(sum, day) => ({
			worked: sum.worked + day.workedMin,
			breaks: sum.breaks + day.breakMin,
			paidBreaks: sum.paidBreaks + day.paidBreakMin,
			target: sum.target + day.targetMin,
			balance: sum.balance + day.balanceMin,
		}),
		{ worked: 0, breaks: 0, paidBreaks: 0, target: 0, balance: 0 },
	);
	/** The widest time of a day: in English a time carries an "AM"/"PM" marker, so "11:59 PM" is what fits. */
	const widestTime = formatTime(Date.UTC(2026, 0, 1, 23, 59) / 1000, "UTC", locale);

	const { columns, headerSize } = measureColumns(doc, fonts, labels, {
		// the date column holds the dates of the report: "czw., 30.09.2026" is wider than "Thu, 30.09.2026"
		date: input.days.map(day => formatDate(day.localDate, locale)),
		timeIn: [...input.days.map(day => formatTime(day.firstInUtc, user.timezone, locale)), widestTime],
		timeOut: [...input.days.map(day => formatTime(day.lastOutUtc, user.timezone, locale)), widestTime],
		worked: [...input.days.map(day => formatMinutes(day.workedMin)), formatMinutes(totals.worked)],
		breaks: [...input.days.map(day => formatMinutes(day.breakMin)), formatMinutes(totals.breaks)],
		paidBreaks: [...input.days.map(day => formatMinutes(day.paidBreakMin)), formatMinutes(totals.paidBreaks)],
		target: [...input.days.map(day => formatMinutes(day.targetMin)), formatMinutes(totals.target)],
		balance: [...input.days.map(day => formatMinutes(day.balanceMin)), formatMinutes(totals.balance)],
		// the note column carries the marks of a day: a public holiday and a punch without a counterpart
		note: [labels.holiday, labels.openEntry, `${labels.holiday}, ${labels.openEntry}`],
	});

	/**
	 * Draws one line of the day table.
	 *
	 * @param values - column values by key
	 * @param options - styling
	 * @param options.bold - true for headings and totals
	 * @param options.color - text colour
	 * @param options.topBorder - true to draw a line above the row
	 * @param options.fontSize - text size, defaults to the size of the rows
	 */
	const drawRow = (
		values: Partial<Record<keyof ReportLabels, string>>,
		options: { bold?: boolean; color?: string; topBorder?: boolean; fontSize?: number } = {},
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
		doc.font(options.bold ? fonts.bold : fonts.regular).fontSize(options.fontSize ?? LAYOUT.fontSize);
		doc.fillColor(options.color ?? "#000000");
		for (const column of columns) {
			// the width of the drawn box is one padding narrower than the column: without that gap a right
			// aligned value would end exactly where the next column starts ("SaldoAbwesenheit")
			doc.text(values[column.key] ?? "", column.x, y, {
				width: Math.max(1, column.width - COLUMN_PADDING),
				align: column.align,
				lineBreak: false,
			});
		}
		doc.y = y + LAYOUT.lineHeight;
	};

	/** Draws the column headings and the line below them. */
	const drawHeaderRow = (): void => {
		const headings: Partial<Record<keyof ReportLabels, string>> = {};
		for (const column of columns) {
			headings[column.key] = labels[column.key];
		}
		drawRow(headings, { bold: true, fontSize: headerSize });
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
				paidBreaks: formatMinutes(day.paidBreakMin),
				target: formatMinutes(day.targetMin),
				balance: formatMinutes(day.balanceMin),
				absence: day.absenceCode ?? "",
				note: notes.join(", "),
			},
			{
				color: day.balanceMin < 0 ? "#c62828" : day.isHoliday || day.workedMin === 0 ? "#757575" : "#000000",
			},
		);
	}

	drawRow(
		{
			date: labels.total,
			worked: formatMinutes(totals.worked),
			breaks: formatMinutes(totals.breaks),
			paidBreaks: formatMinutes(totals.paidBreaks),
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
	// the label is drawn and the line is ruled: a long label plus a string of underscores is wrapped by the
	// renderer (the Russian and Ukrainian labels are long), and then the two signature lines are no longer level
	//
	// The block sits near the bottom of the page: a statement ends with two signature lines, so an empty area
	// above them looks like the document was cut off. It stays below the content when that reaches far down.
	const signatureGap = 16;
	const signatureWidth = (doc.page.width - 2 * LAYOUT.margin - signatureGap) / 2;
	const signaturePreferred = doc.page.height - 30 - LAYOUT.lineHeight - 24;
	const signatureY = Math.max(doc.y + 24, Math.min(signaturePreferred, pageBottom - LAYOUT.lineHeight));

	/**
	 * Draws one signature line: the label followed by the rule to sign on.
	 *
	 * @param label - text before the line
	 * @param x - left edge of the block
	 */
	const drawSignature = (label: string, x: number): void => {
		doc.font(fonts.regular).fontSize(LAYOUT.fontSize).fillColor("#000000");
		const written = `${label}:`;
		// without a width limit the label is never broken — the block is wide enough for all eleven languages
		doc.text(written, x, signatureY, { lineBreak: false });
		const start = Math.min(x + doc.widthOfString(written) + 6, x + signatureWidth - 24);
		doc.moveTo(start, signatureY + LAYOUT.fontSize + 2)
			.lineTo(x + signatureWidth, signatureY + LAYOUT.fontSize + 2)
			.lineWidth(0.5)
			.strokeColor("#000000")
			.stroke();
		doc.y = signatureY + LAYOUT.lineHeight;
	};

	drawSignature(labels.signatureEmployee, LAYOUT.margin);
	drawSignature(labels.signatureManager, LAYOUT.margin + signatureWidth + signatureGap);

	// --- footer on every page -------------------------------------------------
	// the footer sits below the writing area on purpose, so the bottom margin is lifted while it is drawn: PDFKit
	// starts a new page when a text crosses the margin, and that page would carry nothing but the footer
	const range = doc.bufferedPageRange();
	for (let index = 0; index < range.count; index++) {
		doc.switchToPage(range.start + index);
		const bottom = doc.page.margins.bottom;
		doc.page.margins.bottom = 0;
		doc.font(fonts.regular)
			.fontSize(8)
			.fillColor("#757575")
			.text(
				`${input.generator} - ${labels.title} ${input.year}-${String(input.month).padStart(2, "0")} - ${
					index + 1
				}/${range.count}`,
				LAYOUT.margin,
				doc.page.height - 30,
				{ width: doc.page.width - 2 * LAYOUT.margin, align: "center", lineBreak: false },
			);
		doc.page.margins.bottom = bottom;
	}

	doc.end();
	await finished;
	return Buffer.concat(chunks);
}
