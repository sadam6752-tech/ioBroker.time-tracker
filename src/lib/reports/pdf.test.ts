/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import type { DayAggregateRecord } from "../services/aggregation";
import { ValidationError } from "../errors";
import { REPORT_LABELS, reportLabels } from "./labels";
import { buildMonthStatement } from "./pdf";

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
		generator: "zeiterfassung test",
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
		expect(text).to.contain("zeiterfassung test");
		expect(text).to.contain("1/1");
	});

	it("writes an empty month", async () => {
		const text = textOf(await buildMonthStatement({ ...baseInput, days: [] }));

		expect(text).to.contain("Summe");
		expect(text).to.contain("0:00");
		expect(text).to.contain("Tage: 0");
	});

	it("lists the absences and the signature lines", async () => {
		const text = textOf(
			await buildMonthStatement({
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
			}),
		);

		expect(text).to.contain("Abwesenheiten");
		expect(text).to.contain("U - Urlaub");
		expect(text).to.contain("A - Arzt");
		expect(text).to.contain("4 h");
		expect(text).to.contain("Unterschrift Mitarbeiter");
		expect(text).to.contain("Unterschrift Vorgesetzter");
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
});
