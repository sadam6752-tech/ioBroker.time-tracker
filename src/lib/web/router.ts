/**
 * Server agnostic HTTP router.
 *
 * The router only sees plain request/response objects, so the same routes can later be mounted on an own HTTP
 * server (`native.port`) or be handed to the web extension of a `web` instance. Everything security relevant
 * happens here and not in the single handlers: session check, permission check (RBAC), CSRF token for state
 * changing requests and a body size limit.
 *
 * Handlers return `json(status, body)` or `noContent()`; any thrown error is converted by `toProblem`.
 */

import type { AuthContext, AuthService } from "../services/auth";
import { parseCookies, SESSION_COOKIE, serializeCookie } from "./cookies";
import { HttpProblem, PROBLEM_CONTENT_TYPE, toProblem, type ProblemCode, type ProblemDetails } from "./problem";
import { createRateLimiter } from "./rate-limit";

/** Supported HTTP methods. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A request as the router sees it (the body is already read and size limited). */
export interface HttpRequest {
	/** HTTP method, upper case */
	method: string;
	/** Path without query string, e.g. `/reports/day` */
	path: string;
	/** Query parameters, repeated names become arrays */
	query?: Record<string, string | string[] | undefined>;
	/** Request headers, names lower case */
	headers?: Record<string, string | string[] | undefined>;
	/** Raw body (JSON for our endpoints) */
	body?: string;
	/** Client address */
	remoteAddress?: string | null;
}

/** A response as the router produces it. */
export interface HttpResponse {
	/** HTTP status code */
	status: number;
	/** Response headers (lower case names) */
	headers: Record<string, string>;
	/** Response body, already serialised (a Buffer for binary content) */
	body: string | Buffer;
}

/** Result of a handler. */
export interface RouteResponse {
	/** HTTP status code */
	status: number;
	/** Body, serialised as JSON when it is not `undefined` */
	body?: unknown;
	/** Additional headers */
	headers?: Record<string, string>;
}

/** What a handler receives. */
export interface RouteContext {
	/** The incoming request */
	request: HttpRequest;
	/** Path parameters of the route */
	params: Record<string, string>;
	/** Authenticated context, `null` for public routes */
	auth: AuthContext | null;
	/** Session token of the request: the bearer header or, for browsers, the session cookie */
	sessionToken: string;
	/** True when no bearer header was sent and the session came from the cookie */
	viaCookie: boolean;
	/** True when the client talks HTTPS (a trusted proxy reported `x-forwarded-proto: https`) */
	secure: boolean;
	/** Reads a query parameter */
	query(name: string): string | null;
	/** Reads a request header */
	header(name: string): string | null;
	/** Parses the JSON body, throws `400 bad_request` when it is not usable */
	jsonBody<T = Record<string, unknown>>(): T;
	/** Parses the JSON body; an empty body becomes an empty object (optional fields) */
	optionalJsonBody<T = Record<string, unknown>>(): T;
}

/** A single route. */
export interface RouteDefinition {
	/** Method (or methods) the route answers */
	method: HttpMethod | HttpMethod[];
	/** Path pattern, `:name` marks a parameter, e.g. `/reports/day/:date` */
	path: string;
	/** Session required (default true) */
	requiresAuth?: boolean;
	/** Permission the caller has to hold */
	permission?: string;
	/** CSRF token required (default true for state changing methods) */
	requiresCsrf?: boolean;
	/** Rate limit of the route class (counted per client address) */
	rateLimit?: { name: string; limit: number; windowSeconds: number };
	/** Handler of the route */
	handler: (context: RouteContext) => RouteResponse | Promise<RouteResponse>;
}

/** Options of the router. */
export interface RouterOptions {
	/** Authentication service used for the session check */
	auth: AuthService;
	/** Maximum body size in bytes (default 2 MiB) */
	maxBodyBytes?: number;
	/** Instant source, defaults to the system clock */
	now?: () => number;
	/**
	 * Trusts the `x-forwarded-*` headers of a reverse proxy. Only switch this on when a proxy is really in
	 * front: the declared client address lands in the audit trail and decides the rate limit buckets, so a
	 * client that is allowed to set the header itself could shift both.
	 */
	trustProxy?: boolean;
}

/** The router. */
export interface Router {
	/** Registers a route */
	add(route: RouteDefinition): void;
	/** Handles a request; never throws */
	handle(request: HttpRequest): Promise<HttpResponse>;
	/** Registered routes (method and path), e.g. for the API documentation */
	routes(): { method: string; path: string }[];
}

/** Marker to tell a handler result from a plain JSON payload. */
const ROUTE_RESPONSE = Symbol("routeResponse");

