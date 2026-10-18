/**
 * RFID/NFC badges with signed deep links.
 */

import {
	buildTagToken,
	newTagUid,
	parseTagToken,
	sameSignature,
	signTag,
	type RfidTagRecord,
} from "../../db/repositories/rfid";
import { NotFoundError, ValidationError } from "../../errors";
import { problem } from "../problem";
import { json, noContent, type RouteContext } from "../router";

import type { ApiContext } from "./context";
import {
	bodySchema,
	check,
	employeeRef,
	keepMissing,
	optionalNumber,
	optionalText,
	parseBody,
	punchDirection,
	requiredText,
} from "./validate";
import { MAX_CODE_LENGTH, MAX_PUBLIC_NOTE_LENGTH, numberParam } from "./shared";

/** Validity of a link in days: a positive whole number; missing means the default. */
const TTL_DAYS = check(
	optionalNumber(),
	value => value === null || (Number.isInteger(value) && value > 0),
	(field, value) => `${field} must be a positive whole number (got ${value})`,
);

/** Body of a new badge. */
const TAG_BODY = bodySchema({
	userId: employeeRef({ nullIsMissing: true }),
	ttlDays: TTL_DAYS,
	uid: optionalText(),
	label: optionalText(),
});

/** Body of a change of a badge; a field that is not sent keeps its value. */
const TAG_PATCH_BODY = bodySchema({ userId: employeeRef(), ttlDays: TTL_DAYS, label: keepMissing(optionalText()) });

/** Body of a new link for a badge. */
const TTL_BODY = bodySchema({ ttlDays: TTL_DAYS });

