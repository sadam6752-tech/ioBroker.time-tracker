/**
 * Offline queue of the web app.
 *
 * A punch is stored locally first (with a UUID as idempotency key) and only then sent. If the network is down,
 * the punch stays in the queue and is sent later via `POST /api/entries/sync`; the server recognises the
 * idempotency key, so a repeated send never creates a duplicate. Conflicts (a punch that arrived too late or
 * contradicts the stored day) are reported by the server and are resolved on the sync screen.
 */

/** Storage key of the queue. */
const STORAGE_KEY = "time-tracker.queue";

/** A punch waiting to be sent. */
export interface QueuedPunch {
	/** Idempotency key (UUID) that identifies the punch on the server */
	idempotencyKey: string;
	/** Instant of the punch, UTC epoch seconds */
	tsUtc: number;
	/** Direction the client assumed, `auto` lets the server decide */
	direction?: "in" | "out" | "auto";
	/** Optional note */
	note?: string;
	/** True when the punch should use the quick rounding of the instance */
	quick?: boolean;
	/** When the punch was recorded on the device */
	queuedAt: number;
}

/** The queue. */
export interface OfflineQueue {
	/** All queued punches, oldest first */
	list(): QueuedPunch[];
	/** Adds a punch and returns it */
	add(punch: Omit<QueuedPunch, "idempotencyKey" | "queuedAt"> & { idempotencyKey?: string }): QueuedPunch;
	/** Replaces the queue (after a successful sync) */
	replace(punches: QueuedPunch[]): void;
	/** Removes everything */
	clear(): void;
	/** Number of queued punches */
	size(): number;
}

/**
 * Creates a UUID for an idempotency key.
 *
 * @returns UUID string
 */
export function newIdempotencyKey(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// fallback for very old browsers: time plus random bits is enough for a key
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Creates the offline queue.
 *
 * @param storage - storage used for the queue (defaults to `localStorage`)
 * @param now - instant source, defaults to the system clock
 * @returns the queue
 */
export function createOfflineQueue(
	storage: Storage = window.localStorage,
	now: () => number = () => Date.now(),
): OfflineQueue {
	/**
	 * Reads the queue.
	 *
	 * @returns queued punches
	 */
	function read(): QueuedPunch[] {
		try {
			const raw = storage.getItem(STORAGE_KEY);
			if (!raw) {
				return [];
			}
			const parsed = JSON.parse(raw) as QueuedPunch[];
			return Array.isArray(parsed) ? parsed.filter(entry => typeof entry?.idempotencyKey === "string") : [];
		} catch {
			// a broken entry must not block the app
			return [];
		}
	}

	/**
	 * Writes the queue.
	 *
	 * @param punches - punches to store
	 */
	function write(punches: QueuedPunch[]): void {
		storage.setItem(STORAGE_KEY, JSON.stringify(punches));
	}

	return {
		list: read,

		add(punch): QueuedPunch {
			const entry: QueuedPunch = {
				idempotencyKey: punch.idempotencyKey ?? newIdempotencyKey(),
				tsUtc: punch.tsUtc,
				...(punch.direction ? { direction: punch.direction } : {}),
				...(punch.note ? { note: punch.note } : {}),
				...(punch.quick ? { quick: true } : {}),
				queuedAt: Math.floor(now() / 1000),
			};
			write([...read(), entry]);
			return entry;
		},

		replace(punches): void {
			write(punches);
		},

		clear(): void {
			storage.removeItem(STORAGE_KEY);
		},

		size: () => read().length,
	};
}

/** The queue used by the app. */
export const queue = createOfflineQueue();
