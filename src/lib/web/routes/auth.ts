/**
 * Sign in, sign out, password change and session renewal.
 */

import { problem } from "../problem";
import { json, noContent } from "../router";

import type { ApiContext } from "./context";
import { MAX_LOGIN_LENGTH, MAX_PASSWORD_LENGTH } from "./shared";
import { bodySchema, parseBody, requiredText } from "./validate";

/** Body of a sign in. */
const LOGIN_BODY = bodySchema({ login: requiredText(MAX_LOGIN_LENGTH), password: requiredText(MAX_PASSWORD_LENGTH) });

/** Body of a password change. */
const PASSWORD_BODY = bodySchema({ password: requiredText() });

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerAuthRoutes(ctx: ApiContext): void {
	const { deps, auth, now, route, sessionCookie, removeSessionCookie } = ctx;

	// authentication

	route(
		"POST",
		"/auth/login",
		{
			public: true,
			csrf: false,
			rateLimit: { name: "login", limit: deps.loginRateLimit ?? 20, windowSeconds: 60 },
		},
		context => {
			const { login, password } = parseBody(LOGIN_BODY, context.jsonBody());
			const result = auth.login({
				login,
				password,
				userAgent: context.header("user-agent"),
				ip: context.request.remoteAddress ?? null,
				now: now(),
			});

			if (!result.ok) {
				throw problem(
					result.error === "locked_out" ? 423 : 401,
					result.error,
					result.error === "locked_out"
						? "too many failed attempts, try again later"
						: "login or password is not correct",
				);
			}
			// the token is returned for integration clients (bearer) and set as an httpOnly cookie for the
			// browser; the CSRF token stays readable for the page on purpose
			return json(
				200,
				{
					token: result.token,
					csrfToken: result.csrfToken,
					expiresAt: result.expiresAt,
					user: result.user,
				},
				{ "set-cookie": sessionCookie(context, result.token, result.expiresAt) },
			);
		},
	);

	route("POST", "/auth/logout", { csrf: true }, context => {
		auth.logout({
			token: context.sessionToken,
			actorId: context.auth?.user.id ?? null,
			ip: context.request.remoteAddress ?? null,
			now: now(),
		});
		// the browser session ends with the cookie, not only with the session row
		return noContent(204, { "set-cookie": removeSessionCookie(context) });
	});

	route("GET", "/auth/me", {}, context =>
		json(200, {
			user: context.auth?.user,
			permissions: context.auth?.permissions ?? [],
			expiresAt: context.auth?.expiresAt,
			// a client that only holds the cookie has no other way to learn the CSRF token of its session
			csrfToken: context.auth ? auth.csrfToken(context.sessionToken) : undefined,
		}),
	);

	route("POST", "/auth/password", { csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const { password } = parseBody(PASSWORD_BODY, context.jsonBody());

		auth.setPassword({ userId: context.auth.user.id, password, actorId: context.auth.user.id, now: now() });
		// a password change ends all running sessions, including this one
		auth.revokeSessions({ userId: context.auth.user.id, actorId: context.auth.user.id, now: now() });
		return noContent(204, { "set-cookie": removeSessionCookie(context) });
	});

	// A session is renewed on every authenticated request (sliding renewal), so this route reports the current
	// expiry together with a fresh CSRF token; integration clients use it instead of repeating their login.
	route("POST", "/auth/refresh", { csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const token = context.sessionToken;
		return json(200, {
			expiresAt: context.auth.expiresAt,
			csrfToken: auth.csrfToken(token),
			user: context.auth.user,
			permissions: context.auth.permissions,
		});
	});
}
