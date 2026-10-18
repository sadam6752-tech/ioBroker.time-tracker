/**
 * Corrections of punches, day notes and the history of a punch.
 */

import { readTimeEntryAudit } from "../../db/repositories/audit";
import { NotFoundError, ValidationError } from "../../errors";
import { problem } from "../problem";
import { json, noContent } from "../router";

import type { ApiContext } from "./context";
import { optionalString, optionalNumber, optionalBoolean, numberParam } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerCorrectionRoutes(ctx: ApiContext): void {
	const { deps, users, entries, aggregation, now, emit, route, scopeUser, dayNoteTarget } = ctx;

	// corrections

	route("PATCH", "/entries/:id", { permission: "time.edit_own", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const entryId = numberParam(context, "id");
		const existing = entries.findById(entryId);
		if (!existing) {
			throw new NotFoundError(`entry ${entryId} not found`);
		}
		if (existing.userId !== context.auth.user.id && !context.auth.permissions.includes("time.edit_other")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: time.edit_other)");
		}

		const body = context.jsonBody();
		const revision = optionalNumber(body, "revision");
		if (revision === null) {
			throw new ValidationError("revision is required");
		}
		// an employee only comments his own punch: the times of a day belong to the administration
		const wantedTs = optionalNumber(body, "tsUtc");
		if (wantedTs !== null && !context.auth.permissions.includes("time.edit_other")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: time.edit_other)");
		}
		const target = users.findById(existing.userId);
		if (!target) {
			throw new NotFoundError(`user ${existing.userId} not found`);
		}

		const updated = entries.update({
			id: entryId,
			expectedRevision: revision,
			patch: {
				tsUtc: optionalNumber(body, "tsUtc") ?? undefined,
				note: optionalString(body, "note"),
			},
			reason: optionalString(body, "reason"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			timeZone: target.timezone,
			now: now(),
		});

		const day = aggregation.recalculateDay(updated.userId, updated.localDate, { now: now() });
		emit({
			type: "entry.update",
			userId: updated.userId,
			data: { entryId: updated.id, localDate: updated.localDate, revision: updated.revision },
		});
		return json(200, { entry: updated, day });
	});

	route("DELETE", "/entries/:id", { permission: "time.delete", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const entryId = numberParam(context, "id");
		const existing = entries.findById(entryId);
		if (!existing) {
			throw new NotFoundError(`entry ${entryId} not found`);
		}

		entries.remove({
			id: entryId,
			actorId: context.auth.user.id,
			reason: optionalString(context.optionalJsonBody(), "reason"),
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		aggregation.recalculateDay(existing.userId, existing.localDate, { now: now() });
		emit({
			type: "entry.delete",
			userId: existing.userId,
			data: { entryId: existing.id, localDate: existing.localDate },
		});
		return noContent();
	});

	// day notes: what an employee wants the administration to know about one day

	route("GET", "/day-notes", { permission: "report.view_own" }, context => {
		const userId = scopeUser(context);
		const from = context.query("from");
		const to = context.query("to") ?? from;
		if (!from || !to) {
			throw new ValidationError("from and to are required");
		}
		return json(200, { notes: deps.dayNotes.listByRange(userId, from, to) });
	});

	route("PUT", "/day-notes", { permission: "time.edit_own", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const userId = dayNoteTarget(context, context.auth.user.id);
		const localDate = context.query("date");
		if (!localDate) {
			throw new ValidationError("date is required");
		}
		const note = deps.dayNotes.save({
			userId,
			localDate,
			// an empty text is how a note is taken back
			note: optionalString(body, "note") ?? "",
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({ type: "dayNote.change", userId, data: { localDate } });
		return json(200, { note });
	});

	route("POST", "/day-notes/handled", { permission: "time.edit_other", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const userId = dayNoteTarget(context, context.auth.user.id);
		const localDate = context.query("date");
		if (!localDate) {
			throw new ValidationError("date is required");
		}
		const handled = optionalBoolean(context.jsonBody(), "handled") ?? true;
		const note = deps.dayNotes.setHandled({
			userId,
			localDate,
			handled,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({ type: "dayNote.change", userId, data: { localDate } });
		return json(200, { note });
	});

	route("GET", "/entries/:id/audit", { permission: "audit.view" }, context => {
		const entryId = numberParam(context, "id");
		if (!entries.findById(entryId)) {
			throw new NotFoundError(`entry ${entryId} not found`);
		}
		// the trail names the people who changed the punch, so it needs the audit permission
		return json(200, {
			audit: readTimeEntryAudit(deps.db, entryId).map(row => ({
				...row,
				actorName: users.findById(row.actorId)?.displayName ?? null,
			})),
		});
	});
}
