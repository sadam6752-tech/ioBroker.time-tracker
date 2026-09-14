/**
 * Shared shapes of the downloadable reports.
 *
 * The Excel and the PDF statement show the same data with the same labels — only the renderer differs, so the
 * input is defined once here.
 */

import type { DayAggregateRecord } from "../services/aggregation";
import type { ReportLabels } from "./labels";

/** One absence of the reported month. */
export interface ReportAbsence {
	/** Short type code, e.g. `U` */
	typeCode: string;
	/** Name of the type in the language of the instance */
	typeName: string;
	/** First day, local date */
	dateFrom: string;
	/** Last day, local date */
	dateTo: string;
	/** `1` for a whole day, `0.5` for a half day */
	dayPortion: number;
	/** Hours of a partial day absence, when known */
	hours: number | null;
}

/** Everything a monthly statement needs. */
export interface ReportInput {
	/** Employee the statement belongs to */
	user: { displayName: string; login: string; timezone: string };
	/** Labels in the language of the employee */
	labels: ReportLabels;
	/** Language key the labels came from, e.g. `ru` */
	language: string;
	/** Locale used for dates and times (`users.locale`) */
	locale: string;
	/** Four digit year */
	year: number;
	/** Month, 1 to 12 */
	month: number;
	/** Days of the month, from the aggregates */
	days: DayAggregateRecord[];
	/** Absences overlapping the month */
	absences: ReportAbsence[];
	/** Instant of the export */
	generatedAt: number;
}

/**
 * Builds the file name of a statement.
 *
 * @param login - login of the employee
 * @param year - four digit year
 * @param month - month, 1 to 12
 * @param extension - file extension without dot
 * @returns file name with extension
 */
export function reportFileName(login: string, year: number, month: number, extension: string): string {
	// a login may contain characters a file name cannot carry
	const safe = (login || "user").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
	return `zeiterfassung-${safe}-${year}-${String(month).padStart(2, "0")}.${extension}`;
}
