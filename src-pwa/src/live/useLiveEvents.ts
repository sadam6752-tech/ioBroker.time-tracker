/**
 * Live updates of the web app.
 *
 * The app subscribes to the event stream of the adapter (`/api/stream`) and refreshes the queries as soon as
 * something changes, so a punch on the kiosk terminal appears on an open dashboard without a reload.
 *
 * The connection is a bonus, not a requirement: when it drops (or when the browser does not offer one), the app
 * keeps working from its own requests and reconnects with a growing pause instead of polling.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

/** Longest pause between two connection attempts. */
const MAX_RECONNECT_MS = 30_000;

/**
 * Subscribes to the event stream of the adapter.
 *
 * @param enabled - true while somebody is signed in
 */
export function useLiveEvents(enabled: boolean): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		const url = enabled ? api.streamUrl() : null;
		if (!url || typeof WebSocket === "undefined") {
			return;
		}

		let socket: WebSocket | null = null;
		let timer: number | null = null;
		let attempt = 0;
		let stopped = false;

		/** Opens a connection and schedules the next try when it closes. */
		const connect = (): void => {
			socket = new WebSocket(url);
			socket.onopen = () => {
				attempt = 0;
			};
			socket.onmessage = () => {
				// every event invalidates the cached figures; the screens that are open refetch immediately
				void queryClient.invalidateQueries();
			};
			socket.onerror = () => socket?.close();
			socket.onclose = () => {
				if (stopped) {
					return;
				}
				attempt += 1;
				timer = window.setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_MS));
			};
		};

		connect();

		return () => {
			stopped = true;
			if (timer !== null) {
				window.clearTimeout(timer);
			}
			socket?.close();
		};
	}, [enabled, queryClient]);
}
