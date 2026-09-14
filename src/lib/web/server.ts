/**
 * HTTP server that mounts the router on a Node http server.
 *
 * This is the adapter's own port (`native.port`): the PWA, the REST API and the kiosk terminal are served on
 * it. The server only translates between Node's request/response objects and the router — all routing,
 * authentication, RBAC and error handling live in the router and the API.
 *
 * Safety nets: the body is limited while it is being read (a client cannot fill the memory), the bind address
 * defaults to the local machine and a failure to bind never stops the adapter (the API is reported as
 * unavailable instead).
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpProblem } from "./problem";
import type { HttpRequest, Router } from "./router";

/** Minimal logger used by the server. */
export interface ServerLogger {
	/** Informational message */
	info(message: string): void;
	/** Warning */
	warn(message: string): void;
	/** Error */
	error(message: string): void;
}

/** Options of the HTTP server. */
export interface WebServerOptions {
	/** Router that handles the requests */
	router: Router;
	/** Port to listen on (`0` picks a free port) */
	port: number;
	/** Bind address, default `127.0.0.1` */
	bind?: string;
	/** Maximum body size in bytes (default 256 KiB) */
	maxBodyBytes?: number;
	/** Logger */
	log?: ServerLogger;
}

/** A running server. */
export interface WebServer {
	/** Port the server is listening on */
	readonly port: number;
	/** Base URL of the server, e.g. `http://127.0.0.1:8082` */
	readonly url: string;
	/** Stops the server and closes all connections */
	close(): Promise<void>;
}

/**
 * Reads the request body up to a limit.
 *
 * @param request - incoming request
 * @param maxBytes - maximum number of bytes
 * @returns body as text or `null` when the limit is exceeded
 */
async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > maxBytes) {
			return null;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Builds the query map of a request, repeated names become arrays.
 *
 * @param requestUrl - raw request URL
 * @returns query parameters
 */
function parseQuery(requestUrl: string): Record<string, string | string[]> {
	const url = new URL(requestUrl, "http://localhost");
	const query: Record<string, string | string[]> = {};
	for (const key of new Set(url.searchParams.keys())) {
		const values = url.searchParams.getAll(key);
		query[key] = values.length > 1 ? values : (values[0] ?? "");
	}
	return query;
}

/**
 * Starts the HTTP server.
 *
 * @param options - router, port and limits
 * @returns the running server
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
	const bind = options.bind?.trim() || "127.0.0.1";

	const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
		try {
			const body = await readBody(request, maxBodyBytes);
			if (body === null) {
				const details = new HttpProblem(413, "payload_too_large", `body exceeds ${maxBodyBytes} bytes`);
				response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
				response.end(JSON.stringify(details.toProblem(request.url ?? "/")));
				return;
			}

			const url = new URL(request.url ?? "/", "http://localhost");
			const routerRequest: HttpRequest = {
				method: request.method ?? "GET",
				path: url.pathname,
				query: parseQuery(request.url ?? "/"),
				headers: request.headers,
				body,
				remoteAddress: request.socket.remoteAddress ?? null,
			};

			const result = await options.router.handle(routerRequest);
			response.writeHead(result.status, result.headers);
			response.end(result.body);
		} catch (error) {
			// the router never throws, so this is an unexpected failure of the transport itself
			options.log?.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!response.headersSent) {
				response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
			}
			response.end();
		}
	};

	const server = http.createServer((request, response) => {
		void handle(request, response);
	});
	server.on("clientError", (_error, socket) => socket.destroy());

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		server.once("error", onError);
		server.listen(options.port, bind, () => {
			server.off("error", onError);
			resolve();
		});
	});

	const address = server.address() as AddressInfo | null;
	const port = address?.port ?? options.port;
	options.log?.info(`API listening on http://${bind}:${port}`);

	return {
		port,
		url: `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}`,
		close: async (): Promise<void> => {
			await new Promise<void>(resolve => {
				server.close(() => resolve());
				// keep-alive connections would delay the shutdown
				server.closeAllConnections();
			});
		},
	};
}