/** Marker for responses whose body is passed to the transport unchanged. */
const RAW_RESPONSE = Symbol("rawResponse");

/** A response whose body is written to the transport as it is (see `binary`). */
export interface RawRouteResponse extends RouteResponse {
	/** Bytes or text */
	body: string | Buffer;
}

/**
 * Creates a response object for a handler.
 *
 * @param status - HTTP status code
 * @param body - body to serialise as JSON
 * @param headers - additional response headers
 * @returns route response
 */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): RouteResponse {
	return Object.assign({ status, body, headers }, { [ROUTE_RESPONSE]: true });
}

/**
 * Creates an empty response.
 *
 * @param status - HTTP status code (default 204)
 * @param headers - additional response headers (e.g. a `set-cookie` that ends a session)
 * @returns route response without a body
 */
export function noContent(status = 204, headers: Record<string, string> = {}): RouteResponse {
	return Object.assign({ status, body: undefined, headers }, { [ROUTE_RESPONSE]: true });
}

/**
 * Creates a response with a body that is not JSON.
 *
 * Used for downloads and other binary payloads (reports, backups). The body is handed to the transport
 * unchanged, so a `Buffer` keeps its bytes and a string is written as UTF-8 text.
 *
 * @param status - HTTP status code
 * @param body - bytes or text
 * @param contentType - media type of the body
 * @param headers - additional response headers (e.g. `content-disposition`)
 * @returns route response
 */
export function binary(
	status: number,
	body: string | Buffer,
	contentType: string,
	headers: Record<string, string> = {},
): RouteResponse {
	return Object.assign(
		{ status, body, headers: { "content-type": contentType, ...headers } },
		{ [ROUTE_RESPONSE]: true, [RAW_RESPONSE]: true },
	);
}

/**
 * Checks whether a response body is handed to the transport unchanged.
 *
 * @param value - handler result
 * @returns true for responses created by `binary`
 */
export function isRawResponse(value: unknown): value is RawRouteResponse {
	return typeof value === "object" && value !== null && RAW_RESPONSE in value;
}

/**
 * Checks whether a handler result is a route response.
 *
 * @param value - handler result
 * @returns true when the value was created by `json` or `noContent`
 */
function isRouteResponse(value: unknown): value is RouteResponse {
	return typeof value === "object" && value !== null && ROUTE_RESPONSE in value;
}

/** Headers every API response carries. */
const BASE_HEADERS: Record<string, string> = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

/** Headers of a problem document: the same security headers with the RFC 9457 content type. */
const PROBLEM_HEADERS: Record<string, string> = {
	...BASE_HEADERS,
	"content-type": PROBLEM_CONTENT_TYPE,
};

/** State changing methods need a CSRF token by default. */
const SAFE_METHODS: string[] = ["GET", "HEAD", "OPTIONS"];

interface CompiledRoute {
	definition: RouteDefinition;
	methods: HttpMethod[];
	/** Path segments, `literal: null` marks a parameter */
	segments: { literal: string | null; name: string }[];
}

/**
 * Splits a path into segments without leading/trailing slashes.
 *
 * @param path - path to split
 * @returns segments
 */
function splitPath(path: string): string[] {
	return path.split("/").filter(segment => segment.length > 0);
}

/**
 * Compiles the path pattern of a route.
 *
 * @param path - pattern like `/reports/day/:date`
 * @returns segments with their parameter names
 */
function compileSegments(path: string): { literal: string | null; name: string }[] {
	return splitPath(path).map(segment =>
		segment.startsWith(":") ? { literal: null, name: segment.slice(1) } : { literal: segment, name: "" },
	);
}

/**
 * Creates a problem response.
 *
 * @param status - HTTP status code
 * @param code - stable error code
 * @param detail - optional explanation
 * @param instance - request path
 * @param headers - additional headers
 * @returns HTTP response
 */
function problemResponse(
	status: number,
	code: ProblemCode,
	detail: string | undefined,
	instance: string,
	headers: Record<string, string> = {},
): HttpResponse {
	const details: ProblemDetails = new HttpProblem(status, code, detail).toProblem(instance);
	return {
		status,
		headers: { ...PROBLEM_HEADERS, ...headers },
		body: JSON.stringify(details),
	};
}

/** Reads a request header (lower case names). */
type HeaderReader = (name: string) => string | null;

/**
 * Reads the last hop of `x-forwarded-for`.
 *
 * Every client may send the header itself; the proxy *appends* the address it saw, so the rightmost entry is
 * the one the trusted proxy wrote. Taking the first one instead would let a caller pick its own address — and
 * with it the rate limit bucket and the audit entry.
 *
 * @param headerValue - header reader
 * @returns the forwarded client address or `null` when the header is missing or empty
 */
