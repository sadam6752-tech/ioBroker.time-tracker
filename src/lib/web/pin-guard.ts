/**
 * Failure counter for the badge PIN at the kiosk terminal (specification 4.10).
 *
 * A four digit PIN is guessed in a few hundred attempts, and a terminal stands in a shared room: the IP rate
 * limit of the route alone is not enough, because everybody uses the same device. This guard therefore counts
 * the wrong PINs **per account** and blocks that account for a while after too many of them — exactly like the
 * login lockout, only much shorter, since a fat finger is more likely than an attack.
 *
 * The counters live in memory: a restart of the adapter clears them, which is documented and acceptable because
 * the block is a short lived brake, not a permanent lock. (The login lockout, which must survive a restart, is
 * kept in the database instead.)
 */

/** Options of the guard. */
export interface PinGuardOptions {
	/** Wrong PINs that are allowed inside one window (default 5) */
	maxFailures?: number;
	/** Length of the window and of the block in seconds (default 900 = 15 minutes) */
	lockSeconds?: number;
}

/** Result of a check. */
export interface PinGuardState {
	/** True while the account is blocked */
	locked: boolean;
	/** Seconds until the block ends or the window starts over */
	retryAfterSeconds: number;
	/** Wrong PINs inside the current window */
	failures: number;
}

/** The guard. */
export interface PinGuard {
	/** Reads the state of an account without changing it */
	state(input: { userId: number; now?: number }): PinGuardState;
	/** Counts a wrong PIN and returns the state afterwards */
	fail(input: { userId: number; now?: number }): PinGuardState;
	/** Forgets the wrong PINs of an account (called after a successful punch) */
	reset(userId: number): void;
	/** Number of accounts with a recorded failure (for diagnostics) */
	size(): number;
}

/** What is remembered per account. */
interface Entry {
	/** Wrong PINs since the window started */
	failures: number;
	/** Instant the window started, UTC epoch seconds */
	windowStartedAt: number;
	/** Instant the block ends, `0` while the account is not blocked */
	lockedUntil: number;
}

/**
 * Creates the guard.
 *
 * @param options - threshold and window
 * @returns the guard
 */
export function createPinGuard(options: PinGuardOptions = {}): PinGuard {
	const maxFailures = Math.max(1, options.maxFailures ?? 5);
	const lockSeconds = Math.max(1, options.lockSeconds ?? 15 * 60);
	const entries = new Map<number, Entry>();

	/**
	 * Drops entries whose window and block are over.
	 *
	 * @param now - current instant
	 */
	const prune = (now: number): void => {
		for (const [userId, entry] of entries) {
			const over = now >= entry.lockedUntil && now - entry.windowStartedAt >= lockSeconds;
			if (over) {
				entries.delete(userId);
			}
		}
	};

	/**
	 * Reads the state, resetting an expired window on the way.
	 *
	 * @param userId - account
	 * @param now - current instant
	 * @returns the state
	 */
	const state = (userId: number, now: number): PinGuardState => {
		const entry = entries.get(userId);
		if (!entry) {
			return { locked: false, retryAfterSeconds: 0, failures: 0 };
		}
		if (now < entry.lockedUntil) {
			return { locked: true, retryAfterSeconds: entry.lockedUntil - now, failures: entry.failures };
		}
		if (now - entry.windowStartedAt >= lockSeconds) {
			// the window is over: the next attempt starts from zero
			entries.delete(userId);
			return { locked: false, retryAfterSeconds: 0, failures: 0 };
		}
		return {
			locked: false,
			retryAfterSeconds: lockSeconds - (now - entry.windowStartedAt),
			failures: entry.failures,
		};
	};

	return {
		state: ({ userId, now = Math.floor(Date.now() / 1000) }) => state(userId, now),

		fail: ({ userId, now = Math.floor(Date.now() / 1000) }) => {
			const current = state(userId, now);
			if (current.locked) {
				return current;
			}
			if (entries.size > 1000) {
				prune(now);
			}
			const entry = entries.get(userId);
			const failures = (entry?.failures ?? 0) + 1;
			const windowStartedAt = entry?.windowStartedAt ?? now;
			if (failures >= maxFailures) {
				entries.set(userId, { failures, windowStartedAt, lockedUntil: now + lockSeconds });
				return { locked: true, retryAfterSeconds: lockSeconds, failures };
			}
			entries.set(userId, { failures, windowStartedAt, lockedUntil: 0 });
			return { locked: false, retryAfterSeconds: 0, failures };
		},

		reset: (userId: number) => {
			entries.delete(userId);
		},

		size: () => entries.size,
	};
}
