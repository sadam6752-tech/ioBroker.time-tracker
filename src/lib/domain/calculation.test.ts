/// <reference types="mocha" />
import { expect } from "chai";
import { DateTime } from "luxon";
import {
	absenceDaysInRange,
	calculateDay,
	type DayCalculation,
	overtimeAfterPeriod,
	overtimeOfPeriod,
	sumPeriod,
	vacationBalance,
	vorholzeitForActiveMonths,
} from "./calculation";
import type { PunchEntry } from "./punch";
import type { WorkProfile } from "./target";

const berlin = "Europe/Berlin";
const mondayToFriday = "0;1;1;1;1;1;0";

/** Employment: 40 h per week at 100 %, five working days → 8 h (480 minutes) per day. */
const profile: WorkProfile = {
	percent: 100,
	weeklyHours: 40,
	workdays: mondayToFriday,
	startDate: null,
	endDate: null,
};

/**
 * Builds a punch at a local wall clock time.
 *
 * @param id - database id of the punch
 * @param iso - local date and time, `YYYY-MM-DDTHH:mm`
 * @returns punch entry
 */
function punch(id: number, iso: string): PunchEntry {
	return { id, tsUtc: Math.floor(DateTime.fromISO(iso, { zone: berlin }).toSeconds()) };
}

