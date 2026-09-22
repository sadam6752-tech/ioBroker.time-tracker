/**
 * Messages of the adapter (`sendTo`).
 *
 * A script adapter, Blockly or another adapter can drive the time tracking without HTTP and without a session:
 * `sendTo("time-tracker.0", "punch", { user: "anna" }, callback)`. Every command answers with an object, so the
 * caller can react on the outcome.
 *
 * | Command   | Payload                                   | Answer                                |
 * | --------- | ----------------------------------------- | ------------------------------------- |
 * | `punch`   | `{ user, quick?, note? }`                 | `{ userId, message }`                 |
 * | `present` | `{ user, present }`                       | `{ userId, present, changed }`        |
 * | `status`  | `{ user }`                                | figures of the employee               |
 * | `report`  | `{ user, period?, format? }`              | `{ fileName, mimeType, base64 }`      |
 * | `backup`  | —                                         | `{ name, sizeBytes }`                 |
 *
 * `user` is a user id, a login or the shown name — the same resolution the trigger rules use.
 */

import type { AbsencesRepository } from "../db/repositories/absences";
import type { EntriesRepository } from "../db/repositories/entries";
import type { SettingsRepository } from "../db/repositories/settings";
import type { UserRecord, UsersRepository } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import type { BackupService } from "../services/backup";
import type { SyncService } from "../services/sync";
import { ValidationError } from "../errors";
import { buildMonthStatement } from "../reports/pdf";
import { reportLabels } from "../reports/labels";
import { reportFileName, type ReportInput } from "../reports/types";
import { buildMonthReport } from "../reports/xls";
import { localDate } from "../util/time";
import { punchEmployee } from "./commands";
import { handlePresenceState } from "./presence";
import { readUserSnapshot } from "./states";
import { resolveTriggerUser } from "./triggers";

/** Data a message needs. */
export interface MessageDeps {
	/** User storage */
	users: UsersRepository;
	/** Punch storage */
	entries: EntriesRepository;
	/** Absences (the monthly statement shows them) */
	absences: AbsencesRepository;
	/** Instance settings (quick rounding, font of the statements) */
	settings: SettingsRepository;
	/** Aggregation service */
	aggregation: AggregationService;
	/** Synchronisation service (open conflicts) */
	sync: SyncService;
	/** Backup service, optional: without it the command is refused */
	backup?: Pick<BackupService, "create">;
	/** Version printed into a generated statement */
	version?: string;
	/** Instant source, defaults to the system clock */
	now?: () => number;
}

/** Answer of a message. */
export interface MessageResult {
	/** True when the command ran */
	ok: boolean;
	/** Human readable summary */
	message: string;
	/** Command specific answer for the caller of `sendTo` */
	data?: Record<string, unknown>;
}

/**
 * Reads a text field of a message payload.
 *
 * @param payload - payload of the message
 * @param field - field name
 * @returns the trimmed text or `null`
 */
function textField(payload: Record<string, unknown>, field: string): string | null {
	const value = payload[field];
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (typeof value !== "string") {
		throw new ValidationError(`${field} must be a string (got ${typeof value})`);
	}
	return value.trim() || null;
}

/**
 * Reads a boolean field of a message payload.
 *
 * @param payload - payload of the message
 * @param field - field name
 * @returns the boolean, or `null` when the field is missing
 */
function booleanField(payload: Record<string, unknown>, field: string): boolean | null {
	const value = payload[field];
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value !== 0;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "on"].includes(normalized)) {
			return true;
		}
		if (["false", "0", "no", "off", ""].includes(normalized)) {
			return false;
		}
	}
	throw new ValidationError(`${field} must be a boolean (got ${JSON.stringify(value)})`);
}

/**
 * Resolves the employee a message names.
 *
 * @param payload - payload of the message
 * @param users - user storage
 * @returns the employee
 */
function targetUser(payload: Record<string, unknown>, users: UsersRepository): UserRecord {
	const raw = payload.user ?? payload.userId;
	if (raw === undefined || raw === null || raw === "") {
		throw new ValidationError("user is required: pass a user id, a login or the shown name");
	}
	// a value of another type cannot name an employee; it is only reported back
	const asText = typeof raw === "string" || typeof raw === "number" ? String(raw) : JSON.stringify(raw);
	const user = resolveTriggerUser(typeof raw === "number" ? raw : asText, users);
	if (!user) {
		throw new ValidationError(`no employee matches ${asText}`);
	}
	return user;
}

/**
 * Builds the input of a monthly statement.
 *
 * @param deps - data sources
 * @param user - employee the statement belongs to
 * @param year - four digit year
 * @param month - month, 1 to 12
 * @returns the report input including the generator line
 */
