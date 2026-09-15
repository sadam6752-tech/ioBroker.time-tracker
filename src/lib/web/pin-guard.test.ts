/// <reference types="mocha" />
import { expect } from "chai";
import { createPinGuard } from "./pin-guard";

describe("pin guard", () => {
	it("counts the wrong PINs of an account and blocks it at the threshold", () => {
		const guard = createPinGuard({ maxFailures: 3, lockSeconds: 60 });

		expect(guard.fail({ userId: 7, now: 1000 })).to.deep.equal({
			locked: false,
			retryAfterSeconds: 0,
			failures: 1,
		});
		expect(guard.fail({ userId: 7, now: 1001 })).to.deep.equal({
			locked: false,
			retryAfterSeconds: 0,
			failures: 2,
		});
		expect(guard.fail({ userId: 7, now: 1002 })).to.deep.equal({
			locked: true,
			retryAfterSeconds: 60,
			failures: 3,
		});

		// while the block lasts nothing else is counted; it started with the third attempt at 1002
		expect(guard.state({ userId: 7, now: 1050 })).to.deep.equal({
			locked: true,
			retryAfterSeconds: 12,
			failures: 3,
		});
		expect(guard.fail({ userId: 7, now: 1050 }).locked).to.equal(true);
	});

	it("counts the accounts separately", () => {
		const guard = createPinGuard({ maxFailures: 2, lockSeconds: 60 });
		guard.fail({ userId: 1, now: 1000 });
		guard.fail({ userId: 1, now: 1000 });
		expect(guard.state({ userId: 1, now: 1000 }).locked).to.equal(true);
		expect(guard.state({ userId: 2, now: 1000 })).to.deep.equal({
			locked: false,
			retryAfterSeconds: 0,
			failures: 0,
		});
	});

	it("lets an account try again after the block", () => {
		const guard = createPinGuard({ maxFailures: 2, lockSeconds: 60 });
		guard.fail({ userId: 3, now: 1000 });
		guard.fail({ userId: 3, now: 1000 });

		// the block is over: the old failures do not count any more
		expect(guard.state({ userId: 3, now: 1060 })).to.deep.equal({
			locked: false,
			retryAfterSeconds: 0,
			failures: 0,
		});
		expect(guard.fail({ userId: 3, now: 1060 }).failures).to.equal(1);
	});

	it("starts the window over when the wrong PINs are spread over time", () => {
		const guard = createPinGuard({ maxFailures: 3, lockSeconds: 60 });
		guard.fail({ userId: 4, now: 1000 });
		guard.fail({ userId: 4, now: 1030 });

		// 70 seconds after the first failure the window is gone, so this is attempt one again
		const later = guard.fail({ userId: 4, now: 1070 });
		expect(later).to.deep.equal({ locked: false, retryAfterSeconds: 0, failures: 1 });
	});

	it("forgets the failures after a successful punch", () => {
		const guard = createPinGuard({ maxFailures: 3, lockSeconds: 60 });
		guard.fail({ userId: 5, now: 1000 });
		guard.fail({ userId: 5, now: 1001 });
		guard.reset(5);

		expect(guard.size()).to.equal(0);
		expect(guard.fail({ userId: 5, now: 1002 }).failures).to.equal(1);
	});

	it("cleans up the entries of accounts that are done", () => {
		const guard = createPinGuard({ maxFailures: 2, lockSeconds: 10 });
		for (let userId = 1; userId <= 1500; userId++) {
			guard.fail({ userId, now: 1000 + userId });
		}
		// the oldest windows are dropped once the map grows
		expect(guard.size()).to.be.lessThan(1500);
		expect(guard.state({ userId: 1500, now: 2500 }).failures).to.equal(1);
	});
});