function forwardedAddress(headerValue: HeaderReader): string | null {
	const raw = headerValue("x-forwarded-for");
	if (!raw) {
		return null;
	}
	const hops = raw
		.split(",")
		.map(hop => hop.trim())
		.filter(hop => hop.length > 0);
	return hops.length > 0 ? hops[hops.length - 1] : null;
}

/**
 * Resolves the client address used for rate limits and the audit trail.
 *
 * @param request - incoming request
 * @param headerValue - header reader
 * @param trustProxy - true when the operator declared a reverse proxy in front
 * @returns the client address
 */
function resolveClientAddress(request: HttpRequest, headerValue: HeaderReader, trustProxy: boolean): string | null {
	const forwarded = trustProxy ? forwardedAddress(headerValue) : null;
	return forwarded ?? request.remoteAddress ?? null;
}

/**
 * Reads the protocol a trusted proxy reported.
 *
 * @param headerValue - header reader
 * @returns `https` when the request reached the proxy over TLS, otherwise the raw value
 */
function forwardedProto(headerValue: HeaderReader): string {
	return ((headerValue("x-forwarded-proto") ?? "").split(",")[0] ?? "").trim().toLowerCase();
}

/**
 * Default limit of a request body.
 *
 * It has to be roomier than the biggest value a client may store: a branding picture is a data URL of up to
 * `MAX_BRANDING_BYTES` (512 KiB), and base64 makes it about a third bigger. Everything else the API accepts
 * (a punch, a patch, a report request) is a few kilobytes.
 */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Creates the router.
 *
 * @param options - authentication service and limits
 * @returns router instance
 */