function statementInput(
	deps: MessageDeps,
	user: UserRecord,
	year: number,
	month: number,
): ReportInput & { generator: string } {
	const timestamp = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
	const prefix = `${year}-${String(month).padStart(2, "0")}`;
	const first = `${prefix}-01`;
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const last = `${prefix}-${String(lastDay).padStart(2, "0")}`;
	// a statement has to show the current state of the month, so the range is recalculated first
	deps.aggregation.recalculateRange(user.id, first, last, { now: timestamp });
	const { labels, language } = reportLabels(user.locale);

	return {
		user: { displayName: user.displayName, login: user.login, timezone: user.timezone },
		labels,
		language,
		locale: user.locale || "en",
		year,
		month,
		days: deps.aggregation.days(user.id, first, last),
		absences: deps.absences.withTypesInRange(user.id, first, last).map(absence => ({
			typeCode: absence.typeCode,
			typeName: absence.typeName,
			dateFrom: absence.dateFrom,
			dateTo: absence.dateTo,
			dayPortion: absence.dayPortion,
			hours: absence.hours,
		})),
		generatedAt: timestamp,
		generator: `time-tracker ${deps.version ?? ""}`.trim(),
	};
}

/**
 * Applies a message of a script, a Blockly block or another adapter.
 *
 * @param deps - data sources
 * @param command - name of the command
 * @param payload - payload of the message
 * @returns the answer for the caller
 */
export async function handleMessage(deps: MessageDeps, command: string, payload: unknown): Promise<MessageResult> {
	const body = (payload ?? {}) as Record<string, unknown>;
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

	if (command === "punch") {
		const user = targetUser(body, deps.users);
		const result = punchEmployee(
			{ entries: deps.entries, users: deps.users, settings: deps.settings, aggregation: deps.aggregation },
			{
				userId: user.id,
				quick: booleanField(body, "quick") === true,
				note: textField(body, "note") ?? "sendTo.punch",
				now: now(),
			},
		);
		return {
			ok: true,
			message: result.message,
			data: { userId: user.id, direction: result.direction, message: result.message },
		};
	}

	if (command === "present") {
		const user = targetUser(body, deps.users);
		const desired = booleanField(body, "present");
		if (desired === null) {
			throw new ValidationError("present is required: pass true or false");
		}
		const result = handlePresenceState(
			{ entries: deps.entries, users: deps.users, aggregation: deps.aggregation, now },
			`users.${user.id}.present`,
			desired,
		);
		return {
			ok: result.ok,
			message: result.message,
			data: {
				userId: user.id,
				present: result.present,
				changed: result.changed,
				direction: result.changed ? (result.present ? "in" : "out") : null,
			},
		};
	}

	if (command === "status") {
		const user = targetUser(body, deps.users);
		const snapshot = readUserSnapshot({
			aggregation: deps.aggregation,
			users: deps.users,
			sync: deps.sync,
			userId: user.id,
			now: now(),
		});
		if (!snapshot) {
			throw new ValidationError(`employee ${user.id} disappeared`);
		}
		return { ok: true, message: `figures of ${user.displayName}`, data: { ...snapshot } };
	}

	if (command === "report") {
		const user = targetUser(body, deps.users);
		const format = (textField(body, "format") ?? "pdf").toLowerCase();
		if (format !== "pdf" && format !== "xlsx") {
			throw new ValidationError(`format must be pdf or xlsx (got ${format})`);
		}
		const period = textField(body, "period") ?? localDate(now(), user.timezone).slice(0, 7);
		const match = /^(\d{4})-(\d{2})$/.exec(period);
		if (!match) {
			throw new ValidationError(`period must be YYYY-MM (got "${period}")`);
		}
		const year = Number(match[1]);
		const month = Number(match[2]);
		if (month < 1 || month > 12) {
			throw new ValidationError(`month must be between 1 and 12 (got ${month})`);
		}

		const input = statementInput(deps, user, year, month);
		const file =
			format === "pdf"
				? await buildMonthStatement({ ...input, fontPath: deps.settings.get("report_font_path") ?? "" })
				: await buildMonthReport(input);
		const fileName = reportFileName(user.login, year, month, format === "pdf" ? "pdf" : "xlsx");

		return {
			ok: true,
			message: `${fileName} (${file.length} bytes)`,
			data: {
				userId: user.id,
				fileName,
				mimeType:
					format === "pdf"
						? "application/pdf"
						: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				bytes: file.length,
				base64: file.toString("base64"),
			},
		};
	}

	if (command === "backup") {
		if (!deps.backup) {
			throw new ValidationError("this instance has no backup service");
		}
		const created = deps.backup.create({ actorId: 0, reason: "sendTo" });
		return {
			ok: true,
			message: `backup ${created.backup.name} written (${created.backup.sizeBytes} bytes)`,
			data: { name: created.backup.name, sizeBytes: created.backup.sizeBytes, removed: created.removed },
		};
	}

	throw new ValidationError(`unknown command "${command}": use punch, present, status, report or backup`);
}
