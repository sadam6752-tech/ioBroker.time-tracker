/// <reference types="mocha" />
import { expect } from "chai";
import ExcelJS from "exceljs";
import type { DayAggregateRecord } from "../services/aggregation";
import { REPORT_LABELS, reportLabels } from "./labels";
import { buildMonthReport, reportFileName, type ReportAbsence } from "./xls";

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

/**
 * Reads the workbook back so the assertions look at the file, not at the builder.
 *
 * @param buffer - generated workbook
 * @returns the parsed workbook
 */
async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
	return workbook;
}

/**
 * Returns a worksheet and fails the test when it is missing.
 *
 * @param workbook - parsed workbook
 * @param name - sheet name
 * @returns the worksheet
 */
function sheetOf(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
	const sheet = workbook.getWorksheet(name);
	expect(sheet, `worksheet ${name}`).to.be.an("object");
	if (!sheet) {
		throw new Error(`worksheet ${name} is missing`);
	}
	return sheet;
}

/**
 * Reads a cell as text.
 *
 * @param sheet - worksheet
 * @param address - cell address, e.g. `A1`
 * @returns the text of the cell
 */
function text(sheet: ExcelJS.Worksheet, address: string): string {
	const value = sheet.getCell(address).value;
	if (typeof value === "string") {
		return value.trim();
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	return "";
}

/** Base date Excel counts its day fractions from. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * Reads a duration cell back as minutes.
 *
 * A cell with the `[h]:mm` format holds a fraction of a day; ExcelJS converts it to a `Date` while reading, so
 * both shapes are accepted here — the number written and the value a reader of the file sees.
 *
 * @param sheet - worksheet
 * @param address - cell address, e.g. `D7`
 * @returns the duration in minutes
 */
function minutesOf(sheet: ExcelJS.Worksheet, address: string): number {
	const value = sheet.getCell(address).value;
	if (typeof value === "number") {
		return value * 1440;
	}
	if (value instanceof Date) {
		return (value.getTime() - EXCEL_EPOCH_MS) / 60000;
	}
	throw new Error(`cell ${address} is not a duration (${value === null ? "empty" : typeof value})`);
}

describe("monthly report (xlsx)", () => {
	/** Fixed instant the report is generated at. */
	const generatedAt = 1_800_000_000;

	const baseInput = {
		user: { displayName: "Anna Muster", login: "anna", timezone: "Europe/Zurich" },
		labels: REPORT_LABELS.de,
		locale: "de-CH",
		year: 2026,
		month: 9,
		generatedAt,
		generator: "zeiterfassung test",
		absences: [] as ReportAbsence[],
	};

	it("writes the header block, the days and the totals", async () => {
		const workbook = await read(
			await buildMonthReport({
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
					day("2026-09-02", { workedMin: 420, breakMin: 0, balanceMin: -60, hasOpenEntry: true }),
				],
			}),
		);
		const sheet = sheetOf(workbook, "2026-09");

		expect(text(sheet, "A1")).to.equal("Stundennachweis");
		expect(text(sheet, "A2")).to.equal("Mitarbeiter: Anna Muster (anna)");
		expect(text(sheet, "A3")).to.contain("Zeitraum:");
		expect(text(sheet, "A3")).to.contain("01.09.2026");
		expect(text(sheet, "A3")).to.contain("30.09.2026");
		expect(text(sheet, "A4")).to.contain("Erstellt:");

		// header of the day table
		expect(text(sheet, "A6")).to.equal("Datum");
		expect(text(sheet, "D6")).to.equal("Arbeitszeit");
		expect(text(sheet, "G6")).to.equal("Saldo");

		// first day: 07:00–15:45 in Zurich, 8:30 worked
		expect(text(sheet, "A7")).to.contain("01.09.2026");
		expect(text(sheet, "B7")).to.equal("07:00");
		expect(text(sheet, "C7")).to.equal("15:45");
		expect(minutesOf(sheet, "D7")).to.equal(510);
		expect(minutesOf(sheet, "E7")).to.equal(30);
		expect(minutesOf(sheet, "G7")).to.equal(30);

		// second day is still open, which the note column says
		expect(text(sheet, "A8")).to.contain("02.09.2026");
		expect(text(sheet, "I8")).to.equal("offen");
		expect(minutesOf(sheet, "G8")).to.equal(-60);

		// totals below the days
		expect(text(sheet, "A9")).to.equal("Summe");
		expect(minutesOf(sheet, "D9")).to.equal(930);
		expect(minutesOf(sheet, "E9")).to.equal(30);
		expect(minutesOf(sheet, "F9")).to.equal(960);
		expect(minutesOf(sheet, "G9")).to.equal(-30);
		expect(text(sheet, "H9")).to.equal("Tage: 2");

		// a duration is a number so Excel can add it up
		expect(sheet.getCell("D9").numFmt).to.equal("[h]:mm");
	});

	it("writes a month without days as an empty statement", async () => {
		const workbook = await read(await buildMonthReport({ ...baseInput, days: [] }));
		const sheet = sheetOf(workbook, "2026-09");

		expect(text(sheet, "A6")).to.equal("Datum");
		expect(text(sheet, "A7")).to.equal("Summe");
		expect(minutesOf(sheet, "D7")).to.equal(0);
		expect(minutesOf(sheet, "F7")).to.equal(0);
		expect(text(sheet, "H7")).to.equal("Tage: 0");
	});

	it("lists the absences of the month with their portion", async () => {
		const workbook = await read(
			await buildMonthReport({
				...baseInput,
				days: [day("2026-09-01", { workedMin: 480, targetMin: 480, balanceMin: 0 })],
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
		const sheet = sheetOf(workbook, "2026-09");

		// totals in row 8, then a blank line, the section, its header and two rows
		expect(text(sheet, "A11")).to.equal("Abwesenheiten");
		expect(text(sheet, "A12")).to.equal("Abwesenheit");
		expect(text(sheet, "B12")).to.equal("Von");
		expect(text(sheet, "D12")).to.equal("Anteil");
		expect(text(sheet, "A13")).to.equal("U - Urlaub");
		expect(text(sheet, "B13")).to.contain("07.09.2026");
		expect(text(sheet, "C13")).to.contain("11.09.2026");
		expect(text(sheet, "D13")).to.equal("ganzer Tag");
		expect(text(sheet, "A14")).to.equal("A - Arzt");
		expect(text(sheet, "D14")).to.equal("halber Tag");
		expect(text(sheet, "E14")).to.equal("4 h");

		// the signature lines close the statement
		expect(text(sheet, "A17")).to.contain("Unterschrift Mitarbeiter");
		expect(text(sheet, "F17")).to.contain("Unterschrift Vorgesetzter");
	});

	it("uses the language of the employee and falls back to English", async () => {
		const russian = reportLabels("ru-RU");
		expect(russian.language).to.equal("ru");
		const sheet = sheetOf(
			await read(await buildMonthReport({ ...baseInput, labels: russian.labels, locale: "ru-RU", days: [] })),
			"2026-09",
		);
		expect(text(sheet, "A1")).to.equal("Табель учёта рабочего времени");
		expect(text(sheet, "A6")).to.equal("Дата");

		expect(reportLabels("de-CH").language).to.equal("de");
		expect(reportLabels("zh-Hans-CN").language).to.equal("zh-cn");
		expect(reportLabels("pt-BR").labels.title).to.equal("Extrato de horas");
		// an unknown language must never break an export
		expect(reportLabels("xx-YY")).to.deep.include({ language: "en" });
		expect(reportLabels("")).to.deep.include({ language: "en" });
	});

	it("builds a safe file name", () => {
		expect(reportFileName("anna", 2026, 9)).to.equal("zeiterfassung-anna-2026-09.xlsx");
		expect(reportFileName("anna/müller", 2026, 12)).to.equal("zeiterfassung-anna-m-ller-2026-12.xlsx");
		expect(reportFileName("", 2026, 1)).to.equal("zeiterfassung-user-2026-01.xlsx");
	});

	it("names the labels of every supported language", () => {
		const languages = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
		expect(Object.keys(REPORT_LABELS).sort()).to.deep.equal([...languages].sort());
		for (const language of languages) {
			const labels = REPORT_LABELS[language];
			expect(labels.title, `${language}: title`).to.be.a("string").and.not.equal("");
			expect(Object.keys(labels).length, `${language}: number of labels`).to.equal(
				Object.keys(REPORT_LABELS.en).length,
			);
		}
	});
});
