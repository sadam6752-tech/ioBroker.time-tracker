/**
 * Cookie helpers of the HTTP layer.
 *
 * The session of a browser travels in an `httpOnly` cookie (specification 4.x: `httpOnly`, `Secure`,
 * `SameSite=Lax`), so a script injected into the page cannot read it. The CSRF token stays readable for the
 * page and is sent in the `x-csrf-token` header — it is only needed while the caller is authenticated by that
 * cookie. Integration clients keep using the `x-session-token` header (bearer) and need no CSRF token, because
 * a browser never attaches such a header by itself.
 */

/** Name of the session cookie. */
export const SESSION_COOKIE = "zt_session";

/** How a cookie is written. */
export interface CookieOptions {
	/** Lifetime in seconds; `0` (or less) removes the cookie */
	maxAgeSeconds?: number;
	/** Path the cookie is valid for, default `/` */
	path?: string;
	/** Adds `Secure`, so the browser only sends it over HTTPS */
	secure?: boolean;
	/** `SameSite` value, default `Lax` */
	sameSite?: "Lax" | "Strict" | "None";
	/** Keeps the cookie invisible for scripts (default `true`) */
	httpOnly?: boolean;
}

/**
 * Reads the cookies of a `Cookie` header.
 *
 * Unknown or broken entries are skipped instead of throwing: a request with a damaged cookie header is simply
 * not authenticated.
 *
 * @param header - value of the `Cookie` header
 * @returns the cookies by name
 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
	const cookies: Record<string, string> = {};
	if (!header) {
		return cookies;
	}
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		const name = part.slice(0, separator).trim();
		if (name === "") {
			continue;
		}
		const raw = part.slice(separator + 1).trim();
		try {
			cookies[name] = decodeURIComponent(raw);
		} catch {
			// a percent sign that is not an escape sequence: keep the raw value
			cookies[name] = raw;
		}
	}
	return cookies;
}

/**
 * Serialises a cookie for a `Set-Cookie` header.
 *
 * @param name - cookie name
 * @param value - cookie value
 * @param options - lifetime and flags
 * @returns the header value
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	const path = options.path ?? "/";
	if (path) {
		parts.push(`Path=${path}`);
	}
	if (options.maxAgeSeconds !== undefined) {
		parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
	}
	parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
	if (options.httpOnly !== false) {
		parts.push("HttpOnly");
	}
	if (options.secure) {
		parts.push("Secure");
	}
	return parts.join("; ");
}

/**
 * Serialises a cookie that removes itself.
 *
 * @param name - cookie name
 * @param options - flags of the cookie (the path has to match the one it was set with)
 * @returns the header value
 */
export function clearCookie(name: string, options: CookieOptions = {}): string {
	return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}
