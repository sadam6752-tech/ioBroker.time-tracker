/// <reference types="mocha" />
import { expect } from "chai";
import { utcToWallTime, wallTimeToUtc } from "../util/time";
import { buildDayPunches, checkEmploymentWindow, nextDirection, roundToStep, type PunchEntry } from "./punch";

const berlin = "Europe/Berlin";

/**
 * Naive wall clock seconds (test helper).
 *
 * @param year
 * @param month
 * @param day
 * @param hour
 * @param minute
 * @param second
 */
function wall(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
	return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

/**
 * Instant of a Berlin wall clock time on 1 January 2026.
 *
 * @param hour
 * @param minute
 * @param second
 * @param day
 */
function at(hour: number, minute = 0, second = 0, day = 1): number {
	return wallTimeToUtc(wall(2026, 1, day, hour, minute, second), berlin).tsUtc;
}

/**
 * Ids are assigned in ascending order to keep the tests readable.
 *
 * @param times
 */
function entries(...times: number[]): PunchEntry[] {
	return times.map((tsUtc, index) => ({ id: index + 1, tsUtc }));
}

describe("punch pairing", () => {
	it("pairs punches sequentially", () => {
		const day = buildDayPunches(entries(at(8), at(12), at(13), at(17)));

		expect(day.pairs).to.have.lengthOf(2);
		expect(day.pairs[0].minutes).to.equal(240);
		expect(day.pairs[1].minutes).to.equal(240);
		expect(day.workedMinutes).to.equal(480);
		expect(day.hasOpenEntry).to.equal(false);
		expect(day.firstInUtc).to.equal(at(8));
		expect(day.lastOutUtc).to.equal(at(17));
	});

	it("leaves the last punch open when the count is odd", () => {
		const day = buildDayPunches(entries(at(8), at(12), at(13)));

		expect(day.pairs).to.have.lengthOf(2);
		expect(day.pairs[1].outEntry).to.equal(null);
		expect(day.pairs[1].minutes).to.equal(0);
		expect(day.hasOpenEntry).to.equal(true);
		expect(day.lastOutUtc).to.equal(null);
		expect(day.workedMinutes).to.equal(240);
		expect(nextDirection(day)).to.equal("out");
	});

	it("reports 'in' for a balanced day", () => {
		expect(nextDirection(buildDayPunches(entries(at(8), at(12))))).to.equal("in");
		expect(nextDirection(buildDayPunches([]))).to.equal("in");
	});

	it("sorts by timestamp and id", () => {
		const unsorted: PunchEntry[] = [
			{ id: 4, tsUtc: at(17) },
			{ id: 2, tsUtc: at(12) },
			{ id: 1, tsUtc: at(8) },
			{ id: 3, tsUtc: at(13) },
		];
		const day = buildDayPunches(unsorted);

		expect(day.pairs[0].inEntry.id).to.equal(1);
		expect(day.pairs[0].outEntry?.id).to.equal(2);
		expect(day.pairs[1].inEntry.id).to.equal(3);
		expect(day.pairs[1].outEntry?.id).to.equal(4);
	});

	it("ignores immediate repetitions (duplicate protection)", () => {
		const day = buildDayPunches(entries(at(8), at(8) + 10, at(17)));

		expect(day.pairs).to.have.lengthOf(1);
		expect(day.pairs[0].minutes).to.equal(540);
		expect(day.workedMinutes).to.equal(540);
		expect(day.hasOpenEntry).to.equal(false);
	});

	it("honours a custom duplicate distance", () => {
		const day = buildDayPunches(entries(at(8), at(8) + 600, at(17)), { minDistanceSeconds: 900 });

		expect(day.pairs).to.have.lengthOf(1);
		expect(day.pairs[0].minutes).to.equal(540);
	});

	it("ignores pending and conflicted punches", () => {
		const list: PunchEntry[] = [
			{ id: 1, tsUtc: at(8) },
			{ id: 2, tsUtc: at(12), syncState: "conflict" },
			{ id: 3, tsUtc: at(13), syncState: "pending" },
			{ id: 4, tsUtc: at(17) },
		];
		const day = buildDayPunches(list);

		expect(day.pairs).to.have.lengthOf(1);
		expect(day.pairs[0].minutes).to.equal(540);
		expect(day.hasOpenEntry).to.equal(false);
	});

	it("treats identical timestamps as a zero length pair", () => {
		const day = buildDayPunches([
			{ id: 1, tsUtc: at(8) },
			{ id: 2, tsUtc: at(8) + 60 },
		]);

		expect(day.workedMinutes).to.equal(1);
	});

	it("returns an empty result for no punches", () => {
		const day = buildDayPunches([]);
		expect(day.pairs).to.deep.equal([]);
		expect(day.workedMinutes).to.equal(0);
		expect(day.firstInUtc).to.equal(null);
		expect(day.lastOutUtc).to.equal(null);
	});
});

describe("employment window", () => {
	const start = at(8);
	const end = at(17);

	it("accepts punches inside the window", () => {
		expect(checkEmploymentWindow(at(12), { startDate: start, endDate: end })).to.equal(null);
	});

	it("rejects punches before the start date", () => {
		expect(checkEmploymentWindow(start - 1, { startDate: start, endDate: null })).to.equal("before_start_date");
	});

	it("rejects punches after the end date", () => {
		expect(checkEmploymentWindow(end + 1, { startDate: null, endDate: end })).to.equal("after_end_date");
	});

	it("accepts everything when no window is set", () => {
		expect(checkEmploymentWindow(at(12), {})).to.equal(null);
	});
});

describe("quick rounding", () => {
	it("rounds to the nearest step", () => {
		// nearest multiple wins: 7:57 is closer to 7:55, 7:59 is closer to 8:00
		// (the manual “7.57 to 8.02 → 8:00” example is imprecise by one minute)
		expect(utcToWallTime(roundToStep(at(7, 57), 5, berlin), berlin)).to.equal(wall(2026, 1, 1, 7, 55));
		expect(utcToWallTime(roundToStep(at(7, 59), 5, berlin), berlin)).to.equal(wall(2026, 1, 1, 8, 0));
		expect(utcToWallTime(roundToStep(at(8, 2), 5, berlin), berlin)).to.equal(wall(2026, 1, 1, 8, 0));
		expect(utcToWallTime(roundToStep(at(7, 58), 15, berlin), berlin)).to.equal(wall(2026, 1, 1, 8, 0));
		expect(utcToWallTime(roundToStep(at(7, 57, 40), 5, berlin), berlin)).to.equal(wall(2026, 1, 1, 8, 0));
	});

	it("does nothing when rounding is disabled", () => {
		expect(roundToStep(at(7, 57), 0, berlin)).to.equal(at(7, 57));
	});

	it("shifts a rounded time out of the daylight saving gap", () => {
		// 29 March 2026: 02:00 → 03:00; 01:58 rounds to 02:00 which does not exist
		const rounded = roundToStep(wallTimeToUtc(wall(2026, 3, 29, 1, 58), berlin).tsUtc, 5, berlin);
		expect(utcToWallTime(rounded, berlin)).to.equal(wall(2026, 3, 29, 3, 0));
	});
});
