/// <reference types="mocha" />
import { expect } from "chai";
import {
	activeWorkdayCount,
	dailyTargetMinutes,
	isWorkdayOn,
	parseWorkdays,
	targetForDay,
	weeklyTargetMinutes,
	type WorkProfile,
} from "./target";

const fullTime: WorkProfile = { percent: 100, weeklyHours: 42.5, workdays: "0;1;1;1;1;1;0" };

describe("target time", () => {
	it("parses the working days with Sunday as index 0", () => {
		const days = parseWorkdays("0;1;1;1;1;1;0");

		expect(days).to.deep.equal([false, true, true, true, true, true, false]);
		expect(isWorkdayOn("0;1;1;1;1;1;0", 0)).to.equal(false); // Sunday
		expect(isWorkdayOn("0;1;1;1;1;1;0", 1)).to.equal(true); // Monday
		expect(isWorkdayOn("0;1;1;1;1;1;0", 6)).to.equal(false); // Saturday
		expect(activeWorkdayCount("0;1;1;1;1;1;0")).to.equal(5);
	});

	it("tolerates short or malformed values", () => {
		expect(parseWorkdays("0;1")).to.deep.equal([false, true, false, false, false, false, false]);
		expect(activeWorkdayCount("")).to.equal(0);
	});

	it("computes the weekly target", () => {
		expect(weeklyTargetMinutes(fullTime)).to.equal(2550); // 42.5 h
		expect(weeklyTargetMinutes({ ...fullTime, percent: 80 })).to.equal(2040); // 34 h
	});

	it("computes the daily target", () => {
		expect(dailyTargetMinutes(fullTime)).to.equal(510); // 8.5 h
		expect(dailyTargetMinutes({ ...fullTime, percent: 80 })).to.equal(408); // 6.8 h
		// 42.5 h over 6 days = 7.0833… → rounded to 7.08 h (two decimal rounding)
		expect(dailyTargetMinutes({ ...fullTime, workdays: "0;1;1;1;1;1;1" })).to.equal(425);
	});

	it("returns zero when no working day is configured", () => {
		expect(dailyTargetMinutes({ ...fullTime, workdays: "0;0;0;0;0;0;0" })).to.equal(0);
	});

	it("returns zero on non-working days and holidays", () => {
		expect(targetForDay({ profile: fullTime, weekday: 0 })).to.equal(0); // Sunday
		expect(targetForDay({ profile: fullTime, weekday: 6 })).to.equal(0); // Saturday
		expect(targetForDay({ profile: fullTime, weekday: 1, isHoliday: true })).to.equal(0);
		expect(targetForDay({ profile: fullTime, weekday: 1 })).to.equal(510);
	});

	it("returns zero outside the employment window", () => {
		expect(targetForDay({ profile: fullTime, weekday: 1, isBeforeStart: true })).to.equal(0);
		expect(targetForDay({ profile: fullTime, weekday: 1, isAfterEnd: true })).to.equal(0);
	});

	it("credits absences according to factor and day portion", () => {
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 100, dayPortion: 1 } })).to.equal(0);
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 100, dayPortion: 0.5 } })).to.equal(
			255,
		);
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 50, dayPortion: 1 } })).to.equal(255);
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 50, dayPortion: 0.5 } })).to.equal(383);
	});

	it("clamps invalid portions and factors", () => {
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 100, dayPortion: 2 } })).to.equal(0);
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 100, dayPortion: 0 } })).to.equal(510);
		expect(targetForDay({ profile: fullTime, weekday: 1, absence: { factor: 250, dayPortion: 1 } })).to.equal(0);
	});
});
