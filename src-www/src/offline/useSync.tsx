/**
 * Offline handling for punches.
 *
 * `useSync` owns the queue of this browser: it remembers punches that were recorded while the server was
 * unreachable, sends them as soon as the connection is back (`POST /api/entries/sync`) and reports the result.
 * The server identifies a punch by its idempotency key, so sending twice is harmless.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { queue, type QueuedPunch } from "./queue";

/** Result of a synchronisation run. */
export interface SyncOutcome {
	/** Accepted punches */
	accepted: number;
	/** Punches the server already knew */
	duplicates: number;
	/** Punches that ended up in the conflict list */
	conflicts: number;
}

/** Sync state. */
export interface SyncState {
	/** Queued punches */
	pending: QueuedPunch[];
	/** True when the browser reports a connection */
	online: boolean;
	/** True while a synchronisation runs */
	busy: boolean;
	/** Result of the last run */
	outcome: SyncOutcome | null;
	/** Records a punch: queued first, then sent */
	record(punch: { tsUtc: number; direction?: "in" | "out" | "auto"; note?: string; quick?: boolean }): QueuedPunch;
	/** Sends the queue */
	flush(): Promise<SyncOutcome | null>;
	/** Re-reads the queue from the storage */
	reload(): void;
}

const SyncContext = createContext<SyncState | null>(null);

/**
 * Provides the offline queue to the app.
 *
 * @param props - children
 * @param props.children - React children
 * @returns the provider
 */
export function SyncProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [pending, setPending] = useState<QueuedPunch[]>(() => queue.list());
	const [online, setOnline] = useState<boolean>(() => (typeof navigator === "undefined" ? true : navigator.onLine));
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

	const reload = useCallback((): void => {
		setPending(queue.list());
	}, []);

	/**
	 * Sends the whole queue.
	 *
	 * @returns result of the run or `null` when there was nothing to do
	 */
	const flush = useCallback(async (): Promise<SyncOutcome | null> => {
		const entries = queue.list();
		if (entries.length === 0) {
			setOutcome(null);
			return null;
		}

		setBusy(true);
		try {
			const result = await api.sync(
				entries.map(entry => ({
					idempotencyKey: entry.idempotencyKey,
					tsUtc: entry.tsUtc,
					...(entry.direction ? { direction: entry.direction } : {}),
					...(entry.note ? { note: entry.note } : {}),
				})),
			);
			// the queue is only cleared after the server acknowledged the batch
			queue.clear();
			reload();
			const summary: SyncOutcome = {
				accepted: result.accepted ?? 0,
				duplicates: result.duplicates ?? 0,
				conflicts: result.conflicts ?? 0,
			};
			setOutcome(summary);
			setOnline(true);
			return summary;
		} catch (error) {
			if (error instanceof ApiError && error.status === 0) {
				setOnline(false);
			}
			// the punches stay queued and are sent with the next attempt
			reload();
			return null;
		} finally {
			setBusy(false);
		}
	}, [reload]);

	/**
	 * Records a punch locally and tries to send it right away.
	 *
	 * @param punch - punch to record
	 * @returns the queued punch
	 */
	const record = useCallback(
		(punch: { tsUtc: number; direction?: "in" | "out" | "auto"; note?: string; quick?: boolean }): QueuedPunch => {
			const entry = queue.add(punch);
			reload();
			void flush();
			return entry;
		},
		[flush, reload],
	);

	useEffect(() => {
		/**
		 * Marks the app as offline.
		 */
		const goOffline = (): void => setOnline(false);
		/**
		 * Sends the queue when the browser is back online.
		 */
		const goOnline = (): void => {
			setOnline(true);
			void flush();
		};

		window.addEventListener("offline", goOffline);
		window.addEventListener("online", goOnline);
		return () => {
			window.removeEventListener("offline", goOffline);
			window.removeEventListener("online", goOnline);
		};
	}, [flush]);

	// a punch recorded in another tab shows up here as well
	useEffect(() => {
		/**
		 * Reloads the queue when the window gets focus.
		 */
		const onFocus = (): void => reload();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reload]);

	const value = useMemo<SyncState>(
		() => ({ pending, online, busy, outcome, record, flush, reload }),
		[pending, online, busy, outcome, record, flush, reload],
	);

	return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * Reads the offline state.
 *
 * @returns sync state
 */
export function useSync(): SyncState {
	const value = useContext(SyncContext);
	if (!value) {
		throw new Error("useSync must be used inside a SyncProvider");
	}
	return value;
}
