/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import type { DayAggregateRecord } from "../services/aggregation";
import { ValidationError } from "../errors";
import { REPORT_LABELS, reportLabels, type ReportLabels } from "./labels";
import { buildMonthStatement, LAYOUT } from "./pdf";

/**
 * Builds a day row with sensible defaults.
 *
 * @param localDate - local date of the day
 * @param overrides - values that differ from the default
 * @returns day row
 */
function day(localDate: string, overrides: Partial<DayAggregateRecord> = {}): DayAggregateRecord {
	return {
		userId: 1,
		localDate,
		workedMin: 0,
		breakMin: 0,
		paidBreakMin: 0,
		targetMin: 480,
		balanceMin: -480,
		absenceCode: null,
		isHoliday: false,
		firstInUtc: null,
		lastOutUtc: null,
		hasOpenEntry: false,
		updatedAt: 1_800_000_000,
		...overrides,
	};
}

/** A font of the machine running the tests, if there is one. */
const systemFont = ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(candidate =>
	fs.existsSync(candidate),
);

/**
 * Reads a PDF as raw text, structure included.
 *
 * The renderer writes uncompressed streams on purpose, so the file can be inspected without a PDF library.
 *
 * @param buffer - generated document
 * @returns the file as latin1 text
 */
function rawOf(buffer: Buffer): string {
	return buffer.toString("latin1");
}

/**
 * Extracts the drawn strings of a PDF.
 *
 * PDFKit writes text as hex strings inside `TJ` arrays (`[<5061757365> 10 <6e>] TJ`), so the drawn text is
 * decoded from those runs — joined without a separator, because PDFKit splits a single drawn string at kerning
 * boundaries.
 *
 * @param buffer - generated document
 * @returns the text the document shows
 */
function textOf(buffer: Buffer): string {
	const runs: string[] = [];
	for (const match of rawOf(buffer).matchAll(/<([0-9a-fA-F]+)>/g)) {
		const hex = match[1];
		if (hex.length % 2 === 0) {
			runs.push(Buffer.from(hex, "hex").toString("latin1"));
		}
	}
	return runs.join("");
}

/**
 * Reads the drawn text pieces of a PDF together with their position.
 *
 * `textOf` joins every drawn string, so a heading that the renderer broke into two lines still reads correctly
 * there. The pieces keep the coordinate of each drawn string, which is what tells a heading on one line from a
 * heading that was wrapped.
 *
 * @param buffer - generated document
 * @returns the drawn pieces with their coordinates
 */
