/// <reference types="mocha" />
import { expect } from "chai";
import { addDays, easterSunday, formatDate, holidaysForYear } from "./holidays";

describe("holidays", () => {
	describe("easterSunday", () => {
		const cases: [number, string][] = [
			[2024, "2024-03-31"],
			[2025, "2025-04-20"],
			[2026, "2026-04-05"],
			[2027, "2027-03-28"],
			[2038, "2038-04-25"],
		];

		for (const [year, expected] of cases) {
			it(`returns ${expected} for ${year}`, () => {
				expect(formatDate(easterSunday(year))).to.equal(expected);
			});
		}
	});

	describe("addDays", () => {
		it("crosses month boundaries", () => {
			expect(formatDate(addDays({ year: 2026, month: 3, day: 31 }, 1))).to.equal("2026-04-01");
		});

		it("crosses year boundaries", () => {
			expect(formatDate(addDays({ year: 2026, month: 12, day: 31 }, 1))).to.equal("2027-01-01");
		});

		it("handles leap years", () => {
			expect(formatDate(addDays({ year: 2024, month: 2, day: 28 }, 1))).to.equal("2024-02-29");
		});
	});

	describe("holidaysForYear", () => {
		it("returns the Swiss holidays sorted by date", () => {
			const holidays = holidaysForYear(2026, "CH");
			const dates = holidays.map(holiday => holiday.date);

			expect(holidays).to.have.lengthOf(5);
			expect(dates).to.deep.equal([...dates].sort());
			expect(dates).to.include("2026-01-01"); // New Year
			expect(dates).to.include("2026-04-03"); // Good Friday (Easter - 2)
			expect(dates).to.include("2026-05-14"); // Ascension Day (Easter + 39)
			expect(dates).to.include("2026-08-01"); // National Day
			expect(dates).to.include("2026-12-25"); // Christmas Day
		});

		it("returns the nationwide German holidays", () => {
			const dates = holidaysForYear(2026, "DE").map(holiday => holiday.date);

			expect(dates).to.include("2026-01-01");
			expect(dates).to.include("2026-04-03"); // Good Friday
			expect(dates).to.include("2026-04-06"); // Easter Monday
			expect(dates).to.include("2026-05-01"); // Labour Day
			expect(dates).to.include("2026-05-14"); // Ascension Day
			expect(dates).to.include("2026-05-25"); // Whit Monday (Easter + 50)
			expect(dates).to.include("2026-10-03"); // German Unity Day
			expect(dates).to.include("2026-12-26"); // Boxing Day
		});

		it("returns the Austrian holidays", () => {
			const dates = holidaysForYear(2026, "AT").map(holiday => holiday.date);

			expect(dates).to.include("2026-01-06"); // Epiphany
			expect(dates).to.include("2026-06-04"); // Corpus Christi (Easter + 60)
			expect(dates).to.include("2026-10-26"); // National Day
			expect(dates).to.include("2026-12-08"); // Immaculate Conception
		});
	});
});
