/// <reference types="mocha" />
import { expect } from "chai";
import ExcelJS from "exceljs";
import {
	password,
	users,
	annaId,
	adminId,
	annaToken,
	annaCsrf,
	adminToken,
	adminCsrf,
	clock,
	send,
	bodyOf,
	headers,
	setClock,
	useApiFixture,
} from "./apiFixture.test";

describe("web api", () => {
	useApiFixture();

	describe("reports", () => {
		it("serves the aggregates of own data and protects the data of others", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });
			await send("POST", "/punch", {
				body: { tsUtc: 1000 + 8 * 3600 },
				headers: headers(annaToken, annaCsrf),
			});

			const own = await send("GET", "/aggregates/day", {
				headers: headers(annaToken),
				query: { date: "1970-01-01" },
			});
			expect(own.status).to.equal(200);
			expect(bodyOf<{ day: { workedMin: number } }>(own).day.workedMin).to.equal(480);

			// the employee may not look at another employee
			const other = await send("GET", "/aggregates/day", {
				headers: headers(annaToken),
				query: { date: "1970-01-01", userId: String(adminId) },
			});
			expect(other.status).to.equal(403);
			expect(bodyOf(other).code).to.equal("permission_denied");

			const asAdmin = await send("GET", "/aggregates/day", {
				headers: headers(adminToken),
				query: { date: "1970-01-01", userId: String(annaId) },
			});
			expect(asAdmin.status).to.equal(200);
		});

		it("serves month and year aggregates", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			const month = await send("GET", "/aggregates/month", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(month.status).to.equal(200);
			expect(
				bodyOf<{ month: { year: number; month: number }; year: { year: number } }>(month).month,
			).to.deep.include({ year: 1970, month: 1, workedMin: 0, updatedAt: 1000 });

			const year = await send("GET", "/aggregates/year", {
				headers: headers(annaToken),
				query: { year: "1970" },
			});
			expect(year.status).to.equal(200);
			expect(bodyOf<{ year: { year: number } }>(year).year.year).to.equal(1970);

			const broken = await send("GET", "/aggregates/month", {
				headers: headers(annaToken),
				query: { year: "1970", month: "13" },
			});
			expect(broken.status).to.equal(400);
			expect(bodyOf(broken).detail).to.contain("month must be between 1 and 12");
		});

		it("lists the months of a year and a range of days", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			// without `month` the route answers the twelve months of the year
			const months = await send("GET", "/aggregates/month", {
				headers: headers(annaToken),
				query: { year: "1970" },
			});
			expect(months.status).to.equal(200);
			const payload = bodyOf<{ months: ({ year: number; month: number } | null)[]; year: { year: number } }>(
				months,
			);
			expect(payload.months).to.have.lengthOf(12);
			expect(payload.months[0]).to.deep.include({ year: 1970, month: 1 });
			expect(payload.months[11]).to.deep.include({ year: 1970, month: 12 });
			expect(payload.year.year).to.equal(1970);

			// `from`/`to` answers the single days of the range (calendar view)
			const range = await send("GET", "/aggregates/day", {
				headers: headers(annaToken),
				query: { from: "1970-01-01", to: "1970-01-03" },
			});
			expect(range.status).to.equal(200);
			const days = bodyOf<{ days: unknown[]; from: string }>(range);
			expect(days.from).to.equal("1970-01-01");
			expect(days.days).to.have.lengthOf(3);

			// client errors: a broken date and a missing year
			expect(
				(await send("GET", "/aggregates/day", { headers: headers(annaToken), query: { date: "01.01.1970" } }))
					.status,
			).to.equal(400);
			expect((await send("GET", "/aggregates/year", { headers: headers(annaToken) })).status).to.equal(400);
		});

		it("lists the punches of a range", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });

			const listed = await send("GET", "/entries", {
				headers: headers(annaToken),
				query: { from: "1970-01-01", to: "1970-01-02" },
			});
			expect(bodyOf<{ entries: unknown[] }>(listed).entries).to.have.lengthOf(1);

			const missingRange = await send("GET", "/entries", { headers: headers(annaToken) });
			expect(missingRange.status).to.equal(400);
			expect(bodyOf(missingRange).detail).to.equal("from and to are required");
		});
	});

	describe("exports", () => {
		it("needs a session and the own report permission", async () => {
			const anonymous = await send("GET", "/reports/xls", { query: { year: "1970", month: "1" } });
			expect(anonymous.status).to.equal(401);

			// an employee may read the own month, but not the one of somebody else
			const own = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(own.status).to.equal(200);

			const foreign = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1", userId: String(adminId) },
			});
			expect(foreign.status).to.equal(403);
		});

		it("refuses the times of the day to the employees and keeps them for the administration", async () => {
			// the clock moves a month ahead, so the punches of the seeded day lie far in the past — an employee
			// may not change them, however old they are; both sessions are expired then, so the test signs in again
			setClock(1000 + 30 * 86_400);
			const annaLater = await send("POST", "/auth/login", { body: { login: "anna", password } });
			const adminLater = await send("POST", "/auth/login", { body: { login: "admin", password } });
			expect(annaLater.status).to.equal(200);
			expect(adminLater.status).to.equal(200);
			const annaHeaders = headers(
				bodyOf<{ token: string }>(annaLater).token,
				bodyOf<{ csrfToken: string }>(annaLater).csrfToken,
			);
			const adminHeaders = headers(
				bodyOf<{ token: string }>(adminLater).token,
				bodyOf<{ csrfToken: string }>(adminLater).csrfToken,
			);

			// an employee does not write a punch at all, not even for the own day
			const refused = await send("POST", "/entries", {
				body: { tsUtc: clock - 3_600 },
				headers: annaHeaders,
			});
			expect(refused.status).to.equal(403);
			expect(bodyOf<{ code: string }>(refused).code).to.equal("permission_denied");

			// a punch of his own is commented but not moved
			const punched = await send("POST", "/punch", { body: { tsUtc: clock }, headers: annaHeaders });
			expect(punched.status).to.equal(201);
			const own = bodyOf<{ entry: { id: number; revision: number } }>(punched).entry;
			const moved = await send("PATCH", `/entries/${own.id}`, {
				body: { tsUtc: 2000, revision: own.revision },
				headers: annaHeaders,
			});
			expect(moved.status).to.equal(403);
			expect(bodyOf<{ code: string }>(moved).code).to.equal("permission_denied");
			const commented = await send("PATCH", `/entries/${own.id}`, {
				body: { revision: own.revision, note: "habe vergessen auszustempeln" },
				headers: annaHeaders,
			});
			expect(commented.status).to.equal(200);

			// the administration writes and corrects, and no window binds it
			const oldEntry = await send("POST", "/entries", {
				query: { userId: String(annaId) },
				body: { tsUtc: 1000, reason: "Nachtrag" },
				headers: adminHeaders,
			});
			expect(oldEntry.status).to.equal(201);
			const old = bodyOf<{ entry: { id: number; revision: number } }>(oldEntry).entry;
			expect(old, "the punch the administration wrote is returned").to.be.an("object");
			const asAdmin = await send("PATCH", `/entries/${old.id}`, {
				body: { tsUtc: 2000, revision: old.revision, reason: "Korrektur" },
				headers: adminHeaders,
			});
			expect(asAdmin.status).to.equal(200);
		});

		it("hands the raw punches of a month out as CSV", async () => {
			await send("POST", "/punch", { body: { tsUtc: 1000 }, headers: headers(annaToken, annaCsrf) });
			await send("POST", "/punch", { body: { tsUtc: 3700 }, headers: headers(annaToken, annaCsrf) });

			const own = await send("GET", "/reports/csv", {
				query: { year: "1970", month: "1" },
				headers: headers(annaToken),
			});
			expect(own.status).to.equal(200);
			expect(own.headers["content-type"]).to.equal("text/csv; charset=utf-8");
			expect(own.headers["content-disposition"]).to.equal('attachment; filename="time-tracker-anna-1970-01.csv"');
			const text = own.body.toString("utf8");
			expect(text.startsWith("\uFEFFdate;time;direction;source;note")).to.equal(true);
			// a header line and one row per punch
			expect(text.split("\r\n").filter(line => line !== "")).to.have.lengthOf(3);

			// the punches of somebody else need `report.view_other`
			const foreign = await send("GET", "/reports/csv", {
				query: { year: "1970", month: "1", userId: String(adminId) },
				headers: headers(annaToken),
			});
			expect(foreign.status).to.equal(403);

			const asAdmin = await send("GET", "/reports/csv", {
				query: { year: "1970", month: "1", userId: String(annaId) },
				headers: headers(adminToken),
			});
			expect(asAdmin.status).to.equal(200);
			expect(asAdmin.body.toString("utf8")).to.contain("date;time;direction;source;note");
		});

		it("replaces the break rules of one employee and deducts them for that day", async () => {
			// the house rule deducts half an hour per block, the employee only a quarter
			const house = await send("PUT", "/pause-rules", {
				body: { pauseRules: [{ fromMin: 360, pauseMin: 30 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(house.status).to.equal(200);

			// the rules of an employee are an administrative change
			expect(
				(
					await send("PUT", `/users/${annaId}/pause-rules`, {
						body: { pauseRules: [{ fromMin: 360, pauseMin: 15 }] },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const own = await send("PUT", `/users/${annaId}/pause-rules`, {
				body: { pauseRules: [{ fromMin: 360, pauseMin: 15 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(own.status).to.equal(200);
			const savedRules = bodyOf<{ pauseRules: { fromMin: number; pauseMin: number }[] }>(own).pauseRules;
			expect(savedRules.map(rule => [rule.fromMin, rule.pauseMin])).to.deep.equal([[360, 15]]);
			expect(
				(await send("GET", `/users/${annaId}/pause-rules`, { headers: headers(adminToken) })).status,
			).to.equal(200);

			// nine hours in one block without a punched break: the rule of the employee wins over the house rule
			for (const tsUtc of [25_200, 57_600]) {
				await send("POST", "/entries", {
					query: { userId: String(annaId) },
					body: { tsUtc },
					headers: headers(adminToken, adminCsrf),
				});
			}
			const day = bodyOf<{ day: { breakMin: number; workedMin: number } }>(
				await send("GET", "/aggregates/day", {
					query: { date: "1970-01-01", userId: String(annaId) },
					headers: headers(adminToken),
				}),
			).day;
			expect(day.breakMin).to.equal(15);
			expect(day.workedMin).to.equal(525);
		});

		it("answers with a workbook of the requested month", async () => {
			// one punch in January 1970, so the statement has a day row: a day that old is booked by the
			// administration, because the employees only comment their own days
			await send("POST", "/entries", {
				body: { tsUtc: 1_000_000, reason: "Testnachtrag" },
				headers: headers(adminToken, adminCsrf),
				query: { userId: String(annaId) },
			});

			// the statement is written in the language of the employee
			users.update({ id: annaId, patch: { locale: "de-DE" }, actorId: adminId });
			const response = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(response.status).to.equal(200);
			expect(response.headers["content-type"]).to.equal(
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			);
			expect(response.headers["content-disposition"]).to.equal(
				'attachment; filename="time-tracker-anna-1970-01.xlsx"',
			);
			expect(response.headers["cache-control"]).to.equal("no-store");

			// the body is a real workbook, not JSON
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
			const sheet = workbook.getWorksheet("1970-01");
			expect(sheet, "worksheet 1970-01").to.be.an("object");
			// the language of the employee is German, so the statement is German
			const cellText = (address: string): string => {
				const value = sheet?.getCell(address).value;
				return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
			};
			expect(cellText("A2")).to.equal("Mitarbeiter: Anna (anna)");
			expect(cellText("A6")).to.equal("Datum");
			expect(cellText("A7")).to.contain("01.01.1970");
			expect(cellText("A18")).to.contain("12.01.1970");
			// a single punch of the day leaves it open, which the note column says
			expect(cellText("J18")).to.equal("offen");
			expect(sheet?.getCell("D7").numFmt).to.equal("[h]:mm");
			// 31 day rows and the totals row below them
			expect(cellText("A38")).to.equal("Summe");
			expect(cellText("I38")).to.equal("Tage: 31");
		});
		it("answers with a PDF statement of the requested month", async () => {
			const response = await send("GET", "/reports/pdf", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(response.status).to.equal(200);
			expect(response.headers["content-type"]).to.equal("application/pdf");
			expect(response.headers["content-disposition"]).to.equal(
				'attachment; filename="time-tracker-anna-1970-01.pdf"',
			);
			expect(response.headers["cache-control"]).to.equal("no-store");
			expect(response.body.toString("latin1").startsWith("%PDF-1.")).to.equal(true);

			// an employee never receives the statement of somebody else
			const foreign = await send("GET", "/reports/pdf", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1", userId: String(adminId) },
			});
			expect(foreign.status).to.equal(403);
		});

		it("refuses a report that needs a font nobody configured", async () => {
			// the employee switches to Russian, which the built-in PDF fonts cannot render
			const updated = await send("PATCH", `/users/${annaId}`, {
				body: { locale: "ru" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(updated.status).to.equal(200);

			const response = await send("GET", "/reports/pdf", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});

			// a clear answer beats a statement with empty boxes
			expect(response.status).to.equal(422);
			const problem = bodyOf<{ code: string; detail: string }>(response);
			expect(problem.code).to.equal("report_font_missing");
			expect(problem.detail).to.contain("report_font_path");

			// the Excel export has no such limitation
			const xls = await send("GET", "/reports/xls", {
				headers: headers(annaToken),
				query: { year: "1970", month: "1" },
			});
			expect(xls.status).to.equal(200);
		});
	});
});