export function createRouter(options: RouterOptions): Router {
	const routes: CompiledRoute[] = [];
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));
	// the counters live in the router, so the limits belong to the API instance that registered them
	const limiter = createRateLimiter();

	return {
		add(route: RouteDefinition): void {
			routes.push({
				definition: route,
				methods: Array.isArray(route.method) ? route.method : [route.method],
				segments: compileSegments(route.path),
			});
		},

		routes(): { method: string; path: string }[] {
			return routes.flatMap(route => route.methods.map(method => ({ method, path: route.definition.path })));
		},

		async handle(request: HttpRequest): Promise<HttpResponse> {
			const method = (request.method ?? "GET").toUpperCase();
			const path = request.path ?? "/";
			const pathSegments = splitPath(path);
			const headers = request.headers ?? {};
			const headerValue = (name: string): string | null => {
				const value = headers[name] ?? headers[name.toLowerCase()];
				return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
			};

			// Behind a reverse proxy the socket address is the proxy itself, so the address the proxy appended to
			// `x-forwarded-for` is used — but only when the operator declared the proxy as trusted (`trustProxy`),
			// because any client can send that header on its own. One hop is assumed, which is what a single
			// nginx/caddy in front produces.
			const clientAddress = resolveClientAddress(request, headerValue, options.trustProxy === true);
			const secure = options.trustProxy === true && forwardedProto(headerValue) === "https";
			// the handlers see the address the rate limit counted and the audit trail stores
			const routedRequest: HttpRequest =
				(request.remoteAddress ?? null) === clientAddress
					? request
					: { ...request, remoteAddress: clientAddress };

			const matched: { route: CompiledRoute; params: Record<string, string> }[] = [];
			for (const route of routes) {
				if (route.segments.length !== pathSegments.length) {
					continue;
				}
				const params: Record<string, string> = {};
				let matches = true;
				for (let index = 0; index < route.segments.length; index++) {
					const segment = route.segments[index];
					if (segment.literal === null) {
						params[segment.name] = decodeURIComponent(pathSegments[index]);
						continue;
					}
					if (segment.literal !== pathSegments[index]) {
						matches = false;
						break;
					}
				}
				if (matches) {
					matched.push({ route, params });
				}
			}

			if (matched.length === 0) {
				return problemResponse(404, "not_found", `no route for ${method} ${path}`, path);
			}

			const candidate = matched.find(entry => entry.route.methods.includes(method as HttpMethod));
			if (!candidate) {
				const allowed = [...new Set(matched.flatMap(entry => entry.route.methods))].sort();
				return problemResponse(405, "method_not_allowed", `allowed: ${allowed.join(", ")}`, path, {
					allow: allowed.join(", "),
				});
			}

			const { route, params } = candidate;
			const body = request.body ?? "";
			if (body.length > maxBodyBytes) {
				return problemResponse(413, "payload_too_large", `body exceeds ${maxBodyBytes} bytes`, path);
			}

			// The session travels in the `x-session-token` header (integration clients) or in the httpOnly
			// session cookie (browsers, specification 4.x). CSRF is only possible where the browser attaches a
			// credential by itself, so a state changing request needs the CSRF token as soon as the cookie is
			// present — while a pure bearer client, which no foreign page can equip with a header, needs none.
			const bearerToken = headerValue("x-session-token") ?? "";
			const cookieToken = parseCookies(headerValue("cookie"))[SESSION_COOKIE] ?? "";
			const token = bearerToken || cookieToken;
			const viaCookie = bearerToken === "" && cookieToken !== "";
			const requiresCsrf =
				route.definition.requiresCsrf ?? (!SAFE_METHODS.includes(method) && cookieToken !== "");

			// the limit is counted per client address, before any work is done
			if (route.definition.rateLimit) {
				const limited = limiter.check(route.definition.rateLimit, clientAddress ?? "unknown", now());
				if (!limited.allowed) {
					return problemResponse(429, "rate_limited", "too many requests, try again later", path, {
						"retry-after": String(limited.retryAfterSeconds),
						"x-ratelimit-remaining": "0",
					});
				}
			}

			let auth: AuthContext | null = null;
			let rotated: { token: string; expiresAt: number } | null = null;

			if (route.definition.requiresAuth !== false) {
				const result = options.auth.authenticate({
					token,
					permission: route.definition.permission,
					now: now(),
				});
				if (!result.ok) {
					const status = result.error === "permission_denied" ? 403 : 401;
					return problemResponse(status, result.error, `request rejected (${result.error})`, path);
				}
				auth = result.context;

				if (requiresCsrf && !options.auth.verifyCsrf({ token, csrfToken: headerValue("x-csrf-token") ?? "" })) {
					return problemResponse(403, "csrf_rejected", "missing or wrong CSRF token", path);
				}

				// A browser session that has been in use for a while gets a fresh token: the cookie is replaced
				// below and the old token dies with its row (specification 4.10: rotation). Bearer clients keep
				// their token — they hold no cookie that could be renewed without asking them.
				rotated = cookieToken !== "" ? options.auth.rotateIfDue({ token, now: now() }) : null;
			}

			/**
			 * Parses the request body.
			 *
			 * @param required - true when an empty body is a client error
			 * @returns the parsed body
			 */
			function parseRequestBody<T>(required: boolean): T {
				const contentType = headerValue("content-type") ?? "";
				if (contentType && !contentType.toLowerCase().includes("application/json")) {
					throw new HttpProblem(415, "unsupported_media_type", `unsupported content type ${contentType}`);
				}
				if (!body.trim()) {
					if (required) {
						throw new HttpProblem(400, "bad_request", "body is required");
					}
					// DELETE requests often carry no body at all; the optional fields stay empty then
					return {} as T;
				}
				try {
					return JSON.parse(body) as T;
				} catch {
					throw new HttpProblem(400, "bad_request", "body is not valid JSON");
				}
			}

			const context: RouteContext = {
				request: routedRequest,
				params,
				auth,
				sessionToken: token,
				viaCookie,
				secure,
				query: name => {
					const value = request.query?.[name];
					return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
				},
				header: headerValue,
				jsonBody: <T = Record<string, unknown>>(): T => parseRequestBody<T>(true),
				optionalJsonBody: <T = Record<string, unknown>>(): T => parseRequestBody<T>(false),
			};

			try {
				const result = await route.definition.handler(context);
				if (!isRouteResponse(result)) {
					throw new Error("handler did not return a response object");
				}

				const responseHeaders = { ...BASE_HEADERS, ...(result.headers ?? {}) };
				if (rotated && !responseHeaders["set-cookie"]) {
					// the renewed session cookie of a browser; routes that set their own (login, logout) win
					responseHeaders["set-cookie"] = serializeCookie(SESSION_COOKIE, rotated.token, {
						maxAgeSeconds: Math.max(0, rotated.expiresAt - now()),
						secure,
					});
				}
				if (result.body === undefined) {
					delete responseHeaders["content-type"];
					return { status: result.status, headers: responseHeaders, body: "" };
				}
				if (isRawResponse(result)) {
					// downloads keep their bytes: a buffer is written as is, a string as UTF-8 text
					return { status: result.status, headers: responseHeaders, body: result.body };
				}
				return { status: result.status, headers: responseHeaders, body: JSON.stringify(result.body) };
			} catch (error) {
				const { problem: details } = toProblem(error, path);
				return { status: details.status, headers: { ...PROBLEM_HEADERS }, body: JSON.stringify(details) };
			}
		},
	};
}