describe("calculation service", () => {
	describe("day calculation", () => {
		it("computes the balance of a full working day", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-07T08:00"), punch(2, "2026-01-07T17:00")],
				timeZone: berlin,
				localDate: "2026-01-07",
			});

			expect(day.weekday).to.equal(3);
			expect(day.grossMinutes).to.equal(540);
			expect(day.breakMinutes).to.equal(0);
			expect(day.workedMinutes).to.equal(540);
			expect(day.targetMinutes).to.equal(480);
			expect(day.balanceMinutes).to.equal(60);
			expect(day.hasOpenEntry).to.equal(false);
			expect(day.pairs).to.have.lengthOf(1);
		});

		it("deducts breaks per pair", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-07T08:00"), punch(2, "2026-01-07T17:30")],
				pauseRules: [{ fromMin: 360, pauseMin: 30 }],
				timeZone: berlin,
				localDate: "2026-01-07",
			});

			expect(day.grossMinutes).to.equal(570);
			expect(day.breakMinutes).to.equal(30);
			expect(day.workedMinutes).to.equal(540);
			expect(day.balanceMinutes).to.equal(60);
			expect(day.breaks.perPair[0].pauseMin).to.equal(30);
		});

		it("counts only completed pairs while a punch is open", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-07T08:00"), punch(2, "2026-01-07T12:00"), punch(3, "2026-01-07T13:00")],
				timeZone: berlin,
				localDate: "2026-01-07",
			});

			expect(day.hasOpenEntry).to.equal(true);
			expect(day.pairs).to.have.lengthOf(2);
			expect(day.pairs[1].minutes).to.equal(0);
			expect(day.workedMinutes).to.equal(240);
			expect(day.balanceMinutes).to.equal(-240);
			expect(day.firstInUtc).to.equal(punch(1, "2026-01-07T08:00").tsUtc);
			// while a punch is open there is no completed clock-out
			expect(day.lastOutUtc).to.equal(null);
		});

		it("ignores pending and conflicting punches", () => {
			const day = calculateDay({
				profile,
				entries: [
					punch(1, "2026-01-07T08:00"),
					{ ...punch(2, "2026-01-07T09:00"), syncState: "pending" },
					{ ...punch(3, "2026-01-07T13:00"), syncState: "conflict" },
					punch(4, "2026-01-07T17:00"),
				],
				timeZone: berlin,
				localDate: "2026-01-07",
			});

			expect(day.hasOpenEntry).to.equal(false);
			expect(day.workedMinutes).to.equal(540);
		});

		it("drops immediate repetitions of a punch", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-07T08:00"), punch(2, "2026-01-07T08:00"), punch(3, "2026-01-07T12:00")],
				timeZone: berlin,
				localDate: "2026-01-07",
			});

			expect(day.pairs).to.have.lengthOf(1);
			expect(day.workedMinutes).to.equal(240);
		});
	});

	describe("target time", () => {
		it("has no target on a weekend", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-10T08:00"), punch(2, "2026-01-10T12:00")],
				timeZone: berlin,
				localDate: "2026-01-10",
			});

			expect(day.weekday).to.equal(6);
			expect(day.targetMinutes).to.equal(0);
			expect(day.balanceMinutes).to.equal(240);
		});

		it("has no target on a holiday", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-05T08:00"), punch(2, "2026-01-05T16:00")],
				timeZone: berlin,
				localDate: "2026-01-05",
				isHoliday: true,
			});

			expect(day.targetMinutes).to.equal(0);
			expect(day.balanceMinutes).to.equal(480);
		});

		it("credits a half day of absence", () => {
			const day = calculateDay({
				profile,
				entries: [punch(1, "2026-01-07T08:00"), punch(2, "2026-01-07T12:00")],
				timeZone: berlin,
				localDate: "2026-01-07",
				absence: { factor: 100, dayPortion: 0.5 },
			});

			expect(day.targetMinutes).to.equal(240);
			expect(day.balanceMinutes).to.equal(0);
		});

		it("has no target outside the employment window", () => {
			const entries = [punch(1, "2026-01-07T08:00"), punch(2, "2026-01-07T12:00")];
			const before = calculateDay({
				profile: {
					...profile,
					startDate: Math.floor(DateTime.fromISO("2026-02-01", { zone: berlin }).toSeconds()),
				},
				entries,
				timeZone: berlin,
				localDate: "2026-01-07",
			});
			const after = calculateDay({
				profile: {
					...profile,
					endDate: Math.floor(DateTime.fromISO("2025-12-31", { zone: berlin }).toSeconds()),
				},
				entries,
				timeZone: berlin,
				localDate: "2026-01-07",
			});
			const inside = calculateDay({
				profile: {
					...profile,
					startDate: Math.floor(DateTime.fromISO("2026-01-05", { zone: berlin }).toSeconds()),
				},
				entries,
				timeZone: berlin,
				localDate: "2026-01-07",
			});

			expect(before.targetMinutes).to.equal(0);
			expect(after.targetMinutes).to.equal(0);
			// the day inside the window still has a target
			expect(inside.targetMinutes).to.equal(480);
		});
	});

	describe("period totals", () => {
		it("sums the days of a month", () => {
			const day = (worked: number, target: number, open = false): DayCalculation => ({
				localDate: "2026-01-07",
				weekday: 3,
				pairs: [],
				hasOpenEntry: open,
				firstInUtc: null,
				lastOutUtc: null,
				grossMinutes: worked,
				breakMinutes: 0,
				workedMinutes: worked,
				targetMinutes: target,
				balanceMinutes: worked - target,
				breaks: { perPair: [], breakMinutes: 0, grossMinutes: worked, workedMinutes: worked },
			});

			const totals = sumPeriod([day(540, 480), day(480, 480), day(300, 480, true)]);

			expect(totals.workedMinutes).to.equal(1320);
			expect(totals.targetMinutes).to.equal(1440);
			expect(totals.balanceMinutes).to.equal(-120);
			expect(totals.days).to.equal(3);
			expect(totals.openDays).to.equal(1);
			expect(overtimeOfPeriod([60, -30, -30])).to.equal(0);
		});
	});

	describe("overtime models", () => {
		it("carries the balance month by month and credits the Vorholzeit", () => {
			const result = overtimeAfterPeriod({
				model: "monthly",
				monthBalances: [60, -30],
				overtimeStartMinutes: 100,
				vorholzeitPerYearMinutes: 240,
				activeMonths: 2,
			});

			expect(result.monthOvertimeMinutes).to.equal(30);
			expect(result.vorholzeitMinutes).to.equal(40);
			expect(result.overtimeMinutes).to.equal(90);
			expect(result.pending).to.equal(false);
		});

		it("keeps the carryover with the yearly model until the year is complete", () => {
			const interim = overtimeAfterPeriod({
				model: "yearly",
				monthBalances: [60, 60, 60],
				overtimeStartMinutes: 480,
				vorholzeitPerYearMinutes: 120,
				completeYear: false,
			});

			expect(interim.pending).to.equal(true);
			expect(interim.monthOvertimeMinutes).to.equal(180);
			expect(interim.vorholzeitMinutes).to.equal(0);
			expect(interim.overtimeMinutes).to.equal(480);

			const closed = overtimeAfterPeriod({
				model: "yearly",
				monthBalances: [60, 60, 60],
				overtimeStartMinutes: 480,
				vorholzeitPerYearMinutes: 120,
				activeMonths: 12,
				completeYear: true,
			});

			expect(closed.pending).to.equal(false);
			expect(closed.vorholzeitMinutes).to.equal(120);
			expect(closed.overtimeMinutes).to.equal(540);
		});

		it("carries the cumulative balance across the year boundary and subtracts payouts", () => {
			const withPayout = overtimeAfterPeriod({
				model: "cumulative",
				monthBalances: [600],
				overtimeStartMinutes: 0,
				payoutMinutes: 200,
			});
			expect(withPayout.overtimeMinutes).to.equal(400);

			const nextYear = overtimeAfterPeriod({
				model: "cumulative",
				monthBalances: [60],
				overtimeStartMinutes: withPayout.overtimeMinutes,
			});
			expect(nextYear.overtimeMinutes).to.equal(460);
		});

		it("credits the Vorholzeit proportionally", () => {
			expect(vorholzeitForActiveMonths(1200, 12)).to.equal(1200);
			expect(vorholzeitForActiveMonths(1200, 6)).to.equal(600);
			expect(vorholzeitForActiveMonths(1200, 1)).to.equal(100);
			expect(vorholzeitForActiveMonths(1200, 0)).to.equal(0);
			expect(vorholzeitForActiveMonths(1200, 14)).to.equal(1200);
			expect(vorholzeitForActiveMonths(1200, -3)).to.equal(0);
			expect(vorholzeitForActiveMonths(100, 5)).to.equal(42); // 41.67 rounded
		});
	});

	describe("vacation", () => {
		it("computes the remaining vacation days", () => {
			const result = vacationBalance({ carryoverDays: 5, perYearDays: 25, usedDays: 3, plannedDays: 2 });

			expect(result.entitlementDays).to.equal(30);
			expect(result.leftDays).to.equal(27);
			expect(result.plannedDays).to.equal(2);
			expect(result.availableDays).to.equal(25);
		});

		it("supports half days without float noise", () => {
			const result = vacationBalance({ carryoverDays: 0.5, perYearDays: 0, usedDays: 0.5 });
			expect(result.leftDays).to.equal(0);
		});

		it("counts only working days and skips holidays", () => {
			const week = { from: "2026-01-05", to: "2026-01-11", workdays: mondayToFriday, timeZone: berlin };

			expect(absenceDaysInRange(week)).to.equal(5);
			expect(absenceDaysInRange({ ...week, holidays: new Set(["2026-01-06"]) })).to.equal(4);
			expect(absenceDaysInRange({ ...week, dayPortion: 0.5 })).to.equal(2.5);
			expect(absenceDaysInRange({ ...week, dayPortion: 0 })).to.equal(0);
			expect(absenceDaysInRange({ ...week, holidays: new Set(["2026-01-06"]), dayPortion: 0.5 })).to.equal(2);
		});

		it("counts nothing on a weekend-only range", () => {
			expect(
				absenceDaysInRange({
					from: "2026-01-10",
					to: "2026-01-11",
					workdays: mondayToFriday,
					timeZone: berlin,
				}),
			).to.equal(0);
		});

		it("handles an empty range", () => {
			expect(
				absenceDaysInRange({
					from: "2026-01-08",
					to: "2026-01-05",
					workdays: mondayToFriday,
					timeZone: berlin,
				}),
			).to.equal(0);
		});
	});
});
