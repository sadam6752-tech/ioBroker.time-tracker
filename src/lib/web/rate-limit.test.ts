/// <reference types="mocha" />
import { expect } from "chai";
import { createRateLimiter, type RateLimitOptions } from "./rate-limit";

/** Limit used by the tests. */
const LIMIT: RateLimitOptions = { name: "test", limit: 3, windowSeconds: 60 };

describe("rate limiter", () => {
	it("allows the limit and blocks the next request", () => {
		const limiter = createRateLimiter();

		for (let attempt = 1; attempt <= LIMIT.limit; attempt++) {
			const result = limiter.check(LIMIT, "127.0.0.1", 1000);
			expect(result.allowed, `attempt ${attempt}`).to.equal(true);
			expect(result.remaining).to.equal(LIMIT.limit - attempt);
		}

		const blocked = limiter.check(LIMIT, "127.0.0.1", 1000);
		expect(blocked.allowed).to.equal(false);
		expect(blocked.remaining).to.equal(0);
		// the oldest request leaves the window at 1060, so the client waits 60 seconds
		expect(blocked.retryAfterSeconds).to.equal(60);

		// still blocked shortly before the window ends
		expect(limiter.check(LIMIT, "127.0.0.1", 1059).allowed).to.equal(false);
		// and allowed again afterwards
		expect(limiter.check(LIMIT, "127.0.0.1", 1061).allowed).to.equal(true);
	});

	it("counts per key and per class", () => {
		const limiter = createRateLimiter();

		for (let attempt = 0; attempt < LIMIT.limit; attempt++) {
			limiter.check(LIMIT, "10.0.0.1", 1000);
		}
		expect(limiter.check(LIMIT, "10.0.0.1", 1000).allowed).to.equal(false);
		// another client and another route class are unaffected
		expect(limiter.check(LIMIT, "10.0.0.2", 1000).allowed).to.equal(true);
		expect(limiter.check({ ...LIMIT, name: "other" }, "10.0.0.1", 1000).allowed).to.equal(true);
	});

	it("forgets keys that are no longer active", () => {
		const limiter = createRateLimiter();
		limiter.check(LIMIT, "a", 1000);
		expect(limiter.size()).to.equal(1);

		// filling the map far enough triggers the pruning of expired keys
		for (let index = 0; index < 1001; index++) {
			limiter.check({ ...LIMIT, name: `class-${index}` }, "b", 1000 + LIMIT.windowSeconds + 1);
		}
		expect(limiter.check(LIMIT, "a", 1000 + LIMIT.windowSeconds + 1).allowed).to.equal(true);

		limiter.reset();
		expect(limiter.size()).to.equal(0);
	});
});
