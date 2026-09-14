/// <reference types="mocha" />
import { expect } from "chai";
import { applyPauses, pauseRuleForPair, type PauseRule } from "./breaks";

const graduated: PauseRule[] = [
	{ fromMin: 0, toMin: 360, pauseMin: 0 },
	{ fromMin: 360, toMin: 540, pauseMin: 30 },
	{ fromMin: 540, toMin: null, pauseMin: 45 },
];

describe("break rules", () => {
	it("matches the graduated rule for a pair duration", () => {
		expect(pauseRuleForPair(300, graduated)).to.equal(null);
		expect(pauseRuleForPair(400, graduated)?.pauseMin).to.equal(30);
		expect(pauseRuleForPair(600, graduated)?.pauseMin).to.equal(45);
	});

	it("treats the boundaries as documented", () => {
		expect(pauseRuleForPair(360, graduated)?.pauseMin).to.equal(30); // fromMin inclusive
		expect(pauseRuleForPair(540, graduated)?.pauseMin).to.equal(45); // toMin exclusive
		expect(pauseRuleForPair(539, graduated)?.pauseMin).to.equal(30);
	});

	it("deducts once per pair, not once per day", () => {
		const result = applyPauses([{ minutes: 400 }, { minutes: 400 }], graduated);

		expect(result.perPair.map(entry => entry.pauseMin)).to.deep.equal([30, 30]);
		expect(result.breakMinutes).to.equal(60);
		expect(result.grossMinutes).to.equal(800);
		expect(result.workedMinutes).to.equal(740);
	});

	it("keeps pairs below the threshold untouched", () => {
		const result = applyPauses([{ minutes: 200 }, { minutes: 100 }], graduated);

		expect(result.breakMinutes).to.equal(0);
		expect(result.workedMinutes).to.equal(300);
		expect(result.perPair[0].rule).to.equal(null);
	});

	it("ignores inactive rules", () => {
		const rules: PauseRule[] = [{ fromMin: 0, toMin: null, pauseMin: 30, isActive: false }];
		expect(applyPauses([{ minutes: 400 }], rules).breakMinutes).to.equal(0);
	});

	it("never deducts more than the pair itself", () => {
		const rules: PauseRule[] = [{ fromMin: 0, toMin: null, pauseMin: 30 }];
		const result = applyPauses([{ minutes: 20 }], rules);

		expect(result.breakMinutes).to.equal(20);
		expect(result.workedMinutes).to.equal(0);
	});

	it("sorts rules by their lower bound", () => {
		const unsorted: PauseRule[] = [
			{ fromMin: 540, toMin: null, pauseMin: 45 },
			{ fromMin: 360, toMin: 540, pauseMin: 30 },
		];
		expect(pauseRuleForPair(400, unsorted)?.pauseMin).to.equal(30);
		expect(pauseRuleForPair(600, unsorted)?.pauseMin).to.equal(45);
	});

	it("handles an empty rule set and empty pair list", () => {
		expect(applyPauses([{ minutes: 500 }], []).breakMinutes).to.equal(0);
		expect(applyPauses([], graduated).workedMinutes).to.equal(0);
	});
});
