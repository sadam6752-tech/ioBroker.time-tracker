/**
 * Users, roles, photos, work profiles and shift rules.
 */

import { checkPasswordPolicy, hashPassword } from "../../services/auth";
import { NotFoundError, ValidationError } from "../../errors";
import { MAX_AVATAR_BYTES, parseAvatarDataUrl, readAvatar } from "../../domain/avatar";
import { isValidTimeZone } from "../../util/time";
import { parseCookies, SESSION_COOKIE } from "../cookies";
import { problem } from "../problem";
import { json, noContent, binary } from "../router";

import type { ApiContext } from "./context";
import {
	requireString,
	optionalString,
	optionalNumber,
	requireBoolean,
	optionalNumberQuery,
	readRoleKeys,
	readProfilePatch,
	publicUser,
	optionalBoolean,
	numberParam,
} from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerUserRoutes(ctx: ApiContext): void {
	const { deps, users, rules, terminals, settings, now, requireActiveAdministrator, route } = ctx;

	// users, roles and work profiles

	route("GET", "/users", { permission: "user.view" }, context => {
		const includeInactive = context.query("includeInactive") === "true";
		const search = (context.query("q") ?? "").trim().toLowerCase();
		const limit = optionalNumberQuery(context, "limit", Number.MAX_SAFE_INTEGER);
		const offset = optionalNumberQuery(context, "offset", 0);

		const all = users.list({ includeInactive });
		const filtered = search
			? all.filter(
					user =>
						user.login.toLowerCase().includes(search) || user.displayName.toLowerCase().includes(search),
				)
			: all;

		return json(200, {
			total: filtered.length,
			offset,
			users: filtered.slice(offset, offset + limit).map(user => ({
				...publicUser(user),
				roles: users.roles(user.id),
			})),
		});
	});

	route("GET", "/users/:id", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		const user = users.findById(id);
		if (!user) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, {
			user: { ...publicUser(user), roles: users.roles(id), permissions: users.permissions(id) },
			profile: users.getWorkProfile(id),
		});
	});

	route("POST", "/users", { permission: "user.create", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const password = requireString(body, "password");
		const policyIssue = checkPasswordPolicy(password);
		if (policyIssue) {
			throw new ValidationError(policyIssue);
		}

		const created = users.create({
			login: requireString(body, "login"),
			displayName: requireString(body, "displayName"),
			passwordHash: hashPassword(password),
			email: optionalString(body, "email"),
			locale: optionalString(body, "locale") ?? settings.get("default_language") ?? undefined,
			timezone: optionalString(body, "timezone") ?? undefined,
			mustChangePw: optionalBoolean(body, "mustChangePw") ?? undefined,
			roleKeys: readRoleKeys(body) ?? undefined,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});

		return json(
			201,
			{ user: { ...publicUser(created), roles: users.roles(created.id) } },
			{ location: `/users/${created.id}` },
		);
	});

	route("GET", "/roles", { permission: "user.view" }, () => json(200, { roles: users.roleCatalog() }));

	route("GET", "/users/:id/avatar", { public: true }, context => {
		// The picture is shown by the kiosk and the presence screen as well, and those authenticate with the device
		// token of a terminal instead of a user session — so either credential is accepted here, and nothing else.
		const id = numberParam(context, "id");
		const terminalSession = context.query("terminalSession") ?? "";
		const browserToken =
			context.header("x-session-token") ?? parseCookies(context.header("cookie"))[SESSION_COOKIE] ?? "";
		const browserOk =
			browserToken !== "" &&
			deps.auth.authenticate({ token: browserToken, permission: undefined, now: now() }).ok;
		const terminalOk = terminalSession !== "" && terminals.findBySession(terminalSession, now()) !== null;
		if (!browserOk && !terminalOk) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}

		const user = users.findById(id);
		const image = user ? readAvatar(user.avatar) : null;
		if (!image) {
			throw new NotFoundError(`user ${id} has no picture`);
		}
		return binary(200, Buffer.from(image.base64, "base64"), image.contentType, {
			"cache-control": "private, max-age=300",
		});
	});

	route("PATCH", "/users/:id", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		const target = users.findById(id);
		if (!target) {
			throw new NotFoundError(`user ${id} not found`);
		}

		const body = context.jsonBody();
		const roleKeys = readRoleKeys(body);
		// assigning roles is a right of its own
		if (roleKeys !== null && !context.auth.permissions.includes("user.manage_roles")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: user.manage_roles)");
		}

		const password = optionalString(body, "password");
		if (password !== null) {
			const policyIssue = checkPasswordPolicy(password);
			if (policyIssue) {
				throw new ValidationError(policyIssue);
			}
		}

		const patch: {
			/** New display name */
			displayName?: string;
			/** New e-mail address, `null` clears it */
			email?: string | null;
			/** New language of the account */
			locale?: string;
			/** New time zone of the account */
			timezone?: string;
			/** New badge number, `null` clears it */
			rfidCard?: string | null;
			/** Activates or deactivates the account */
			isActive?: boolean;
			/** True when the next login has to change the password */
			mustChangePw?: boolean;
			/** Already hashed password (the caller hashes it) */
			passwordHash?: string;
		} = {};
		if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
			patch.displayName = requireString(body, "displayName");
		}
		if (Object.prototype.hasOwnProperty.call(body, "email")) {
			patch.email = optionalString(body, "email");
		}
		if (Object.prototype.hasOwnProperty.call(body, "locale")) {
			patch.locale = requireString(body, "locale");
		}
		if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
			const timezone = requireString(body, "timezone");
			if (!isValidTimeZone(timezone)) {
				throw new ValidationError(`timezone is not a valid IANA name (got ${timezone})`);
			}
			patch.timezone = timezone;
		}
		if (Object.prototype.hasOwnProperty.call(body, "rfidCard")) {
			patch.rfidCard = optionalString(body, "rfidCard");
		}
		if (Object.prototype.hasOwnProperty.call(body, "mustChangePw")) {
			patch.mustChangePw = requireBoolean(body, "mustChangePw");
		}
		const isActive = optionalBoolean(body, "isActive");
		if (isActive !== null) {
			if (isActive === false && id === context.auth.user.id) {
				throw new ValidationError("an account cannot deactivate itself");
			}
			patch.isActive = isActive;
		}
		if (password !== null) {
			patch.passwordHash = hashPassword(password);
		}

		// The picture is not part of the audited patch — `setAvatar` stores it on its own (and keeps the image out
		// of the audit trail). Sending `avatar: null` removes it, leaving the field out keeps it.
		if (Object.prototype.hasOwnProperty.call(body, "avatar")) {
			const avatar = optionalString(body, "avatar");
			if (avatar !== null && !parseAvatarDataUrl(avatar)) {
				throw new ValidationError(
					`avatar must be a data URL of a png, jpeg, webp or gif of up to ${MAX_AVATAR_BYTES} bytes`,
				);
			}
			users.setAvatar({
				userId: id,
				avatar,
				actorId: context.auth.user.id,
				actorIp: context.request.remoteAddress ?? null,
				now: now(),
			});
		}

		// one rule for both fields: deactivating or demoting the last active administrator is refused, so the
		// installation always keeps somebody who may administer it
		if (patch.isActive === false || roleKeys !== null) {
			requireActiveAdministrator(id, {
				isActive: patch.isActive ?? target.isActive,
				roleKeys: roleKeys ?? users.roles(id),
			});
		}

		const updated = users.update({
			id,
			patch,
			reason: optionalString(body, "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		const roles = roleKeys
			? users.setRoles({
					userId: id,
					roleKeys,
					actorId: context.auth.user.id,
					actorIp: context.request.remoteAddress ?? null,
					now: now(),
				})
			: users.roles(id);

		return json(200, { user: { ...publicUser(updated), roles } });
	});

	route("DELETE", "/users/:id", { permission: "user.deactivate", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		const target = users.findById(id);
		if (!target) {
			throw new NotFoundError(`user ${id} not found`);
		}
		if (!target.isActive) {
			// a second call has nothing left to do and says so
			throw new NotFoundError(`user ${id} is already deactivated`);
		}
		if (id === context.auth.user.id) {
			throw new ValidationError("an account cannot deactivate itself");
		}
		// `user.deactivate` is carried by the admin role alone, so the caller is an active administrator: an account
		// deactivated here is never the last one (and the own one is refused above)

		// accounts are never deleted, they are deactivated and keep their history
		users.update({
			id,
			patch: { isActive: false },
			reason: optionalString(context.optionalJsonBody(), "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return noContent();
	});

	route("GET", "/users/:id/profile", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, { profile: users.getWorkProfile(id) });
	});

	route("PUT", "/users/:id/profile", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		const body = context.jsonBody();

		const profile = users.saveWorkProfile({
			userId: id,
			profile: readProfilePatch(body),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(200, { profile });
	});

	route("GET", "/users/:id/shift-rules", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, { shiftRules: rules.shiftRules(id, { includeInactive: true }) });
	});

	route("PUT", "/users/:id/shift-rules", { permission: "user.edit", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}

		const body = context.jsonBody();
		if (!Array.isArray(body.shiftRules)) {
			throw new ValidationError("shiftRules must be an array");
		}
		const actor = {
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		};
		const wanted = (body.shiftRules as unknown[]).map(raw => {
			const rule = (raw ?? {}) as Record<string, unknown>;
			return {
				id: optionalNumber(rule, "id") ?? undefined,
				surcharge: Number(rule.surcharge),
				dayOfWeek: optionalNumber(rule, "dayOfWeek"),
				fromMin: optionalNumber(rule, "fromMin"),
				toMin: optionalNumber(rule, "toMin"),
				isActive: optionalBoolean(rule, "isActive") ?? undefined,
			};
		});

		// the payload replaces the rules of the employee: missing rules are removed, the rest is saved
		const keep = new Set(wanted.map(rule => rule.id).filter((value): value is number => value !== undefined));
		for (const existing of rules.shiftRules(id, { includeInactive: true })) {
			if (!keep.has(existing.id)) {
				rules.removeShiftRule({ id: existing.id, ...actor });
			}
		}
		const saved = wanted.map(rule =>
			rules.saveShiftRule({
				...(rule.id !== undefined ? { id: rule.id } : {}),
				userId: id,
				surcharge: rule.surcharge,
				...(rule.dayOfWeek !== null ? { dayOfWeek: rule.dayOfWeek } : {}),
				...(rule.fromMin !== null ? { fromMin: rule.fromMin } : {}),
				...(rule.toMin !== null ? { toMin: rule.toMin } : {}),
				...(rule.isActive !== undefined ? { isActive: rule.isActive } : {}),
				...actor,
			}),
		);
		return json(200, { shiftRules: saved });
	});
}
