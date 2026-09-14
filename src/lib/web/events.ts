/**
 * Live events of the adapter.
 *
 * Everything that changes data publishes one event here: a punch, a correction, an import, a closed month. The
 * WebSocket endpoint (`/api/stream`) forwards them to connected clients, and the adapter uses the same bus to
 * refresh its own states. The bus is deliberately tiny: an in-memory fan-out without history, because a client
 * that missed an event reloads the data it cares about anyway.
 */

/** Type of a live event. */
export type EventType =
	| "punch"
	| "entry.update"
	| "entry.delete"
	| "entries.import"
	| "absence.change"
	| "month.close"
	| "terminal.punch"
	| "rfid.scan";

/** One live event. */
export interface ApiEvent {
	/** Kind of the change */
	type: EventType;
	/** Instant of the change, UTC epoch seconds */
	atUtc: number;
	/** Employee the change belongs to, `null` for instance wide events */
	userId: number | null;
	/** Short, client readable summary (never personal data beyond the id) */
	data?: Record<string, unknown>;
}

/** A subscriber of the bus. */
export type EventListener = (event: ApiEvent) => void;

/** The event bus. */
export interface EventBus {
	/** Publishes an event to every listener */
	publish(event: ApiEvent): void;
	/** Registers a listener and returns the function that removes it again */
	subscribe(listener: EventListener): () => void;
	/** Number of connected listeners */
	listenerCount(): number;
}

/**
 * Creates an event bus.
 *
 * @returns the bus
 */
export function createEventBus(): EventBus {
	const listeners = new Set<EventListener>();

	return {
		publish(event: ApiEvent): void {
			// a listener that throws must not break the others (or the request that published)
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch {
					// ignored on purpose: the event is a notification, not a transaction
				}
			}
		},

		subscribe(listener: EventListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		listenerCount(): number {
			return listeners.size;
		},
	};
}
