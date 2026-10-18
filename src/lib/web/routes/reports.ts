/**
 * Monthly reports (XLS, PDF) and the raw punches as CSV.
 */

import { isApproved } from "../../db/repositories/absences";
import { NotFoundError, ValidationError } from "../../errors";
import { reportLabels } from "../../reports/labels";
import { buildMonthReport } from "../../reports/xls";
import { buildMonthStatement } from "../../reports/pdf";
import { reportFileName, type ReportInput } from "../../reports/types";
import { problem } from "../problem";
import { binary, type RouteContext } from "../router";

import type { ApiContext } from "./context";
import { XLSX_CONTENT_TYPE, PDF_CONTENT_TYPE, buildEntriesCsv } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerReportRoutes(ctx: ApiContext): void {
	const { deps, users, entries, absences, aggregation, settings, now, route, scopeUser, numberQuery } = ctx;

	// reports

	/**
	 * Collects everything a monthly statement needs.
	 *
	 * The Excel and the PDF export show the same statement, so they share this step: the caller is resolved
	 * from `?userId=` (permission checked), the month is recalculated and read, and the labels follow the
	 * language of the employee.
	 *
	 * @param context - route context with the authenticated caller
	 * @returns the report input plus the year and month
	 */
	const monthlyReport = (
		context: RouteContext,
	): {
		/** Input of the PDF and Excel builder */
		input: ReportInput & {
			/** Line of the generator that is printed into the document */
			generator: string;
		};
		/** Year of the statement */
		year: number;
		/** Month of the statement (1-12) */
		month: number;
		/** Login of the employee, used in the file name */
		login: string;
	} => {
		const userId = scopeUser(context);
		const user = users.findById(userId);
		if (!user) {
			throw new NotFoundError(`user ${userId} not found`);
		}

		const year = numberQuery(context, "year");
		const month = numberQuery(context, "month");
		if (month < 1 || month > 12) {
			throw new ValidationError(`month must be between 1 and 12 (got ${month})`);
		}

		const prefix = `${year}-${String(month).padStart(2, "0")}`;
		const first = `${prefix}-01`;
		const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
		const last = `${prefix}-${String(lastDay).padStart(2, "0")}`;
		const timestamp = now();

		// a statement has to show the current state of the month, so the range is recalculated first
		aggregation.recalculateRange(userId, first, last, { now: timestamp });
		const { labels, language } = reportLabels(user.locale);

		return {
			year,
			month,
			login: user.login,
			input: {
				user: { displayName: user.displayName, login: user.login, timezone: user.timezone },
				labels,
				language,
				locale: user.locale || "en",
				year,
				month,
				days: aggregation.days(userId, first, last),
				// the document only lists effective absences — a request waits for its decision
				absences: absences
					.withTypesInRange(userId, first, last)
					.filter(isApproved)
					.map(absence => ({
						typeCode: absence.typeCode,
						typeName: absence.typeName,
						dateFrom: absence.dateFrom,
						dateTo: absence.dateTo,
						dayPortion: absence.dayPortion,
						hours: absence.hours,
					})),
				generatedAt: timestamp,
				generator: `time-tracker ${deps.version ?? ""}`.trim(),
			},
		};
	};

	// the raw punches of a month as CSV: for payroll and for tools that want the single punch instead of a total
	route(
		"GET",
		"/reports/csv",
		{ permission: "report.view_own", rateLimit: { name: "export", limit: 20, windowSeconds: 60 } },
		context => {
			const { year, month, login } = monthlyReport(context);
			const author = users.findById(scopeUser(context));
			if (!author) {
				throw new NotFoundError("user not found");
			}
			const prefix = `${year}-${String(month).padStart(2, "0")}`;
			const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
			const csv = buildEntriesCsv(
				entries.listByRange(author.id, `${prefix}-01`, `${prefix}-${String(lastDay).padStart(2, "0")}`),
				author.timezone,
			);

			return binary(200, csv, "text/csv; charset=utf-8", {
				"content-disposition": `attachment; filename="${reportFileName(login, year, month, "csv")}"`,
				"cache-control": "no-store",
			});
		},
	);

	route(
		"GET",
		"/reports/xls",
		{ permission: "report.view_own", rateLimit: { name: "export", limit: 20, windowSeconds: 60 } },
		async context => {
			const { input, year, month, login } = monthlyReport(context);
			const workbook = await buildMonthReport(input);

			// the file name is generated from the login, so it never contains a header delimiter
			return binary(200, workbook, XLSX_CONTENT_TYPE, {
				"content-disposition": `attachment; filename="${reportFileName(login, year, month, "xlsx")}"`,
				"cache-control": "no-store",
			});
		},
	);

	route(
		"GET",
		"/reports/pdf",
		{ permission: "report.view_own", rateLimit: { name: "export", limit: 20, windowSeconds: 60 } },
		async context => {
			const { input, year, month, login } = monthlyReport(context);
			let statement: Buffer;
			try {
				statement = await buildMonthStatement({
					...input,
					// a Unicode font is only needed for scripts the built-in fonts cannot show (see the renderer)
					fontPath: settings.get("report_font_path") ?? "",
				});
			} catch (error) {
				// a language the built-in fonts cannot draw is a configuration problem, not a bad request:
				// the UI can name the setting that solves it
				if (error instanceof ValidationError && error.message.includes("Unicode font")) {
					throw problem(
						422,
						"report_font_missing",
						"this language needs a Unicode font: set report_font_path to a .ttf/.otf file that covers the script",
					);
				}
				throw error;
			}

			return binary(200, statement, PDF_CONTENT_TYPE, {
				"content-disposition": `attachment; filename="${reportFileName(login, year, month, "pdf")}"`,
				"cache-control": "no-store",
			});
		},
	);
}
