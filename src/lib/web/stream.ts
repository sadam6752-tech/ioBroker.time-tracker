/**
 * WebSocket endpoint `/api/stream`.
 *
 * Clients connect with their session token as a query parameter (a browser cannot set headers on a WebSocket),
 * the token is checked with the same `AuthService` as the REST API. Each client only receives the events it is
 * allowed to see: its own ones, plus everything when it holds `report.view_other` (a manager or administrator).
 *
 * The connection is kept alive with protocol pings; a client that does not answer them is dropped. There is no
 * history: a client that reconnects reloads the data it needs over REST.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { AuthService } from "../services/auth";
import { parseCookies, SESSION_COOKIE } from "./cookies";
import type { ApiEvent, EventBus } from "./events";

/** Options of the stream endpoint. */
export interface EventStreamOptions {
	/** HTTP server the upgrade requests arrive on */
	server: Server;
	/** Path of the endpoint (default `/api/stream`) */
	path?: string;
	/** Authentication service used to check the token */
	auth: AuthService;
	/** Event bus that is forwarded */
	events: EventBus;
	/** Reported version in the greeting frame */
	version?: string;
	/** Instant source, defaults to the system clock */
	now?: () => number;
	/** Interval of the protocol pings in milliseconds (default 30 s) */
	pingIntervalMs?: number;
	/**
	 * Timer functions of the caller. The adapter passes its own (`this.setInterval`/`this.clearInterval`), so
	 * the ping timer belongs to the adapter and cannot outlive it; without them no ping is sent (tests do not
	 * need one).
	 */
	timers?: {
		setInterval: (handler: () => void, milliseconds: number) => TimerHandle;
		clearInterval: (handle: TimerHandle) => void;
	};
}

/**
 * Handle of a repeating timer: the adapter marks its own handles with a brand type, Node returns `Timeout`
 * objects. `null`/`undefined` are allowed because the adapter's own type declaration permits them.
 */
type TimerHandle = number | null | undefined | ReturnType<typeof setInterval>;

/** The running stream endpoint. */
export interface EventStream {
	/** Closes every connection and stops the endpoint */
	close(): Promise<void>;
	/** Number of connected clients */
	clientCount(): number;
}

/**
 * Attaches the event stream to an HTTP server.
 *
 * @param options - server, path, authentication and bus
 * @returns the running endpoint
 */
export function attachEventStream(options: EventStreamOptions): EventStream {
	const path = options.path ?? "/api/stream";
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));
	const pingIntervalMs = options.pingIntervalMs ?? 30_000;
	const wss = new WebSocketServer({ noServer: true });
	/** Connected clients with the user they belong to. */
	const clients = new Map<WebSocket, { userId: number; seesAll: boolean }>();

	/**
	 * Sends a frame to one client.
	 *
	 * @param socket - connection
	 * @param payload - object to serialise
	 */
	function send(socket: WebSocket, payload: unknown): void {
		if (socket.readyState === socket.OPEN) {
			socket.send(JSON.stringify(payload));
		}
	}

	/**
	 * Rejects an upgrade with a problem document.
	 *
	 * @param socket - raw socket of the request
	 * @param status - HTTP status code
	 * @param code - stable error code
	 */
	function reject(socket: Duplex, status: number, code: string): void {
		const reason = status === 401 ? "Unauthorized" : "Forbidden";
		const body = JSON.stringify({
			type: "about:blank",
			title: reason,
			status,
			code,
		});
		socket.write(
			`HTTP/1.1 ${status} ${reason}\r\n` +
				`content-type: application/problem+json; charset=utf-8\r\n` +
				`content-length: ${Buffer.byteLength(body)}\r\n` +
				`connection: close\r\n\r\n${body}`,
		);
		socket.destroy();
	}

	/**
	 * Reads the text of a received frame.
	 *
	 * The library hands the frame over as a `Buffer`, an `ArrayBuffer` or a list of buffers; only the text
	 * matters here, and a client only ever sends its own ping.
	 *
	 * @param raw - received frame
	 * @returns the frame as UTF-8 text
	 */
	function textOf(raw: RawData): string {
		const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		return buffer.toString("utf8");
	}

	/**
	 * Handles an upgrade request of the HTTP server.
	 *
	 * @param request - upgrade request
	 * @param socket - raw socket
	 * @param head - already read bytes
	 */
	function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== path) {
			// the API owns this path; anything else is not a websocket
			reject(socket, 404, "not_found");
			return;
		}

		// A browser cannot set headers on a handshake, but it does send cookies — so the session cookie counts as
		// well and the live stream works without a token in the URL (specification 4.10). The query parameter stays
		// for terminals and integration clients.
		const cookieToken = parseCookies(request.headers.cookie)[SESSION_COOKIE] ?? "";
		const token = url.searchParams.get("token") || cookieToken;
		const result = options.auth.authenticate({ token, now: now() });
		if (!result.ok) {
			reject(socket, result.error === "permission_denied" ? 403 : 401, result.error);
			return;
		}

		const context = result.context;
		wss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
			clients.set(websocket, {
				userId: context.user.id,
				// a manager or administrator sees the whole house, everybody else only themselves
				seesAll: context.permissions.includes("report.view_other"),
			});

			send(websocket, {
				type: "hello",
				atUtc: now(),
				userId: context.user.id,
				version: options.version ?? "0.0.0",
				subscribe: context.permissions.includes("report.view_other") ? "all" : "own",
			});

			websocket.on("close", () => clients.delete(websocket));
			websocket.on("error", () => clients.delete(websocket));
			websocket.on("message", raw => {
				// the only client message that is understood is a ping, everything else is ignored
				if (textOf(raw) === "ping") {
					send(websocket, { type: "pong", atUtc: now() });
				}
			});
		});
	}

	options.server.on("upgrade", onUpgrade);

	const unsubscribe = options.events.subscribe((event: ApiEvent) => {
		for (const [socket, client] of clients) {
			if (client.seesAll || event.userId === null || event.userId === client.userId) {
				send(socket, event);
			}
		}
	});

	// The adapter hands in its own timers, so the keep-alive ping is cleared with the adapter even when the
	// stream is never closed explicitly.
	const pingTimer =
		options.timers === undefined
			? null
			: options.timers.setInterval(() => {
					for (const socket of clients.keys()) {
						if (socket.readyState === socket.OPEN) {
							socket.ping();
						}
					}
				}, pingIntervalMs);

	return {
		async close(): Promise<void> {
			if (pingTimer !== null && options.timers !== undefined) {
				options.timers.clearInterval(pingTimer);
			}
			unsubscribe();
			options.server.off("upgrade", onUpgrade);
			for (const socket of [...clients.keys()]) {
				socket.close(1001, "server shutting down");
			}
			clients.clear();
			await new Promise<void>(resolve => wss.close(() => resolve()));
		},

		clientCount(): number {
			return clients.size;
		},
	};
}
