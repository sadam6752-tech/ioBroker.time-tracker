/**
 * Holidays, instance settings, break, trigger and automation rules, branding and version.
 */

import { createHash } from "node:crypto";

import type { AutomationKind, AutomationRepeat, AutomationRuleRecord } from "../../db/repositories/automations";
import type { PauseRuleRecord } from "../../db/repositories/rules";
import type { SettingValue } from "../../db/repositories/settings";
import type { TriggerAction, TriggerMode, TriggerRuleRecord } from "../../db/repositories/triggers";
import { NotFoundError, ValidationError } from "../../errors";
import { MAX_BRANDING_BYTES, parseAvatarDataUrl, readAvatar } from "../../domain/avatar";
import { problem } from "../problem";
import { json, noContent, binary, type RouteContext } from "../router";

import type { ApiContext } from "./context";
import { z } from "zod";
import {
	bodySchema,
	itemOf,
	lenientText,
	listOf,
	numberish,
	numberishList,
	optionalFlag,
	optionalNumber,
	optionalText,
	parseBody,
	requiredText,
} from "./validate";
import { JSON_SETTINGS, editableSettings, readableSettings, isSettingValue, numberParam } from "./shared";

/** Body of a holiday of the administration. */
const HOLIDAY_BODY = bodySchema({ date: requiredText(), name: requiredText(), region: optionalText() });

/** Body of the break rules: the list replaces the stored rules; the repository checks the values. */
const PAUSE_RULES_BODY = bodySchema({
	pauseRules: listOf(
		itemOf({
			id: optionalNumber(),
			fromMin: numberish(),
			toMin: optionalNumber(),
			pauseMin: numberish(),
			isActive: optionalFlag(),
		}),
	),
});

/** Body of the trigger rules: the list replaces the stored rules. */
const TRIGGER_RULES_BODY = bodySchema({
	triggerRules: listOf(
		itemOf({
			mode: optionalText(),
			userId: optionalNumber(),
			// the value map: which employee a value of the state belongs to (mode `user`)
			valueMap: field =>
				z
					.array(itemOf({ value: lenientText(), userId: optionalNumber() }), {
						error: `${field} must be a list`,
					})
					.nullish(),
			id: optionalNumber(),
			label: optionalText(),
			sourceState: optionalText(),
			condition: optionalText(),
			action: optionalText(),
			isActive: optionalFlag(),
			cooldownSec: optionalNumber(),
			fireOnRepeat: optionalFlag(),
		}),
	),
});