function piecesOf(buffer: Buffer): { x: number; y: number; text: string }[] {
	const pieces: { x: number; y: number; text: string }[] = [];
	for (const stream of rawOf(buffer).matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
		for (const block of stream[1].matchAll(/BT([\s\S]*?)ET/g)) {
			const body = block[1];
			const move = /1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/.exec(body) ?? /([-\d.]+) ([-\d.]+) Td/.exec(body);
			const text = [...body.matchAll(/\[([^\]]*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj/g)]
				.map(match =>
					match[1]
						? [...match[1].matchAll(/<([0-9a-fA-F]+)>/g)]
								.map(hex => Buffer.from(hex[1], "hex").toString("latin1"))
								.join("")
						: match[2],
				)
				.join("");
			if (text.trim()) {
				pieces.push({ x: move ? Number(move[1]) : 0, y: move ? Number(move[2]) : 0, text });
			}
		}
	}
	return pieces;
}

/**
 * Counts the pages of a document.
 *
 * @param buffer - generated document
 * @returns number of pages
 */
function pagesOf(buffer: Buffer): number {
	// `/Type /Page` and not `/Type /Pages`: the page tree node is not a page
	return (rawOf(buffer).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** The columns of the day table, in the order they are drawn. */
const COLUMN_KEYS: (keyof ReportLabels)[] = [
	"date",
	"timeIn",
	"timeOut",
	"worked",
	"breaks",
	"paidBreaks",
	"target",
	"balance",
	"absence",
	"note",
];

describe("monthly report (pdf)", () => {
	/** Fixed instant the report is generated at. */
	const generatedAt = 1_800_000_000;

	const baseInput = {
		user: { displayName: "Anna Muster", login: "anna", timezone: "Europe/Berlin" },
		labels: REPORT_LABELS.de,
		language: "de",
		locale: "de-CH",
		year: 2026,
		month: 9,
		generatedAt,
		generator: "time-tracker test",
		absences: [],
	};

	it("draws the header, the days and the totals", async () => {
		const pdf = await buildMonthStatement({
			...baseInput,
			days: [
				day("2026-09-01", {
					workedMin: 510,
					breakMin: 30,
					targetMin: 480,
					balanceMin: 30,
					firstInUtc: Date.UTC(2026, 8, 1, 5, 0) / 1000,
					lastOutUtc: Date.UTC(2026, 8, 1, 13, 45) / 1000,
				}),
				day("2026-09-02", { workedMin: 420, balanceMin: -60, hasOpenEntry: true }),
			],
		});
		const text = textOf(pdf);
		const raw = rawOf(pdf);

		// a real PDF file, not a text file with a PDF name
		expect(raw.startsWith("%PDF-1.")).to.equal(true);
		expect(raw.trimEnd().endsWith("%%EOF")).to.equal(true);

		// the built-in fonts are used when no Unicode font is needed
		expect(raw).to.contain("/Helvetica");

		// header block and column headings
		expect(text).to.contain("Stundennachweis");
		expect(text).to.contain("Mitarbeiter: Anna Muster (anna)");
		expect(text).to.contain("Zeitraum:");
		expect(text).to.contain("01.09.2026");
		expect(text).to.contain("30.09.2026");
		expect(text).to.contain("Datum");
		expect(text).to.contain("Arbeitszeit");

		// day rows: 07:00–15:45 in Berlin, 8:30 worked, the second day is open
		expect(text).to.contain("07:00");
		expect(text).to.contain("15:45");
		expect(text).to.contain("8:30");
		expect(text).to.contain("offen");
		expect(text).to.contain("-1:00");

		// totals and the footer with the page counter
		expect(text).to.contain("Summe");
		expect(text).to.contain("Tage: 2");
		expect(text).to.contain("time-tracker test");
		expect(text).to.contain("1/1");
	});

	it("writes an empty month", async () => {
		const text = textOf(await buildMonthStatement({ ...baseInput, days: [] }));

		expect(text).to.contain("Summe");
		expect(text).to.contain("0:00");
		expect(text).to.contain("Tage: 0");
	});

	it("lists the absences at the left margin, one line each, and the signature lines", async () => {
		const pdf = await buildMonthStatement({
			...baseInput,
			days: [day("2026-09-01", { workedMin: 480, balanceMin: 0 })],
			absences: [
				{
					typeCode: "U",
					typeName: "Urlaub",
					dateFrom: "2026-09-07",
					dateTo: "2026-09-11",
					dayPortion: 1,
					hours: null,
				},
				{
					typeCode: "A",
					typeName: "Arzt",
					dateFrom: "2026-09-15",
					dateTo: "2026-09-15",
					dayPortion: 0.5,
					hours: 4,
				},
			],
		});
		const text = textOf(pdf);

		expect(text).to.contain("Abwesenheiten");
		expect(text).to.contain("U - Urlaub");
		expect(text).to.contain("A - Arzt");
		expect(text).to.contain("4 h");
		expect(text).to.contain("Unterschrift Mitarbeiter");
		expect(text).to.contain("Unterschrift Vorgesetzter");

		// The block starts at the left margin and every absence is one drawn line: the heading used to begin where
		// the last cell of the table was written, so the lines were squeezed into the rest of that row.
		const pieces = piecesOf(pdf);
		const heading = pieces.filter(piece => piece.text.includes("Abwesenheiten"));
		const firstLine = pieces.filter(piece => piece.text.includes("U - Urlaub"));
		expect(
			heading.map(piece => piece.x),
			"heading of the block",
		).to.deep.equal([LAYOUT.margin]);
		expect(
			firstLine.map(piece => piece.x),
			"first absence",
		).to.deep.equal([LAYOUT.margin]);
	});

	it("uses the labels of the employee", async () => {
		const english = reportLabels("en-GB");
		const text = textOf(
			await buildMonthStatement({
				...baseInput,
				labels: english.labels,
				language: english.language,
				locale: "en-GB",
				days: [],
			}),
		);

		expect(text).to.contain("Employee: Anna Muster (anna)");
		expect(text).to.contain("Total");
		expect(text).to.not.contain("Mitarbeiter:");
	});

	it("refuses a language the built-in fonts cannot display", async () => {
		const russian = reportLabels("ru-RU");
		let failure: unknown = null;

		try {
			await buildMonthStatement({
				...baseInput,
				labels: russian.labels,
				language: russian.language,
				locale: "ru-RU",
				days: [],
			});
		} catch (error) {
			failure = error;
		}

		// the reason names the setting that solves it instead of drawing empty boxes
		expect(failure, "the renderer must refuse the language").to.be.instanceOf(ValidationError);
		expect((failure as ValidationError).message).to.contain("needs a Unicode font");
		expect((failure as ValidationError).message).to.contain("report_font_path");

		// a configured path that does not exist is treated the same way
		expect(() =>
			buildMonthStatement({
				...baseInput,
				labels: russian.labels,
				language: russian.language,
				locale: "ru-RU",
				days: [],
				fontPath: "C:/gibt/es/nicht.ttf",
			}),
		).to.throw;
	});

	it("refuses Ukrainian and Chinese the same way and uses their labels", async () => {
		// the other two scripts the built-in Latin-1 fonts cannot draw (specification 6, language table)
		const english = reportLabels("en-GB");
		for (const locale of ["uk-UA", "zh-CN"]) {
			const chosen = reportLabels(locale);
			expect(chosen.language, locale).to.be.oneOf(["uk", "zh-cn"]);
			expect(chosen.labels.title, `${locale} needs its own texts`).to.not.equal(english.labels.title);

			let failure: unknown = null;
			try {
				await buildMonthStatement({
					...baseInput,
					labels: chosen.labels,
					language: chosen.language,
					locale,
					days: [],
				});
			} catch (error) {
				failure = error;
			}
			expect(failure, `${locale} must be refused without a font`).to.be.instanceOf(ValidationError);
			expect((failure as ValidationError).message).to.contain("report_font_path");
		}
	});

	// runs only where the machine has a TrueType font to embed
	(systemFont ? it : it.skip)("embeds a configured Unicode font", async () => {
		const russian = reportLabels("ru-RU");
		const pdf = await buildMonthStatement({
			...baseInput,
			labels: russian.labels,
			language: russian.language,
			locale: "ru-RU",
			days: [day("2026-09-01", { workedMin: 480, balanceMin: 0 })],
			fontPath: systemFont,
		});
		const raw = rawOf(pdf);

		// the font travels inside the document (subset as CID font), so a reader does not need it installed.
		// The drawn text is addressed by glyph id in that case, which is why the characters themselves are
		// not part of the file any more — embedding is exactly what makes the script render.
		expect(raw).to.contain("/FontFile2");
		expect(raw).to.contain("/CIDFontType2");
		expect(raw).to.not.contain("/Helvetica");
		expect(raw.trimEnd().endsWith("%%EOF")).to.equal(true);
		// the document carries text and the font subset is embedded, not referenced
		expect(raw).to.contain(" TJ");
		expect(raw).to.not.contain("/BaseFont /Helvetica");
	});

	it("keeps every column heading on one line and the statement on one page", async () => {
		// the languages whose letters the built-in fonts cover; Polish and the three non-Latin ones need a font
		for (const language of ["en", "de", "pt", "nl", "fr", "it", "es"]) {
			const chosen = reportLabels(language);
			// a full month is the tallest statement, so it is the one that can spill onto a second page
			const fullMonth = Array.from({ length: 31 }, (_, index) =>
				day(`2026-10-${String(index + 1).padStart(2, "0")}`, {
					workedMin: 486,
					breakMin: 30,
					balanceMin: 6,
					firstInUtc: Date.UTC(2026, 9, index + 1, 6, 0) / 1000,
					lastOutUtc: Date.UTC(2026, 9, index + 1, 14, 36) / 1000,
					...(index === 9 ? { isHoliday: true } : {}),
					...(index === 16 ? { hasOpenEntry: true, lastOutUtc: null } : {}),
				}),
			);
			const pdf = await buildMonthStatement({
				...baseInput,
				labels: chosen.labels,
				language: chosen.language,
				locale: chosen.language,
				days: fullMonth,
			});
			const pieces = piecesOf(pdf);

			// a heading that is wider than its column is broken by the renderer: the rest lands on the next line
			const headings = COLUMN_KEYS.map(key => pieces.find(piece => piece.text === chosen.labels[key]));
			expect(headings.filter(Boolean).length, `${language}: every heading is drawn as one piece`).to.equal(
				COLUMN_KEYS.length,
			);
			expect(new Set(headings.map(piece => piece?.y)).size, `${language}: all headings share one line`).to.equal(
				1,
			);

			// and the footer stands inside the page instead of starting a second one for itself
			expect(pagesOf(pdf), `${language}: one page`).to.equal(1);
			expect(
				pieces.some(piece => piece.text.includes("1/1")),
				`${language}: the footer is on that page`,
			).to.equal(true);
		}
	});

	it("keeps both signature lines on one level and leaves the underscores out", async () => {
		const pdf = await buildMonthStatement({
			...baseInput,
			days: [day("2026-09-01", { workedMin: 480, balanceMin: 0 })],
		});
		const pieces = piecesOf(pdf);
		const employee = pieces.find(piece => piece.text.startsWith(baseInput.labels.signatureEmployee));
		const manager = pieces.find(piece => piece.text.startsWith(baseInput.labels.signatureManager));

		expect(employee, "the line of the employee is drawn").to.not.equal(undefined);
		expect(manager, "the line of the manager is drawn").to.not.equal(undefined);
		// the underscores were wrapped for the long label, which made the second line look offset
		expect(employee?.y, "both lines share one height").to.equal(manager?.y);
		expect(textOf(pdf)).to.not.match(/_{5,}/);
	});

	it("keeps the values of the totals row on one line", async () => {
		// two days of 1:30 each: the total "3:00" is wider than any single day, and the column has to hold it
		const pdf = await buildMonthStatement({
			...baseInput,
			days: [
				day("2026-09-01", { workedMin: 90, breakMin: 0, targetMin: 480, balanceMin: -390 }),
				day("2026-09-02", { workedMin: 90, breakMin: 0, targetMin: 480, balanceMin: -390 }),
			],
		});
		const pieces = piecesOf(pdf);
		const totalsRow = pieces.find(piece => piece.text === baseInput.labels.total);
		const row = pieces.filter(piece => piece.y === totalsRow?.y).map(piece => piece.text);

		expect(totalsRow, "the totals row is drawn").to.not.equal(undefined);
		// every number of that row is one piece: a wrapped one would end up on the line below
		expect(row).to.include.members(["3:00", "0:00", "16:00", "-13:00", "Tage: 2"]);
	});

	it("refuses Polish, whose letters are outside the built-in fonts", async () => {
		const polish = reportLabels("pl-PL");
		let failure: unknown = null;

		try {
			await buildMonthStatement({
				...baseInput,
				labels: polish.labels,
				language: polish.language,
				locale: "pl-PL",
				days: [],
			});
		} catch (error) {
			failure = error;
		}

		// "Nieobecność" and "święto" are outside WinAnsiEncoding: a statement would show nonsense instead
		expect(failure, "the renderer must refuse the language").to.be.instanceOf(ValidationError);
		expect((failure as ValidationError).message).to.contain("report_font_path");
	});

	// runs only where the machine has a TrueType font to embed
	(systemFont ? it : it.skip)("writes Polish with a configured font", async () => {
		const polish = reportLabels("pl-PL");
		const pdf = await buildMonthStatement({
			...baseInput,
			labels: polish.labels,
			language: polish.language,
			locale: "pl-PL",
			days: [day("2026-09-01", { workedMin: 480, balanceMin: 0 })],
			fontPath: systemFont,
		});

		expect(rawOf(pdf)).to.contain("/FontFile2");
		expect(pagesOf(pdf)).to.equal(1);
	});
});
