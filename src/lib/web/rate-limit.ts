/**
 * Rate limiting for the API.
 *
 * A simple sliding window per key (route + client address) is enough here: the endpoints that matter are the
 * login, the punches, the synchronisation, the terminal and the RFID scan, and all of them are cheap to count.
 * The limiter lives in memory — a restart clears the counters, which is acceptable for a single instance and
 * avoids a table that would grow forever.
 *
 * The answer for a limited request is a `429` problem document with a `retry-after` header, so a client knows
 * when to try again.
 */

/** A limit of one route class. */
export interface RateLimitOptions {
	/** Name of the class, used in the counter key (e.g. `login`) */
	name: string;
	/** Allowed requests inside the window */
	limit: number;
	/** Length of the window in seconds */
	windowSeconds: number;
}

/** Result of a check. */
export interface RateLimitResult {
	/** False when the caller has to wait */
	allowed: boolean;
	/** Requests left in the current window */
	remaining: number;
	/** Seconds until the oldest request of the window leaves it */
	retryAfterSeconds: number;
}

/** The limiter. */
export interface RateLimiter {
	/** Counts a request and reports whether it may pass */
	check(options: RateLimitOptions, key: string, now?: number): RateLimitResult;
	/** Removes all counters (for tests) */
	reset(): void;
	/** Number of tracked keys (diagnostics) */
	size(): number;
}

/**
 * Creates a rate limiter.
 *
 * @returns the limiter
 */
export function createRateLimiter(): RateLimiter {
	/** Timestamps of the requests per key, oldest first. */
	const hits = new Map<string, number[]>();

	return {
		check(options: RateLimitOptions, key: string, now?: number): RateLimitResult {
			const timestamp = now ?? Math.floor(Date.now() / 1000);
			const windowStart = timestamp - options.windowSeconds;
			const id = `${options.name}:${key}`;

			// everything older than the window is irrelevant (and would only waste memory)
			const recent = (hits.get(id) ?? []).filter(at => at > windowStart);
			if (recent.length >= options.limit) {
				const oldest = recent[0];
				hits.set(id, recent);
				return {
					allowed: false,
					remaining: 0,
					retryAfterSeconds: Math.max(1, oldest + options.windowSeconds - timestamp),
				};
			}

			recent.push(timestamp);
			hits.set(id, recent);
			// a cheap guard against unbounded growth: prune the map when it gets large
			if (hits.size > 1000) {
				for (const [candidate, stamps] of hits) {
					if (stamps.every(at => at <= windowStart)) {
						hits.delete(candidate);
					}
				}
			}

			return { allowed: true, remaining: options.limit - recent.length, retryAfterSeconds: 0 };
		},

		reset(): void {
			hits.clear();
		},

		size(): number {
			return hits.size;
		},
	};
}
