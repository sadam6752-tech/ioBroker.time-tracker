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
import { HttpProblem, PROBLEM_CONTENT_TYPE } from "./problem";
import { DEFAULT_MAX_BODY_BYTES, type HttpRequest, type Router } from "./router";
import type { StaticHandler } from "./static";
import { attachEventStream, type EventStream, type EventStreamOptions } from "./stream";

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
	/** Path prefix the API is mounted on (default `/api`) */
	apiPrefix?: string;
	/** Handler for the files of the web interface (PWA) */
	staticFiles?: StaticHandler;
	/** Live event stream (`/api/stream`); without it the endpoint does not exist */
	stream?: Omit<EventStreamOptions, "server">;
	/** Maximum body size in bytes (default 2 MiB) */
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
	/** Live event stream, when one is configured */
	readonly stream?: EventStream;
	/** Stops the server and closes all connections */
	close(): Promise<void>;
}

/**
 * Normalises a path prefix.
 *
 * @param prefix - configured prefix
 * @returns prefix without trailing slash (`""` disables the prefix)
 */
function normalizePrefix(prefix: string): string {
	const trimmed = prefix.trim();
	if (trimmed === "" || trimmed === "/") {
		return "";
	}
	return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

/**
 * Reads the request body up to a limit.
 *
 * A body that is not text is kept as bytes: an uploaded backup has to arrive byte for byte. Everything else is
 * decoded here, because the endpoints expect a JSON document.
 *
 * @param request - incoming request
 * @param maxBytes - maximum number of bytes
 * @returns body as text or bytes, `null` when the limit is exceeded
 */
async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<string | Buffer | null> {
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

	const body = Buffer.concat(chunks);
	// the raw upload arrives as bytes; a JSON document is decoded right away
	return (request.headers["content-type"] ?? "").toLowerCase().startsWith("application/octet-stream")
		? body
		: body.toString("utf8");
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
 * Normalises the bind address of the instance settings.
 *
 * The admin offers the local addresses of the host in a list, and a value may come back in the `host:port` form
 * (`[::1]:8082` for IPv6) or as a wildcard. `listen` expects the address alone and the port comes from the
 * instance, so such a value cannot make the server fail to start. An empty value means "this machine only".
 *
 * @param value - raw value of the instance settings
 * @returns the address to bind to
 */
export function normalizeBindAddress(value: string | null | undefined): string {
	const raw = (value ?? "").trim();
	if (raw === "") {
		return "127.0.0.1";
	}
	if (raw === "*") {
		return "0.0.0.0";
	}
	// [::1]:8082 or 192.168.1.5:8082 - the port belongs to the instance, not to the address
	const bracketed = /^\[([^\]]+)]:\d+$/.exec(raw);
	if (bracketed) {
		return bracketed[1];
	}
	const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw);
	if (withPort) {
		return withPort[1];
	}
	return raw;
}

/**
 * Starts the HTTP server.
 *
 * @param options - router, port and limits
 * @returns the running server
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const bind = normalizeBindAddress(options.bind);
	const apiPrefix = normalizePrefix(options.apiPrefix ?? "/api");

	const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
		try {
			const body = await readBody(request, maxBodyBytes);
			if (body === null) {
				const details = new HttpProblem(413, "payload_too_large", `body exceeds ${maxBodyBytes} bytes`);
				response.writeHead(413, { "content-type": PROBLEM_CONTENT_TYPE });
				response.end(JSON.stringify(details.toProblem(request.url ?? "/")));
				return;
			}

			const url = new URL(request.url ?? "/", "http://localhost");
			const headers = request.headers;
			const remoteAddress = request.socket.remoteAddress ?? null;

			// the API lives below the prefix; everything else is a file of the web interface
			if (apiPrefix !== "" && url.pathname.startsWith(`${apiPrefix}/`)) {
				const routerRequest: HttpRequest = {
					method: request.method ?? "GET",
					path: url.pathname.slice(apiPrefix.length),
					query: parseQuery(request.url ?? "/"),
					headers,
					body,
					remoteAddress,
				};
				const result = await options.router.handle(routerRequest);
				response.writeHead(result.status, result.headers);
				response.end(result.body);
				return;
			}

			const staticRequest: HttpRequest = {
				method: request.method ?? "GET",
				path: url.pathname,
				query: parseQuery(request.url ?? "/"),
				headers,
				body,
				remoteAddress,
			};
			const file = options.staticFiles?.(staticRequest) ?? null;
			if (file) {
				response.writeHead(file.status, file.headers);
				response.end(file.body);
				return;
			}

			response.writeHead(404, { "content-type": PROBLEM_CONTENT_TYPE });
			response.end(
				JSON.stringify(
					new HttpProblem(404, "not_found", `no route for ${url.pathname}`).toProblem(url.pathname),
				),
			);
		} catch (error) {
			// the router never throws, so this is an unexpected failure of the transport itself
			options.log?.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!response.headersSent) {
				response.writeHead(500, { "content-type": PROBLEM_CONTENT_TYPE });
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
	const stream = options.stream
		? attachEventStream({
				...options.stream,
				server,
				path: options.stream.path ?? `${apiPrefix}/stream`,
			})
		: undefined;
	options.log?.info(
		`API listening on http://${bind}:${port}${apiPrefix}${
			options.staticFiles ? " - web interface is served from disk" : ""
		}${stream ? " - live events on /stream" : ""}`,
	);

	return {
		port,
		url: `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}`,
		stream,
		close: async (): Promise<void> => {
			await stream?.close();
			await new Promise<void>(resolve => {
				server.close(() => resolve());
				// keep-alive connections would delay the shutdown
				server.closeAllConnections();
			});
		},
	};
}
