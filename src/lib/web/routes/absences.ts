/**
 * Absences, their approval and cancellation, the calendar feed and the absence types.
 */

import { randomBytes } from "node:crypto";

import type { AbsenceApproval, AbsenceRecord } from "../../db/repositories/absences";
import type { UserRecord } from "../../db/repositories/users";
import {
	absenceEvents,
	calendarDocument,
	companyCalendarName,
	personalCalendarName,
	ICAL_CONTENT_TYPE,
	type CalendarEmployee,
} from "../../services/calendar";
import { NotFoundError, ValidationError } from "../../errors";
import { problem } from "../problem";
import { json, noContent, binary, type RouteContext } from "../router";

import type { ApiContext } from "./context";
import { requireString, optionalString, optionalNumber, optionalBoolean, numberParam, resolveScope } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerAbsenceRoutes(ctx: ApiContext): void {
	const { users, absences, settings, now, emit, route } = ctx;

	// absences

	/**
	 * The fields of an employee the calendar needs.
	 *
	 * @param user - the employee
	 * @returns the employee as the calendar service expects it
	 */
	const calendarEmployee = (user: UserRecord): CalendarEmployee => ({
		id: user.id,
		displayName: user.displayName,
		login: user.login,
	});

	/**
	 * Adds the code and the name of the type to an absence.
	 *
	 * The stored record only knows the id of its type, while a client shows the code (specification 4: `Absence`).
	 *
	 * @param absence - stored absence
	 * @returns the absence as the API hands it out
	 */
	const publicAbsence = (
		absence: AbsenceRecord,
	): AbsenceRecord & {
		/** Code of the type, e.g. `vacation` */
		typeCode: string | null;
		/** Name of the type as the client shows it */
		typeName: string | null;
	} => {
		const type = absences.findType(absence.typeId);
		return { ...absence, typeCode: type?.code ?? null, typeName: type?.name ?? null };
	};

	route("GET", "/absences", { permission: "report.view_own" }, context => {
		// `scope=all` is the overview of the administration: every employee in one answer, so the tab needs a single
		// request. The open requests and “who is away” both read from here. A path segment would clash with
		// `/absences/:id`, which the router matches first — hence the query parameter.
		if (context.query("scope") === "all") {
			if (!context.auth?.permissions.includes("absence.approve")) {
				throw problem(403, "permission_denied", "request rejected (permission_denied: absence.approve)");
			}
			const from = context.query("from");
			const to = context.query("to");
			if (!from || !to) {
				throw new ValidationError("from and to are required with scope=all");
			}
			return json(200, { absences: absences.allInRange(from, to).map(publicAbsence) });
		}
		const requested = context.query("userId") ? Number(context.query("userId")) : null;
		const userId = resolveScope(context, requested, "report.view_own", "report.view_other");
		const year = context.query("year") ? Number(context.query("year")) : undefined;
		return json(200, {
			absences: absences.listByUser(userId, year === undefined ? {} : { year }).map(publicAbsence),
		});
	});

	route("POST", "/absences", { permission: "absence.request", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const userId = resolveScope(context, optionalNumber(body, "userId"), "absence.request", "absence.edit_other");

		const status = optionalString(body, "status");
		if (status !== null && status !== "taken" && status !== "planned") {
			throw new ValidationError(`status must be taken or planned (got ${status})`);
		}
		// The administration books dates straight away, an employee only requests them: who may change an absence
		// of somebody else decides about it, everybody else waits for that decision.
		const mayDecide = context.auth.permissions.includes("absence.edit_other");
		const approval: AbsenceApproval = mayDecide ? "approved" : "requested";

		// An employee may only pick a type the administration released for everybody: a sickness note, an accident or
		// military service are things the company books itself, nobody requests them.
		if (!mayDecide) {
			const wanted = absences.findType(
				optionalNumber(body, "typeId") ?? optionalString(body, "typeCode") ?? "",
				userId,
			);
			if (!wanted) {
				throw new ValidationError("unknown absence type");
			}
			if (!wanted.isActive) {
				throw problem(
					403,
					"permission_denied",
					"request rejected (permission_denied: absence type is not public)",
				);
			}
		}

		const created = absences.create({
			userId,
			typeCode: optionalString(body, "typeCode") ?? undefined,
			typeId: optionalNumber(body, "typeId") ?? undefined,
			dateFrom: requireString(body, "dateFrom"),
			dateTo: optionalString(body, "dateTo") ?? undefined,
			dayPortion: optionalNumber(body, "dayPortion") ?? undefined,
			hours: optionalNumber(body, "hours"),
			status: status ?? undefined,
			approval,
			note: optionalString(body, "note"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({ type: "absence.change", userId, data: { absenceId: created.id, action: "created" } });
		return json(201, { absence: publicAbsence(created) }, { location: `/absences/${created.id}` });
	});

	route("POST", "/absences/:id/status", { permission: "absence.approve", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const status = requireString(context.jsonBody(), "status");
		if (status !== "taken" && status !== "planned") {
			throw new ValidationError(`status must be taken or planned (got ${status})`);
		}

		const updated = absences.setStatus({
			id: numberParam(context, "id"),
			status,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({ type: "absence.change", userId: updated.userId, data: { absenceId: updated.id, action: "status" } });
		return json(200, { absence: publicAbsence(updated) });
	});

	// The other decision: the administration approves or rejects what an employee asked for. The reason travels
	// with the decision, so the employee sees why a request came back.
	route("POST", "/absences/:id/approval", { permission: "absence.approve", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const approval = requireString(body, "approval");
		if (approval !== "requested" && approval !== "approved" && approval !== "rejected") {
			throw new ValidationError(`approval must be requested, approved or rejected (got ${approval})`);
		}

		const updated = absences.setApproval({
			id: numberParam(context, "id"),
			approval,
			note: optionalString(body, "note"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({ type: "absence.change", userId: updated.userId, data: { absenceId: updated.id, action: "approval" } });
		return json(200, { absence: publicAbsence(updated) });
	});

	/**
	 * Loads an absence and checks whether the caller may change it.
	 *
	 * @param context - route context
	 * @returns the absence
	 */
	const changeableAbsence = (context: RouteContext): AbsenceRecord => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const absence = absences.findById(numberParam(context, "id"));
		if (!absence) {
			throw new NotFoundError(`absence ${context.params.id} not found`);
		}
		if (absence.userId !== context.auth.user.id && !context.auth.permissions.includes("absence.edit_other")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: absence.edit_other)");
		}
		return absence;
	};

	route("PATCH", "/absences/:id", { permission: "absence.request", csrf: true }, context => {
		const absence = changeableAbsence(context);
		const body = context.jsonBody();
		const status = optionalString(body, "status");

		if (status !== null && status !== "taken" && status !== "planned") {
			throw new ValidationError(`status must be taken or planned (got ${status})`);
		}
		// changing the state of an absence is an approval, even for the own one
		if (status !== null && !context.auth?.permissions.includes("absence.approve")) {
			throw problem(403, "permission_denied", "request rejected (permission_denied: absence.approve)");
		}

		const patch = {
			typeId: optionalNumber(body, "typeId") ?? undefined,
			typeCode: optionalString(body, "typeCode") ?? undefined,
			dateFrom: optionalString(body, "dateFrom") ?? undefined,
			dateTo: optionalString(body, "dateTo") ?? undefined,
			dayPortion: optionalNumber(body, "dayPortion") ?? undefined,
			...(Object.prototype.hasOwnProperty.call(body, "hours") ? { hours: optionalNumber(body, "hours") } : {}),
			...(Object.prototype.hasOwnProperty.call(body, "note") ? { note: optionalString(body, "note") } : {}),
		};
		const hasFields = Object.values(patch).some(value => value !== undefined);

		// The same guard as in POST /absences: an employee may not move an absence to a type that is not public.
		if (
			hasFields &&
			!context.auth?.permissions.includes("absence.edit_other") &&
			(patch.typeId !== undefined || patch.typeCode !== undefined)
		) {
			const wanted = absences.findType(patch.typeId ?? patch.typeCode ?? "", absence.userId);
			if (!wanted) {
				throw new ValidationError("unknown absence type");
			}
			if (!wanted.isActive) {
				throw problem(
					403,
					"permission_denied",
					"request rejected (permission_denied: absence type is not public)",
				);
			}
		}

		if (status !== null) {
			absences.setStatus({
				id: absence.id,
				status,
				actorId: context.auth?.user.id ?? 0,
				actorIp: context.request.remoteAddress ?? null,
				now: now(),
			});
		}

		const changed = hasFields
			? absences.update({
					id: absence.id,
					patch,
					reason: optionalString(body, "reason"),
					actorId: context.auth?.user.id ?? 0,
					actorIp: context.request.remoteAddress ?? null,
					now: now(),
				})
			: (absences.findById(absence.id) ?? absence);

		// An employee who changes a request asks again: the decision of the administration belonged to the old
		// dates. Who may change absences of somebody else decides as well, so nothing goes back for them.
		const updated =
			hasFields && !context.auth?.permissions.includes("absence.edit_other") && changed.approval !== "requested"
				? absences.setApproval({
						id: changed.id,
						approval: "requested",
						note: null,
						actorId: context.auth?.user.id ?? 0,
						actorIp: context.request.remoteAddress ?? null,
						now: now(),
					})
				: changed;

		emit({ type: "absence.change", userId: updated.userId, data: { absenceId: updated.id, action: "updated" } });
		return json(200, { absence: publicAbsence(updated) });
	});

	route("DELETE", "/absences/:id", { permission: "absence.request", csrf: true }, context => {
		const absence = changeableAbsence(context);
		const removed = absences.remove({
			id: absence.id,
			actorId: context.auth?.user.id ?? 0,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`absence ${absence.id} not found`);
		}
		emit({ type: "absence.change", userId: absence.userId, data: { absenceId: absence.id, action: "deleted" } });
		return noContent();
	});

	// A cancellation of an approved absence. The employee asks for it; the days keep counting until the
	// administration answers — deleting the absence is the “yes”, declining the request leaves it as it is. An
	// employee never cancels around that decision, because deleting an absence of somebody else needs
	// `absence.edit_other` (`changeableAbsence`).
	route("POST", "/absences/:id/cancellation", { permission: "absence.request", csrf: true }, context => {
		const absence = changeableAbsence(context);
		const body = context.optionalJsonBody();
		const updated = absences.requestCancel({
			id: absence.id,
			note: optionalString(body, "note"),
			actorId: context.auth?.user.id ?? 0,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({
			type: "absence.change",
			userId: updated.userId,
			data: { absenceId: updated.id, action: "cancellation" },
		});
		return json(200, { absence: publicAbsence(updated) });
	});

	// The request goes back: the employee withdraws it, the administration declines it (`…/decline`). Both end in
	// the same state, only the log tells them apart.
	route("DELETE", "/absences/:id/cancellation", { permission: "absence.request", csrf: true }, context => {
		const absence = changeableAbsence(context);
		const updated = absences.clearCancel({
			id: absence.id,
			actorId: context.auth?.user.id ?? 0,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({
			type: "absence.change",
			userId: updated.userId,
			data: { absenceId: updated.id, action: "cancellationWithdrawn" },
		});
		return json(200, { absence: publicAbsence(updated) });
	});

	route("POST", "/absences/:id/cancellation/decline", { permission: "absence.approve", csrf: true }, context => {
		const id = numberParam(context, "id");
		const absence = absences.findById(id);
		if (!absence) {
			throw new NotFoundError(`absence ${id} not found`);
		}
		const body = context.optionalJsonBody();
		const updated = absences.clearCancel({
			id,
			declined: true,
			note: optionalString(body, "note"),
			actorId: context.auth?.user.id ?? 0,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		emit({
			type: "absence.change",
			userId: updated.userId,
			data: { absenceId: updated.id, action: "cancellationDeclined" },
		});
		return json(200, { absence: publicAbsence(updated) });
	});

	// master data: absence types, holidays and instance settings

	// The administration sees the types that are switched off as well — that is what “active” is for: an inactive type
	// stays out of the picker of the employees, while the administration can still book it for somebody.
	// The calendar feed: a public route with the secret in the URL, so a phone or a calendar app can subscribe without
	// a session. Two tokens are accepted: the personal one of an employee (nobody else sees anything through such a
	// link) and the token of the instance, which carries the absences of the whole company — that is the feed ioBroker
	// and a company calendar subscribe to.
	route(
		"GET",
		"/calendar.ics",
		{ public: true, csrf: false, rateLimit: { name: "calendar", limit: 30, windowSeconds: 60 } },
		context => {
			const token = (context.query("token") ?? "").trim();
			const instanceToken = settings.get("calendar_token");
			const company = instanceToken !== null && instanceToken !== "" && token === instanceToken;

			// without the instance token the link belongs to one employee
			const user = company || token === "" ? null : users.findByCalendarToken(token);
			if (!company && (!user || !user.isActive)) {
				throw problem(401, "invalid_credentials", "the calendar token is not valid");
			}

			// a window around today keeps a feed small: a year back and to the end of next year
			const stamp = now();
			const year = new Date(stamp * 1000).getUTCFullYear();
			const from = `${year - 1}-01-01`;
			const to = `${year + 1}-12-31`;

			// the company feed skips deactivated accounts (`users.list()` returns the active ones)
			const owners = user ? [user] : users.list();
			const employees = new Map(owners.map(employee => [employee.id, calendarEmployee(employee)]));
			const list = user ? absences.withTypesInRange(user.id, from, to) : absences.allInRange(from, to);
			const name = user
				? personalCalendarName(user.locale, user.displayName)
				: companyCalendarName(settings.get("default_language"));

			return binary(
				200,
				Buffer.from(calendarDocument(name, absenceEvents(list, employees, !user), stamp), "utf8"),
				ICAL_CONTENT_TYPE,
				{
					"content-disposition": 'inline; filename="time-tracker.ics"',
					"cache-control": "no-store",
				},
			);
		},
	);

	// The subscription link of the own calendar: the token is created on the first call and can be rotated, which
	// invalidates the old link. The administration may ask for the token of somebody else.
	route("POST", "/calendar/token", { permission: "report.view_own", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const userId = resolveScope(context, optionalNumber(body, "userId"), "report.view_own", "absence.edit_other");
		const current = users.findById(userId);
		if (!current) {
			throw new NotFoundError(`user ${userId} not found`);
		}

		const rotate = optionalBoolean(body, "rotate") ?? false;
		const token =
			rotate || current.calendarToken === null ? randomBytes(32).toString("base64url") : current.calendarToken;
		const updated = users.setCalendarToken({
			userId,
			token,
			actorId: context.auth.user.id,
			now: now(),
		});
		return json(200, { token: updated.calendarToken });
	});

	route("GET", "/absence-types", {}, context => {
		const includeInactive =
			context.query("includeInactive") === "true" &&
			(context.auth?.permissions.includes("absence.manage_types") ?? false);
		return json(200, {
			types: absences.types({ userId: context.auth?.user.id ?? null, includeInactive }),
		});
	});

	route("POST", "/absence-types", { permission: "absence.manage_types", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = context.jsonBody();
		const result = absences.upsertType({
			userId: optionalNumber(body, "userId"),
			code: requireString(body, "code"),
			name: requireString(body, "name"),
			paid: optionalBoolean(body, "paid") ?? undefined,
			factor: optionalNumber(body, "factor") ?? undefined,
			reduceVacation: optionalBoolean(body, "reduceVacation") ?? undefined,
			isActive: optionalBoolean(body, "isActive") ?? undefined,
			color: optionalString(body, "color"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(result.created ? 201 : 200, { type: result.type, created: result.created });
	});

	route("DELETE", "/absence-types/:id", { permission: "absence.manage_types", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const removed = absences.removeType({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`absence type ${context.params.id} not found`);
		}
		return noContent();
	});
}