/** Body of the automation rules: the list replaces the stored rules; the repository checks kind and repeat. */
const AUTOMATION_RULES_BODY = bodySchema({
	automationRules: listOf(
		itemOf({
			userId: optionalNumber(),
			id: optionalNumber(),
			label: optionalText(),
			kind: optionalText(),
			atMinute: optionalNumber(),
			afterMinutes: optionalNumber(),
			weekdays: numberishList(),
			repeat: optionalText(),
			isActive: optionalFlag(),
			activeFrom: optionalText(),
			activeUntil: optionalText(),
		}),
	),
});

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerSettingsRoutes(ctx: ApiContext): void {
	const { deps, users, holidays, rules, triggers, automations, settings, now, route, numberQuery } = ctx;

	route("GET", "/holidays", { permission: "report.view_own" }, context => {
		const year = numberQuery(context, "year");
		const region = context.query("region") ?? undefined;
		return json(200, { year, region: region ?? null, holidays: holidays.listByYear(year, region) });
	});

	route("POST", "/holidays", { permission: "holiday.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = parseBody(HOLIDAY_BODY, context.jsonBody());
		const created = holidays.add({
			date: body.date,
			name: body.name,
			// without a region the day belongs to the country of the instance: the calculation looks only there, so a
			// day filed under a foreign region would never count
			region: body.region ?? settings.get("holiday_country") ?? undefined,
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		return json(201, { holiday: created }, { location: `/holidays/${created.id}` });
	});

	route("DELETE", "/holidays/:id", { permission: "holiday.manage", csrf: true }, context => {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const removed = holidays.remove({
			id: numberParam(context, "id"),
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		});
		if (!removed) {
			throw new NotFoundError(`holiday ${context.params.id} not found`);
		}
		return noContent();
	});

	route("GET", "/settings", { permission: "settings.view" }, () =>
		json(200, { settings: readableSettings(settings.all()) }),
	);

	route("PUT", "/settings", { permission: "settings.edit", csrf: true }, context => {
		const body = context.jsonBody();
		const changes: Record<string, SettingValue> = {};
		for (const [key, value] of Object.entries(body)) {
			if (!editableSettings().includes(key)) {
				throw new ValidationError(`setting "${key}" cannot be changed through the API`);
			}
			// the branding pictures and the accent colour have rules of their own: a picture (data URL) and a hex
			// colour — and they are the only settings that a public route hands out
			if (key === "brand_logo" || key === "brand_background") {
				const raw = typeof value === "string" ? value.trim() : "";
				if (raw !== "" && !parseAvatarDataUrl(raw, MAX_BRANDING_BYTES)) {
					throw new ValidationError(
						`setting "${key}" must be a data URL of a png, jpeg, webp or gif of up to ${MAX_BRANDING_BYTES} bytes`,
					);
				}
				changes[key] = raw;
				continue;
			}
			if (key === "brand_color") {
				const raw = typeof value === "string" ? value.trim() : "";
				if (raw !== "" && !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(raw)) {
					throw new ValidationError('setting "brand_color" must be a hex colour like "#1a2b3c"');
				}
				changes[key] = raw;
				continue;
			}
			// the pause mode decides how the pause of a day is determined; the calculation tolerates an unknown
			// value, but the API does not hand one out in the first place
			if (key === "pause_mode") {
				if (value !== "auto" && value !== "punched" && value !== "staffel") {
					throw new ValidationError('setting "pause_mode" must be "auto", "punched" or "staffel"');
				}
				changes[key] = value;
				continue;
			}
			if (!isSettingValue(value, JSON_SETTINGS.includes(key))) {
				throw new ValidationError(`setting "${key}" has an unsupported value`);
			}
			changes[key] = value as SettingValue;
		}
		if (Object.keys(changes).length === 0) {
			throw new ValidationError("no settings given");
		}

		for (const [key, value] of Object.entries(changes)) {
			settings.set(key, value, context.auth?.user.id ?? null, now());
		}
		return json(200, { settings: changes });
	});

	/**
	 * Replaces the graduated break rules of one owner.
	 *
	 * The payload is the whole table: rules that are missing are removed, the rest is saved. Values are checked by
	 * the repository, so an impossible rule becomes a client error.
	 *
	 * @param context - route context of the request
	 * @param userId - owner of the rules, `null` for the company default
	 * @returns the saved rules
	 */
	function replacePauseRules(context: RouteContext, userId: number | null): PauseRuleRecord[] {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = parseBody(PAUSE_RULES_BODY, context.jsonBody());
		const actor = {
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		};
		const wanted = body.pauseRules.map(rule => ({
			...rule,
			id: rule.id ?? undefined,
			isActive: rule.isActive ?? undefined,
		}));

		const keep = new Set(wanted.map(rule => rule.id).filter((value): value is number => value !== undefined));
		for (const existing of rules.listPauseRules({ userId, includeInactive: true })) {
			if (!keep.has(existing.id)) {
				rules.removePauseRule({ id: existing.id, ...actor });
			}
		}
		return wanted.map(rule =>
			rules.savePauseRule({
				...(rule.id !== undefined ? { id: rule.id } : {}),
				userId,
				fromMin: rule.fromMin,
				toMin: rule.toMin,
				pauseMin: rule.pauseMin,
				...(rule.isActive !== undefined ? { isActive: rule.isActive } : {}),
				...actor,
			}),
		);
	}

	// graduated break rules of the instance (the company default): they decide the pause of a day on which nobody
	// punched a break, so they are edited as a whole table — like the shift rules of an employee.

	route("GET", "/pause-rules", { permission: "settings.view" }, () =>
		json(200, { pauseRules: rules.listPauseRules({ userId: null, includeInactive: true }) }),
	);

	route("PUT", "/pause-rules", { permission: "settings.edit", csrf: true }, context =>
		json(200, { pauseRules: replacePauseRules(context, null) }),
	);

	// The rules of one employee: they replace the company rule with the same `fromMin`, so a single person can
	// deviate from the house rule without changing it for everybody.

	route("GET", "/users/:id/pause-rules", { permission: "user.view" }, context => {
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, { pauseRules: rules.listPauseRules({ userId: id, includeInactive: true }) });
	});

	route("PUT", "/users/:id/pause-rules", { permission: "user.edit", csrf: true }, context => {
		const id = numberParam(context, "id");
		if (!users.findById(id)) {
			throw new NotFoundError(`user ${id} not found`);
		}
		return json(200, { pauseRules: replacePauseRules(context, id) });
	});

	/**
	 * Replaces the trigger rules.
	 *
	 * Like the break rules the payload is the whole table: rules that are missing are removed, the rest is saved.
	 * The values are checked by the repository, so an impossible rule becomes a client error. Afterwards the
	 * adapter is told to watch the states of the new list.
	 *
	 * @param context - route context of the request
	 * @returns the saved rules
	 */
	function replaceTriggerRules(context: RouteContext): TriggerRuleRecord[] {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = parseBody(TRIGGER_RULES_BODY, context.jsonBody());
		const actor = {
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		};
		const wanted = body.triggerRules.map(rule => {
			const mode = rule.mode ?? "condition";
			const target = rule.userId;
			if (mode === "condition" && target !== null && !users.findById(target)) {
				throw new ValidationError(`userId must reference an existing employee (got ${target})`);
			}
			if (mode === "user" && target !== null) {
				throw new ValidationError("mode user reads the employee from the state, userId has to stay empty");
			}
			// the value map: which employee a value of the state belongs to (mode `user`)
			const valueMap = (rule.valueMap ?? []).map(item => {
				if (item.userId === null || !users.findById(item.userId)) {
					throw new ValidationError(`valueMap must reference existing employees (got ${item.userId})`);
				}
				return { value: item.value, userId: item.userId };
			});
			return {
				id: rule.id ?? undefined,
				label: rule.label,
				sourceState: rule.sourceState ?? "",
				mode,
				condition: rule.condition,
				userId: target,
				action: rule.action ?? "punch",
				isActive: rule.isActive ?? true,
				cooldownSec: rule.cooldownSec ?? 0,
				fireOnRepeat: rule.fireOnRepeat ?? mode === "user",
				valueMap,
			};
		});

		const keep = new Set(wanted.map(rule => rule.id).filter((value): value is number => value !== undefined));
		for (const existing of triggers.list({ includeInactive: true })) {
			if (!keep.has(existing.id)) {
				triggers.remove({ id: existing.id, ...actor });
			}
		}

		const saved = wanted.map(rule =>
			triggers.save({
				...(rule.id !== undefined ? { id: rule.id } : {}),
				label: rule.label,
				sourceState: rule.sourceState,
				mode: rule.mode as TriggerMode,
				condition: rule.condition,
				userId: rule.userId,
				action: rule.action as TriggerAction,
				isActive: rule.isActive,
				cooldownSec: rule.cooldownSec,
				fireOnRepeat: rule.fireOnRepeat,
				valueMap: rule.valueMap,
				...actor,
			}),
		);

		// the adapter subscribes to the states the rules name: tell it about the new list right away
		deps.onTriggerRulesChanged?.();
		return saved;
	}

	// Trigger rules: a state of another adapter (fingerprint reader, button, door contact) punches or sets the
	// presence. The rules are edited as a whole table, like the break rules of the company.
	route("GET", "/trigger-rules", { permission: "settings.view" }, () =>
		json(200, { triggerRules: triggers.list({ includeInactive: true }) }),
	);

	route("PUT", "/trigger-rules", { permission: "settings.edit", csrf: true }, context =>
		json(200, { triggerRules: replaceTriggerRules(context) }),
	);

	/**
	 * Replaces the automation rules.
	 *
	 * Like the other rule tables the payload is the whole table: rules that are missing are removed, the rest is
	 * saved. The adapter reads the table every minute, so nothing has to be told about the change.
	 *
	 * @param context - route context of the request
	 * @returns the saved rules
	 */
	function replaceAutomationRules(context: RouteContext): AutomationRuleRecord[] {
		if (!context.auth) {
			throw problem(401, "no_session", "request rejected (no_session)");
		}
		const body = parseBody(AUTOMATION_RULES_BODY, context.jsonBody());
		const actor = {
			actorId: context.auth.user.id,
			actorIp: context.request.remoteAddress ?? null,
			now: now(),
		};
		const wanted = body.automationRules.map(rule => {
			const target = rule.userId;
			if (target !== null && !users.findById(target)) {
				throw new ValidationError(`userId must reference an existing employee (got ${target})`);
			}
			return {
				id: rule.id ?? undefined,
				label: rule.label,
				kind: rule.kind ?? "clockOut",
				userId: target,
				atMinute: rule.atMinute,
				afterMinutes: rule.afterMinutes,
				// the repository validates the selection and the repeat: a wrong entry comes back as a 400
				weekdays: rule.weekdays,
				repeat: rule.repeat as AutomationRepeat | undefined,
				isActive: rule.isActive ?? true,
				activeFrom: rule.activeFrom,
				activeUntil: rule.activeUntil,
			};
		});

		const keep = new Set(wanted.map(rule => rule.id).filter((value): value is number => value !== undefined));
		for (const existing of automations.list({ includeInactive: true })) {
			if (!keep.has(existing.id)) {
				automations.remove({ id: existing.id, ...actor });
			}
		}

		return wanted.map(rule =>
			automations.save({
				...(rule.id !== undefined ? { id: rule.id } : {}),
				label: rule.label,
				kind: rule.kind as AutomationKind,
				userId: rule.userId,
				atMinute: rule.atMinute,
				afterMinutes: rule.afterMinutes,
				...(rule.weekdays === undefined ? {} : { weekdays: rule.weekdays }),
				...(rule.repeat === undefined ? {} : { repeat: rule.repeat }),
				isActive: rule.isActive,
				activeFrom: rule.activeFrom,
				activeUntil: rule.activeUntil,
				...actor,
			}),
		);
	}

	// Automation rules: what the adapter does on its own — clock out at a time, report a missing punch, remind
	// about a break. Every rule comes with its newest run, so the administration sees at one glance whether it
	// still works; the complete log stays in the repository.
	route("GET", "/automation-rules", { permission: "settings.view" }, () =>
		json(200, { automationRules: automations.list({ includeInactive: true }) }),
	);

	route("GET", "/automation-rules/runs", { permission: "settings.view" }, () =>
		json(200, { runs: automations.latestRuns() }),
	);

	route("PUT", "/automation-rules", { permission: "settings.edit", csrf: true }, context =>
		json(200, { automationRules: replaceAutomationRules(context) }),
	);

	// branding: logo, background and accent colour of the installation.
	//
	// The values are public on purpose — the sign in screen, the kiosk terminal and the presence screen show them
	// before anybody is signed in. Written they are through the settings route above, delivered here as a small
	// JSON plus two image routes, so a browser can cache the pictures.

	/**
	 * Short fingerprint of a stored branding picture.
	 *
	 * It goes into the image URLs, so a browser picks up a new logo right away while the old picture stays cached
	 * until then.
	 *
	 * @param value - stored data URL
	 * @returns twelve hex characters
	 */
	const brandingVersion = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

	/**
	 * Reads the branding.
	 *
	 * @returns colour and the addresses of the two pictures, `null` when nothing is configured
	 */
	const brandingState = (): {
		/** Accent colour of the instance, `null` when none is configured */
		color: string | null;
		/** Address of the logo, `null` when none is configured */
		logoUrl: string | null;
		/** Address of the background picture, `null` when none is configured */
		backgroundUrl: string | null;
	} => {
		const color = (settings.get("brand_color") ?? "").trim();
		const logo = (settings.get("brand_logo") ?? "").trim();
		const background = (settings.get("brand_background") ?? "").trim();
		return {
			color: color === "" ? null : color,
			logoUrl: logo === "" ? null : `/api/branding/logo?v=${brandingVersion(logo)}`,
			backgroundUrl: background === "" ? null : `/api/branding/background?v=${brandingVersion(background)}`,
		};
	};

	route("GET", "/branding", { public: true }, () => json(200, brandingState()));

	route("GET", "/branding/logo", { public: true }, () => {
		const image = readAvatar(settings.get("brand_logo"));
		if (!image) {
			throw new NotFoundError("no logo is configured");
		}
		return binary(200, Buffer.from(image.base64, "base64"), image.contentType, {
			"cache-control": "public, max-age=86400",
		});
	});

	route("GET", "/branding/background", { public: true }, () => {
		const image = readAvatar(settings.get("brand_background"));
		if (!image) {
			throw new NotFoundError("no background is configured");
		}
		return binary(200, Buffer.from(image.base64, "base64"), image.contentType, {
			"cache-control": "public, max-age=86400",
		});
	});

	route("GET", "/version", { public: true }, () =>
		json(200, { name: "iobroker.time-tracker", version: deps.version ?? "0.0.0" }),
	);

	// What the administration page "Info" shows. `GET /version` stays open (tools and monitoring read it); this
	// route is for the signed-in administrator, who also sees the version of the web app next to it.
	route("GET", "/system/info", { permission: "settings.edit" }, () =>
		json(200, { name: "iobroker.time-tracker", version: deps.version ?? "0.0.0" }),
	);
}
