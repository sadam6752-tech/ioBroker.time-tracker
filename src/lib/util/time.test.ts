/// <reference types="mocha" />
import { expect } from "chai";
import {
	addDays,
	dateRange,
	dayOfWeek,
	daysInMonth,
	isValidTimeZone,
	localDate,
	localDateTime,
	startOfLocalDayUtc,
	utcToWallTime,
	wallTimeToUtc,
} from "./time";

/**
 * Seconds of a local wall clock time, independent of the real time zone (test helper).
 *
 * @param year
 * @param month
 * @param day
 * @param hour
 * @param minute
 * @param second
 */
function wallSeconds(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
	return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

describe("time helpers", () => {
	const berlin = "Europe/Berlin";

	describe("isValidTimeZone", () => {
		it("accepts IANA names and rejects unknown ones", () => {
			expect(isValidTimeZone(berlin)).to.equal(true);
			expect(isValidTimeZone("UTC")).to.equal(true);
			expect(isValidTimeZone("Mars/Olympus")).to.equal(false);
		});
	});

	describe("localDate / localDateTime", () => {
		it("resolves the start date to local midnight", () => {
			// 1767222000 = 2025-12-31T23:00:00Z = 2026-01-01T00:00+01:00 in Berlin
			expect(localDate(1767222000, berlin)).to.equal("2026-01-01");
			expect(localDateTime(1767222000, berlin).minutes).to.equal(0);
			expect(startOfLocalDayUtc("2026-01-01", berlin)).to.equal(1767222000);
		});

		it("uses the user's time zone, not UTC", () => {
			// 23:30 UTC on 31 December, 00:30 local on 1 January
			const tsUtc = 1767222000 + 1800;
			expect(localDate(tsUtc, berlin)).to.equal("2026-01-01");
			expect(localDate(tsUtc, "UTC")).to.equal("2025-12-31");
			expect(localDateTime(tsUtc, berlin).minutes).to.equal(30);
		});

		it("handles other time zones", () => {
			const tsUtc = 1767222000 + 1800;
			expect(localDate(tsUtc, "America/New_York")).to.equal("2025-12-31");
			expect(localDate(tsUtc, "Asia/Tokyo")).to.equal("2026-01-01");
		});
	});

	describe("calendar helpers", () => {
		it("counts weekdays with Sunday as 0", () => {
			expect(dayOfWeek("2026-01-01", berlin)).to.equal(4); // Thursday
			expect(dayOfWeek("2026-01-04", berlin)).to.equal(0); // Sunday
			expect(dayOfWeek("2026-01-05", berlin)).to.equal(1); // Monday
		});

		it("adds and ranges days across month and year boundaries", () => {
			expect(addDays("2026-01-31", 1)).to.equal("2026-02-01");
			expect(addDays("2026-12-31", 1)).to.equal("2027-01-01");
			expect(addDays("2026-01-01", -1)).to.equal("2025-12-31");
			expect(dateRange("2026-01-30", "2026-02-02")).to.deep.equal([
				"2026-01-30",
				"2026-01-31",
				"2026-02-01",
				"2026-02-02",
			]);
			expect(dateRange("2026-02-02", "2026-01-30")).to.deep.equal([]);
		});

		it("knows the length of a month", () => {
			expect(daysInMonth(2024, 2)).to.equal(29);
			expect(daysInMonth(2026, 2)).to.equal(28);
			expect(daysInMonth(2026, 4)).to.equal(30);
			expect(daysInMonth(2026, 12)).to.equal(31);
		});
	});

	describe("wallTimeToUtc", () => {
		it("converts unambiguous wall times", () => {
			// 15 June 2026, 12:00 local (CEST, +2) = 10:00 UTC
			const result = wallTimeToUtc(wallSeconds(2026, 6, 15, 12), berlin);
			expect(result.nonexistent).to.equal(false);
			expect(result.ambiguous).to.equal(false);
			expect(result.tsUtc).to.equal(wallSeconds(2026, 6, 15, 10));
		});

		it("flags wall times that do not exist (spring forward)", () => {
			// 29 March 2026: 02:00 → 03:00, so 02:30 does not exist
			const result = wallTimeToUtc(wallSeconds(2026, 3, 29, 2, 30), berlin);
			expect(result.nonexistent).to.equal(true);
			expect(result.ambiguous).to.equal(false);
		});

		it("flags wall times that exist twice (fall back)", () => {
			// 25 October 2026: 03:00 → 02:00, so 02:30 happens twice
			const result = wallTimeToUtc(wallSeconds(2026, 10, 25, 2, 30), berlin);
			expect(result.ambiguous).to.equal(true);
			expect(result.nonexistent).to.equal(false);
			// the earlier instant uses CEST (+2): 00:30 UTC
			expect(result.tsUtc).to.equal(wallSeconds(2026, 10, 25, 0, 30));
		});

		it("round trips with utcToWallTime", () => {
			for (const wall of [
				wallSeconds(2026, 1, 1, 8, 15),
				wallSeconds(2026, 6, 15, 23, 59, 59),
				wallSeconds(2026, 12, 31, 0, 0),
			]) {
				const utc = wallTimeToUtc(wall, berlin).tsUtc;
				expect(utcToWallTime(utc, berlin)).to.equal(wall);
			}
		});
	});
});