/** Body of a scan: the signed token of the badge and the punch it carries. */
const SCAN_BODY = bodySchema({
	token: requiredText(MAX_CODE_LENGTH),
	tsUtc: optionalNumber(),
	direction: punchDirection(),
	note: optionalText(MAX_PUBLIC_NOTE_LENGTH),
});

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerRfidRoutes(ctx: ApiContext): void {
	const { deps, users, entries, rfid, aggregation, now, emit, route } = ctx;

	// RFID/NFC tags (signed deep links)

	/**
	 * Refuses tag management when the instance has no HMAC secret.
	 *
	 * @returns the secret
	 */
	const requireHmacSecret = (): string => {
		const secret = deps.hmacSecret ?? "";
		if (!secret) {
			throw problem(403, "not_configured", "no HMAC secret is configured for signed tag links");
		}
		return secret;
	};

	/**
	 * Builds the link a phone scans for a badge token.
	 *
	 * @param context - request context (host and scheme)
	 * @param token - signed token of the badge
	 * @returns absolute URL the badge carries
	 */
	const tagLink = (context: RouteContext, token: string): string => {
		const host = context.header("host") ?? "localhost";
		// the link is what a phone scans: it opens the web app, which sends the token to /rfid/scan. The scheme comes
		// from the request (and from a trusted reverse proxy), so the link matches the address the administration
		// itself is reached with — a fixed `https://` pointed nowhere on a plain HTTP instance.
		const scheme = host.includes("://") ? "" : `${context.secure ? "https" : "http"}://`;
		return `${scheme}${host}/?tag=${token}`;
	};

	/**
	 * Signs a new link for a badge and stores it.
	 *
	 * The signature binds `uid`, owner and expiry, so this is what replaces the link: everything handed out before
	 * stops working immediately, and a revoked badge comes back into use with it.
	 *
	 * @param context - request context
	 * @param tag - badge to give a new link (its `userId` may be the new owner)
	 * @param ttlDays - validity of the new link in days
	 * @param label - new label, `undefined` keeps the stored one
	 * @returns the changed badge and its new token
	 */
	const reissueLink = (
		context: RouteContext,
		tag: RfidTagRecord,
		ttlDays: number,
		label?: string | null,
	): { tag: RfidTagRecord; token: string } => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		if (tag.userId === null) {
			throw new ValidationError("the badge has no employee any more — give it one first");
		}
		const timestamp = now();
		const expiresAt = timestamp + ttlDays * 86400;
		const signature = signTag(requireHmacSecret(), tag.uid, tag.userId, expiresAt);
		const updated = rfid.update({
			id: tag.id,
			userId: tag.userId,
			expiresAt,
			signature,
			activate: true,
			...(label === undefined ? {} : { label }),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: timestamp,
		});
		if (!updated) {
			throw new NotFoundError(`tag ${tag.id} not found`);
		}
		return { tag: updated, token: buildTagToken(updated.uid, tag.userId, expiresAt, signature) };
	};

	route("GET", "/rfid/tags", { permission: "rfid.manage" }, () =>
		json(200, { tags: rfid.list({ includeInactive: true }) }),
	);

	route("POST", "/rfid/tags", { permission: "rfid.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const secret = requireHmacSecret();
		const body = parseBody(TAG_BODY, context.jsonBody());
		const target = body.userId ?? context.auth.user.id;
		if (!users.findById(target)) {
			throw new ValidationError("userId must reference an existing employee");
		}
		const ttlDays = body.ttlDays ?? 365;

		const timestamp = now();
		const expiresAt = timestamp + ttlDays * 86400;
		const uid = body.uid ?? newTagUid();
		const signature = signTag(secret, uid, target, expiresAt);
		const tag = rfid.create({
			uid,
			userId: target,
			signature,
			label: body.label,
			expiresAt,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: timestamp,
		});

		const token = buildTagToken(uid, target, expiresAt, signature);
		return json(201, { tag, token, url: tagLink(context, token) }, { location: `/rfid/tags/${tag.id}` });
	});

	route("DELETE", "/rfid/tags/:id", { permission: "rfid.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const revoked = rfid.revoke({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!revoked) {
			throw new NotFoundError(`tag ${context.params.id} not found or already revoked`);
		}
		return noContent();
	});

	// A badge that was revoked can be removed from the list for good. Revoking is what stops the link from working,
	// so this only removes the row — the audit trail keeps the trace either way.
	route("DELETE", "/rfid/tags/:id/permanent", { permission: "rfid.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const removed = rfid.remove({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`tag ${context.params.id} not found`);
		}
		return noContent();
	});

	// Changes a badge: label, owner and validity. The signature binds uid, owner and expiry, so a new owner or a new
	// validity re-issues the link — the answer carries the new token then, and the link given out before is dead.
	route("PATCH", "/rfid/tags/:id", { permission: "rfid.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const id = numberParam(context, "id");
		const body = parseBody(TAG_PATCH_BODY, context.jsonBody());
		const current = rfid.findById(id);
		if (!current) {
			throw new NotFoundError(`tag ${context.params.id} not found`);
		}
		const userId = body.userId === undefined ? current.userId : body.userId;
		if (userId === null || !users.findById(userId)) {
			throw new ValidationError("userId must reference an existing employee");
		}
		const ttlDays = body.ttlDays ?? undefined;
		const label = body.label;

		if (userId !== current.userId || ttlDays !== undefined) {
			// the link has to be signed again: it carries the owner in its payload
			const signed = reissueLink(context, { ...current, userId }, ttlDays ?? 365, label);
			return json(200, { tag: signed.tag, token: signed.token, url: tagLink(context, signed.token) });
		}

		// a label on its own leaves the link alone — the signature does not know about it
		const changed = rfid.update({
			id,
			userId,
			...(label === undefined ? {} : { label }),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!changed) {
			throw new NotFoundError(`tag ${context.params.id} not found`);
		}
		return json(200, { tag: changed });
	});

	// A new link for an existing badge: for one that was lost, expired, or revoked and should work again. The link
	// handed out before stops working with it.
	route("POST", "/rfid/tags/:id/link", { permission: "rfid.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const tag = rfid.findById(numberParam(context, "id"));
		if (!tag) {
			throw new NotFoundError(`tag ${context.params.id} not found`);
		}
		const ttlDays = parseBody(TTL_BODY, context.jsonBody()).ttlDays ?? 365;
		const signed = reissueLink(context, tag, ttlDays);
		return json(200, { tag: signed.tag, token: signed.token, url: tagLink(context, signed.token) });
	});

	route(
		"POST",
		"/rfid/scan",
		{ public: true, csrf: false, rateLimit: { name: "rfid-scan", limit: 30, windowSeconds: 60 } },
		context => {
			const secret = requireHmacSecret();
			const body = parseBody(SCAN_BODY, context.jsonBody());
			const parsed = parseTagToken(body.token);
			if (!parsed) {
				throw new ValidationError("token is not valid");
			}

			// the signature is recomputed from the payload of the token and compared with the signature it carries,
			// so a forged uid/user/exp or a patched signature fails here
			const expected = signTag(secret, parsed.uid, parsed.userId, parsed.expiresAt);
			if (!sameSignature(expected, parsed.signature)) {
				throw problem(401, "invalid_credentials", "the tag is not valid any more");
			}

			const tag = rfid.verify({
				uid: parsed.uid,
				userId: parsed.userId,
				signature: parsed.signature,
				now: now(),
			});
			if (!tag) {
				// one answer for an unknown tag and a revoked one: no probing
				throw problem(401, "invalid_credentials", "the tag is not valid any more");
			}

			const user = users.findById(tag.userId ?? 0);
			if (!user || !user.isActive) {
				throw problem(401, "user_inactive", "the owner of the tag is not active");
			}

			const timestamp = now();
			const stored = entries.insert({
				userId: user.id,
				tsUtc: body.tsUtc ?? timestamp,
				timeZone: user.timezone,
				source: "nfc",
				direction: body.direction,
				note: body.note,
				actorId: user.id,
				actorIp: context.request.remoteAddress ?? null,
				now: timestamp,
			});
			rfid.touch({ id: tag.id, now: timestamp });
			const day = aggregation.recalculateDay(user.id, stored.entry.localDate, { now: timestamp });
			emit({
				type: "rfid.scan",
				userId: user.id,
				data: {
					entryId: stored.entry.id,
					localDate: stored.entry.localDate,
					tagId: tag.id,
					uid: tag.uid,
				},
			});

			return json(201, {
				user: { id: user.id, displayName: user.displayName },
				entry: {
					id: stored.entry.id,
					tsUtc: stored.entry.tsUtc,
					localDate: stored.entry.localDate,
				},
				day: {
					workedMin: day.workedMin,
					targetMin: day.targetMin,
					balanceMin: day.balanceMin,
					hasOpenEntry: day.hasOpenEntry,
				},
			});
		},
	);
}
