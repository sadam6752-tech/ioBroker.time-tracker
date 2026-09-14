/**
 * Static file delivery for the PWA (`www/`).
 *
 * The handler answers `GET`/`HEAD` for files below a root directory. It never leaves that directory: the path
 * is resolved and checked against the root, so `../` or encoded traversal cannot read other files. Single page
 * applications get an `index.html` fallback for unknown paths, but only for HTML requests — an API call must
 * never receive the HTML page.
 *
 * Caching uses `ETag` and `Last-Modified`, so a reload only transfers changed files; `If-None-Match` and
 * `If-Modified-Since` answer with `304`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HttpRequest, HttpResponse } from "./router";

/** Options of the static handler. */
export interface StaticFilesOptions {
	/** Directory that is served (absolute path) */
	root: string;
	/** File served for unknown paths of a single page application (default `index.html`) */
	indexFile?: string;
}

/** A static handler: returns a response or `null` when it does not handle the request. */
export type StaticHandler = (request: HttpRequest) => HttpResponse | null;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

/**
 * Creates a static file handler.
 *
 * @param options - root directory and index file
 * @returns the handler
 */
export function createStaticHandler(options: StaticFilesOptions): StaticHandler {
	const root = path.resolve(options.root);
	const indexFile = options.indexFile ?? "index.html";

	return (request: HttpRequest): HttpResponse | null => {
		const method = (request.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			return null;
		}

		let target: string;
		try {
			target = resolveTarget(root, request.path ?? "/");
		} catch {
			// traversal attempt: the caller must not learn anything about the file system
			return {
				status: 404,
				headers: { "content-type": "text/plain; charset=utf-8" },
				body: "Not Found",
			};
		}

		let file = target;
		if (!isFile(file)) {
			// single page application: unknown paths are routed on the client
			if (!requestsHtml(request)) {
				return null;
			}
			file = path.join(root, indexFile);
			if (!isFile(file)) {
				return null;
			}
		}

		const stats = fs.statSync(file);
		const etag = `"${createHash("sha1").update(`${stats.size}:${stats.mtimeMs}`).digest("hex")}"`;
		const headers: Record<string, string> = {
			"content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
			etag,
			"last-modified": stats.mtime.toUTCString(),
			"cache-control": file.endsWith(indexFile) ? "no-cache" : "public, max-age=3600",
			"x-content-type-options": "nosniff",
		};

		if (isFresh(request, etag, stats.mtime)) {
			return { status: 304, headers, body: "" };
		}

		return {
			status: 200,
			headers: { ...headers, "content-length": String(stats.size) },
			// binary assets must keep their bytes, so the file is read as Buffer
			body: method === "HEAD" ? "" : fs.readFileSync(file),
		};
	};
}

/**
 * Resolves a request path to a file inside the root directory.
 *
 * @param root - root directory (absolute)
 * @param requestPath - path of the request
 * @returns absolute file path
 */
function resolveTarget(root: string, requestPath: string): string {
	const decoded = decodeURIComponent(requestPath.split("?")[0]);
	const relative = decoded.replace(/^\/+/, "");
	const resolved = path.resolve(root, relative);

	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error("path leaves the root directory");
	}
	// a directory is mapped to its index file
	return resolved;
}

/**
 * Checks whether a path is an existing file.
 *
 * @param file - absolute path
 * @returns true when it is a file
 */
function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Checks whether the client expects HTML (a browser navigating, not an API client).
 *
 * @param request - incoming request
 * @returns true when HTML may be delivered
 */
function requestsHtml(request: HttpRequest): boolean {
	const accept = headerOf(request, "accept") ?? "";
	if (!accept) {
		// no `Accept` header: behave like a browser and deliver the page
		return true;
	}
	return accept.includes("text/html") || accept.includes("*/*");
}

/**
 * Reads a header value as string.
 *
 * @param request - incoming request
 * @param name - header name (lower case)
 * @returns the value or `null`
 */
function headerOf(request: HttpRequest, name: string): string | null {
	const value = request.headers?.[name];
	return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * Checks whether the client already has the current version.
 *
 * @param request - incoming request
 * @param etag - current entity tag
 * @param modified - last modification time
 * @returns true when a `304` may be answered
 */
function isFresh(request: HttpRequest, etag: string, modified: Date): boolean {
	const ifNoneMatch = headerOf(request, "if-none-match");
	if (ifNoneMatch) {
		return ifNoneMatch.split(",").some(value => value.trim() === etag);
	}

	const ifModifiedSince = headerOf(request, "if-modified-since");
	if (ifModifiedSince) {
		const since = Date.parse(ifModifiedSince);
		// `Last-Modified` only carries seconds, so the comparison has to as well
		const modifiedSeconds = Math.floor(modified.getTime() / 1000) * 1000;
		return Number.isFinite(since) && modifiedSeconds <= since;
	}
	return false;
}
