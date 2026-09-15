/**
 * Legacy import: SMALL-Time `Data` directory → SQLite (specification 2.9.10).
 *
 * The import runs in one transaction and is idempotent: a second `commit` run adds no rows. It is a
 * library without side effects beyond the database — the caller (adapter command, API route) decides when
 * it runs and what it does with the report.
 *
 * Ablauf (2.9.10):
 *  1. detection: `./Data` is scanned for user folders (`scan.ts`)
 *  2. `dry-run`: writes only the `import_runs` report, every other write is rolled back
 *  3. `commit`: imports every source in **one** transaction and then recomputes all aggregates from
 *     `time_entries`/`absences` — legacy aggregates are never taken over
 *  4. golden test: the recomputed monthly targets and balances have to reproduce `Timetable/<year>`
 *     (±0.01 h per month), otherwise the run ends with `mismatch`
 *  5. idempotency: every record carries either an `idempotency_key` or is looked up before it is written
 *
 * Deliberate decisions, documented in the run report:
 *  - Legacy punch files store **UTC instants** (PHP `time()`); the time zone only decides which local date
 *    a punch belongs to. The assumption is recorded in `import_runs.timezone_assumed`.
 *  - Entries are written with `created_by = NULL` (system actor, 2.9.4); their audit row is attributed to
 *    the importing user, and `import_runs.actor_id` documents who started the run.
 *  - Legacy badge codes cannot be modelled by `RfidRepository` (it stores signed HMAC tokens), so they are
 *    imported read-only as `rfid_tags.legacy_code` with `is_active = 0` (2.9.1).
 */

import { readFileSync } from "node:fs";
import type { Db } from "../db/database";
import type { AbsencesRepository } from "../db/repositories/absences";
import type { EntriesRepository } from "../db/repositories/entries";
import type { PayoutsRepository } from "../db/repositories/payouts";
import type { RulesRepository } from "../db/repositories/rules";
import type { SettingsRepository } from "../db/repositories/settings";
import type { UsersRepository } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import { detectLegacyLayout, readLegacyEmail, type LegacyLayout, type LegacyUserFolder } from "./scan";
import {
	parseAbsenceTypes,
	parseAbsences,
	parseGroups,
	parseMonthPunches,
	parsePauseRules,
	parsePayouts,
	parseSettings,
	parseTotals,
	parseUserData,
	parseUsers,
	parseYearTargets,
	type LegacyPauseRule,
	type LegacyShiftRule,
} from "./parsers";

/** `dry-run` counts and validates, `commit` writes. */
export type LegacyImportMode = "dry-run" | "commit";

/** Outcome of a run (`import_runs.status`). */
export type LegacyImportStatus = "ok" | "warnings" | "mismatch" | "failed";

/** Time zone assumed for the legacy punches when no other one is given (2.9.4). */
export const LEGACY_DEFAULT_TIMEZONE = "Europe/Zurich";

/** Tolerance of the golden comparison per month: ±0.01 h (2.9.5). */
export const GOLDEN_TOLERANCE_MINUTES = 0.6;

/** Options of one import run. */
export interface LegacyImportOptions {
	/** Folder chosen by the operator: the installation folder or its `Data` folder */
	baseDir: string;
	/** `dry-run` (default) or `commit` */
	mode?: LegacyImportMode;
	/** Time zone the legacy punches are interpreted in, default `Europe/Zurich` */
	timezone?: string;
	/** User starting the import (audit trail and `import_runs.actor_id`) */
	actorId: number;
	/** True to allow a `commit` into a database that already holds entries, absences or payouts */
	resetImport?: boolean;
	/** Instant of the run, defaults to now */
	now?: number;
	/** Optional log callback (adapter debug log) */
	log?: (message: string) => void;
}

/** Data sources the import writes through. */
export interface LegacyImportDeps {
	/** Open database handle */
	db: Db;
	/** User storage */
	users: UsersRepository;
	/** Punch storage */
	entries: EntriesRepository;
	/** Absence storage */
	absences: AbsencesRepository;
	/** Break and surcharge rules */
	rules: RulesRepository;
	/** Instance settings */
	settings: SettingsRepository;
	/** Payout storage */
	payouts: PayoutsRepository;
	/** Aggregation service used for the recomputation and the golden comparison */
	aggregation: AggregationService;
}

/** One month whose recomputed values do not reproduce the legacy file. */
export interface LegacyGoldenDeviation {
	/** Login of the employee */
	login: string;
	/** Calendar year */
	year: number;
	/** Month, 1 based */
	month: number;
	/** Balance of the legacy file in minutes */
	expectedBalanceMin: number;
	/** Balance the adapter computed in minutes */
	actualBalanceMin: number;
	/** Target of the legacy file in minutes */
	expectedTargetMin: number;
	/** Target the adapter computed in minutes */
	actualTargetMin: number;
}

/** Counters of one run (`import_runs.stats`). */
export interface LegacyImportStats {
	/** User folders found in the legacy data */
	userFolders: number;
	/** Users created */
	usersCreated: number;
	/** Users that already existed (matched by login) */
	usersExisting: number;
	/** Work profiles written */
	workProfiles: number;
	/** Surcharge rules written */
	shiftRules: number;
	/** Break rules written */
	pauseRules: number;
	/** User specific absence types written */
	absenceTypes: number;
	/** Absences written */
	absences: number;
	/** Absences skipped because they already exist */
	absencesSkipped: number;
	/** Punches written */
	entries: number;
	/** Punches skipped because their idempotency key already exists */
	entriesSkipped: number;
	/** Payouts written */
	payouts: number;
	/** Legacy badge codes written */
	rfidTags: number;
	/** Settings written */
	settings: number;
	/** Months the golden comparison checked */
	goldenMonths: number;
	/** Months that deviate beyond the tolerance */
	goldenDeviations: number;
	/** Control value: total balance in hours from `total.txt` (2.9.7) */
	totalBalanceHours: number | null;
	/** Control value: the undocumented second value of `total.txt` */
	totalSecondValue: number | null;
	/** Files and folders that were ignored */
	skippedFiles: number;
}

/** Result of one run. */
export interface LegacyImportReport {
	/** Id of the `import_runs` row */
	runId: number;
	/** Mode the run was started with */
	mode: LegacyImportMode;
	/** Outcome (`import_runs.status`) */
	status: LegacyImportStatus;
	/** Installation folder that was read */
	baseDir: string;
	/** Time zone the punches were interpreted in */
	timezoneAssumed: string;
	/** Counters */
	stats: LegacyImportStats;
	/** Remarks, including the ones of the parsers */
	warnings: string[];
	/** Months that do not reproduce the legacy values */
	deviations: LegacyGoldenDeviation[];
}

/** Group number whose members become administrators (2.9.1). */
const ADMIN_GROUP_ID = 1;

/** Role of every user that is not in the administrator group. */
const DEFAULT_ROLE = "employee";

/**
 * Reads a file of the legacy installation as UTF-8 text.
 *
 * @param path - absolute path of the file
 * @returns the file content
 */
function readText(path: string): string {
	return readFileSync(path, "utf8");
}

/**
 * Creates an empty counter set.
 *
 * @returns counters with all values zero
 */
function emptyStats(): LegacyImportStats {
	return {
		userFolders: 0,
		usersCreated: 0,
		usersExisting: 0,
		workProfiles: 0,
		shiftRules: 0,
		pauseRules: 0,
		absenceTypes: 0,
		absences: 0,
		absencesSkipped: 0,
		entries: 0,
		entriesSkipped: 0,
		payouts: 0,
		rfidTags: 0,
		settings: 0,
		goldenMonths: 0,
		goldenDeviations: 0,
		totalBalanceHours: null,
		totalSecondValue: null,
		skippedFiles: 0,
	};
}

/**
 * Formats a local calendar date of a day of the year.
 *
 * @param year - four digit year
 * @param dayOfYear - day of the year, 1 based
 * @returns date in `YYYY-MM-DD`
 */
function dateFromDayOfYear(year: number, dayOfYear: number): string {
	const start = Date.UTC(year, 0, 1);
	const date = new Date(start + (dayOfYear - 1) * 86400000);
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** A user that took part in the run (created or matched by login). */
interface ImportedUser {
	/** Login of the user folder */
	login: string;
	/** Id in the new database */
	userId: number;
	/** Scanned folder */
	folder: LegacyUserFolder;
}

/** Mutable state shared by the steps of one run. */
interface RunContext {
	/** Data sources */
	deps: LegacyImportDeps;
	/** Detected installation */
	layout: LegacyLayout;
	/** User that started the run */
	actorId: number;
	/** Instant of the run */
	now: number;
	/** Time zone the punches are interpreted in */
	timezone: string;
	/** True for a `dry-run` (every write is rolled back) */
	dryRun: boolean;
	/** Counters */
	stats: LegacyImportStats;
	/** Collected remarks */
	warnings: string[];
	/** Golden deviations */
	deviations: LegacyGoldenDeviation[];
}

/**
 * Creates the `import_runs` row of a run.
 *
 * The row is written **before** the transaction so it survives a rollback (dry-run) and a failure.
 *
 * @param ctx - run state
 * @param mode - mode of the run
 * @returns id of the created row
 */
function insertRunRow(ctx: RunContext, mode: LegacyImportMode): number {
	const result = ctx.deps.db
		.prepare(
			`INSERT INTO import_runs (source, source_path, started_at, mode, status, timezone_assumed, actor_id)
			 VALUES ('smalltime', ?, ?, ?, 'running', ?, ?)`,
		)
		.run(ctx.layout.dataDir, ctx.now, mode, ctx.timezone, ctx.actorId);
	return Number(result.lastInsertRowid);
}

/**
 * Writes the counters, the remarks and the outcome into the `import_runs` row.
 *
 * @param ctx - run state
 * @param runId - id of the row
 * @param status - outcome of the run
 * @param finishedAt - instant the run ended
 */
function finishRunRow(ctx: RunContext, runId: number, status: LegacyImportStatus, finishedAt: number): void {
	ctx.deps.db
		.prepare("UPDATE import_runs SET finished_at = ?, status = ?, stats = ?, warnings = ? WHERE id = ?")
		.run(finishedAt, status, JSON.stringify(ctx.stats), JSON.stringify(ctx.warnings), runId);
}

/**
 * Refuses to import into a database that already holds time data unless `resetImport` is set (2.9.10).
 *
 * @param ctx - run state
 * @param resetImport - true when the operator allowed the import explicitly
 */
function assertDatabaseWritable(ctx: RunContext, resetImport: boolean): void {
	if (resetImport) {
		ctx.warnings.push("resetImport is set — existing entries, absences and payouts were not cleared");
		return;
	}
	const row = ctx.deps.db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM time_entries) AS entries,
			        (SELECT COUNT(*) FROM absences)     AS absences,
			        (SELECT COUNT(*) FROM payouts)      AS payouts`,
		)
		.get() as { entries: number; absences: number; payouts: number };
	if (row.entries > 0 || row.absences > 0 || row.payouts > 0) {
		throw new Error(
			`the database already holds ${row.entries} entry(ies), ${row.absences} absence(s) and ${row.payouts} payout(s) — ` +
				"import into an empty database or pass resetImport",
		);
	}
}

/**
 * Turns the legacy auto pause settings into one rule (2.9.8).
 *
 * @param fromHours - line 22: hours from which the pause applies (decimal hours)
 * @param pauseMinutes - line 23: length of the automatic pause in minutes
 * @returns the derived rule
 */
function derivedPauseRule(fromHours: number, pauseMinutes: number): LegacyPauseRule {
	return { fromMinutes: Math.round(fromHours * 60), toMinutes: null, pauseMinutes: Math.round(pauseMinutes) };
}

/**
 * Imports `include/Settings/settings.txt` into `app_settings` and the break rules into `pause_rules`.
 *
 * The graduated break file wins; when it is missing or empty, the two legacy settings (line 22 and 23) are
 * turned into one rule (2.9.8).
 *
 * @param ctx - run state
 */
function importSettings(ctx: RunContext): void {
	const { settingsFile, pauseFile } = ctx.layout;

	let autoPause: { fromHours: number; minutes: number } | null = null;
	if (settingsFile) {
		const parsed = parseSettings(readText(settingsFile));
		ctx.warnings.push(...parsed.warnings);

		const mapped: [string, string][] = [];
		if (parsed.holidayCountry) {
			mapped.push(["holiday_country", parsed.holidayCountry]);
		}
		if (parsed.printLimitDays !== null) {
			mapped.push(["print_limit_days", String(parsed.printLimitDays)]);
		}
		if (parsed.editWindowDays !== null) {
			mapped.push(["edit_window_days", String(parsed.editWindowDays)]);
		}
		if (parsed.quickRoundMinutes !== null) {
			mapped.push(["quick_round_minutes", String(parsed.quickRoundMinutes)]);
		}
		if (parsed.absenceCalcUntilToday !== null) {
			mapped.push(["absence_calc_until_today", parsed.absenceCalcUntilToday ? "1" : "0"]);
		}
		if (parsed.absenceDeductWorktime !== null) {
			mapped.push(["absence_deduct_worktime", parsed.absenceDeductWorktime ? "1" : "0"]);
		}
		for (const [key, value] of mapped) {
			ctx.deps.settings.set(key, value, ctx.actorId, ctx.now);
			ctx.stats.settings++;
		}
		if (parsed.autoPauseFromHours !== null) {
			autoPause = { fromHours: parsed.autoPauseFromHours, minutes: parsed.autoPauseDurationMinutes ?? 0 };
		}
	}

	const fromFile = pauseFile ? parsePauseRules(readText(pauseFile)) : [];
	let wanted = fromFile;
	if (fromFile.length === 0 && autoPause) {
		wanted = [derivedPauseRule(autoPause.fromHours, autoPause.minutes)];
		ctx.warnings.push("pausen.txt is empty — the automatic pause was derived from settings.txt line 22/23");
	}

	const existing = ctx.deps.rules.pauseRules(null, { includeInactive: true });
	for (const rule of wanted) {
		if (rule.pauseMinutes <= 0) {
			// the graduated file marks "no deduction" as a rule as well (`0;6;0`); without a pause there is
			// nothing to deduct, so such a row is not carried over
			ctx.warnings.push(
				`pausen.txt: the rule ${rule.fromMinutes}..${rule.toMinutes ?? "open"} deducts 0 minutes — row skipped`,
			);
			continue;
		}
		const present = existing.some(
			entry =>
				entry.userId === null &&
				entry.fromMin === rule.fromMinutes &&
				(entry.toMin ?? null) === rule.toMinutes &&
				entry.pauseMin === rule.pauseMinutes,
		);
		if (present) {
			continue;
		}
		ctx.deps.rules.savePauseRule({
			userId: null,
			fromMin: rule.fromMinutes,
			toMin: rule.toMinutes,
			pauseMin: rule.pauseMinutes,
			isActive: true,
			actorId: ctx.actorId,
			now: ctx.now,
		});
		ctx.stats.pauseRules++;
	}
}

/**
 * Imports `Data/users.txt`, `Data/group.txt` and the work profiles of `userdaten.txt`.
 *
 * The row number of `users.txt` matches the group number of `group.txt` — that is how the legacy system
 * stored the group of a user (2.9.1): group 1 becomes `admin`, every other group `employee`.
 *
 * @param ctx - run state
 * @returns the users that took part in the run
 */
function importUsers(ctx: RunContext): ImportedUser[] {
	const { layout } = ctx;
	const imported: ImportedUser[] = [];

	const parsed = layout.usersFile ? parseUsers(readText(layout.usersFile)) : { users: [], warnings: [] };
	ctx.warnings.push(...parsed.warnings);
	const rows = parsed.users;
	const groups = layout.groupFile ? parseGroups(readText(layout.groupFile)) : [];

	for (const folder of layout.users) {
		ctx.stats.userFolders++;
		const index = rows.findIndex(row => row.login.toLowerCase() === folder.login.toLowerCase());
		const row = index >= 0 ? rows[index] : null;
		if (!row) {
			ctx.warnings.push(`${folder.login}: no row in users.txt — the account is created from the folder name`);
		}
		const groupId = index >= 0 ? (groups[index]?.id ?? index + 1) : null;

		const profile = parseUserData(readText(folder.userDataFile), ctx.timezone);
		ctx.warnings.push(...profile.warnings.map(warning => `${folder.login}: ${warning}`));

		const existing = ctx.deps.users.findByLogin(folder.login);
		let user = existing;
		if (existing) {
			ctx.stats.usersExisting++;
			if (row?.legacySha1 && !existing.legacySha1) {
				// the repository has no field for the legacy hash of an existing account (2.9.1)
				ctx.warnings.push(
					`${folder.login}: the account already existed — the legacy password hash was not taken over`,
				);
			}
		} else {
			user = ctx.deps.users.create({
				login: folder.login,
				displayName: profile.displayName ?? row?.displayName ?? folder.login,
				legacySha1: row?.legacySha1 ? row.legacySha1 : null,
				email: folder.personalDataFile ? readLegacyEmail(folder.personalDataFile) : null,
				rfidCard: row?.rfidCard ?? null,
				mustChangePw: true,
				roleKeys: groupId === ADMIN_GROUP_ID ? ["admin"] : [DEFAULT_ROLE],
				actorId: ctx.actorId,
				now: ctx.now,
			});
			ctx.stats.usersCreated++;
		}
		if (!user) {
			throw new Error(`${folder.login}: the account could not be created`);
		}

		// `userdaten.txt` line 0 wins over `users.txt` column 2 when they differ (2.9.1)
		if (profile.displayName && profile.displayName !== user.displayName) {
			user = ctx.deps.users.update({
				id: user.id,
				patch: { displayName: profile.displayName },
				actorId: ctx.actorId,
				now: ctx.now,
			});
		}

		ctx.deps.users.saveWorkProfile({
			userId: user.id,
			profile: {
				percent: profile.percent ?? 100,
				weeklyHours: profile.weeklyHours ?? 42.5,
				workdays: (profile.workdays ?? [false, true, true, true, true, true, false])
					.map(flag => (flag ? "1" : "0"))
					.join(";"),
				startDate: profile.startDateUtc,
				endDate: profile.endDateUtc,
				overtimeCarryover: profile.overtimeCarryoverMinutes ?? 0,
				vorholzeitPerYear: profile.vorholzeitPerYearMinutes ?? 0,
				vacationCarryover: profile.vacationCarryoverDays ?? 0,
				vacationPerYear: profile.vacationPerYearDays ?? 0,
				overtimeModel: profile.overtimeModel ?? "monthly",
				holidayFlags: profile.holidayFlags ? JSON.stringify(profile.holidayFlags) : null,
				legacySource: folder.userDataFile,
			},
			actorId: ctx.actorId,
			now: ctx.now,
		});
		ctx.stats.workProfiles++;

		importShiftRules(ctx, user.id, profile.shiftRules);
		importLegacyBadge(ctx, user.id, folder.login, row?.rfidCard ?? null);

		imported.push({ login: folder.login, userId: user.id, folder });
	}

	return imported;
}

/**
 * Imports the surcharge windows of one work profile (2.9.2 index 9–15).
 *
 * Only enabled rules are taken over; `-1` was already turned into `null` by the parser and `100 %` into
 * `0` (no surcharge).
 *
 * @param ctx - run state
 * @param userId - owner of the rules
 * @param rules - rules of `userdaten.txt`
 */
function importShiftRules(ctx: RunContext, userId: number, rules: LegacyShiftRule[]): void {
	const existing = ctx.deps.rules.shiftRules(userId, { includeInactive: true });
	for (const rule of rules) {
		if (!rule.active) {
			continue;
		}
		const present = existing.some(
			entry =>
				entry.dayOfWeek === rule.dayOfWeek &&
				(entry.fromMin ?? null) === rule.fromMinutes &&
				(entry.toMin ?? null) === rule.toMinutes &&
				entry.surcharge === rule.surchargePercent,
		);
		if (present) {
			continue;
		}
		ctx.deps.rules.saveShiftRule({
			userId,
			dayOfWeek: rule.dayOfWeek,
			fromMin: rule.fromMinutes,
			toMin: rule.toMinutes,
			surcharge: rule.surchargePercent,
			isActive: true,
			actorId: ctx.actorId,
			now: ctx.now,
		});
		ctx.stats.shiftRules++;
	}
}

/**
 * Imports the plain text badge code of the legacy system.
 *
 * `RfidRepository` stores signed HMAC tokens and cannot express a legacy code, so the row is written
 * directly: `legacy_code` with `is_active = 0` and no `uid` (2.9.1). A compatibility mode may activate it
 * later; until then the code is documentation only and can never be verified.
 *
 * @param ctx - run state
 * @param userId - owner of the badge
 * @param login - login, used as label
 * @param code - legacy badge code, `null` when the user has none
 */
function importLegacyBadge(ctx: RunContext, userId: number, login: string, code: string | null): void {
	if (!code) {
		return;
	}
	const present = ctx.deps.db.prepare("SELECT id FROM rfid_tags WHERE legacy_code = ?").get(code) as
		{ id: number } | undefined;
	if (present) {
		return;
	}
	ctx.deps.db
		.prepare(
			`INSERT INTO rfid_tags (uid, token_hash, legacy_code, user_id, label, is_active, created_at)
			 VALUES (NULL, '', ?, ?, ?, 0, ?)`,
		)
		.run(code, userId, `legacy ${login}`, ctx.now);
	ctx.stats.rfidTags++;
}

/**
 * Imports the per user absence types of `absenz.txt` and the absences of `Timetable/A<year>`.
 *
 * `reduce_vacation` does not exist in the legacy data, so it follows the documented rule: `F` → 1, every
 * other code → 0 (2.9.3). Absences become `status = 'taken'` (2.9.6); field 1 of the file is read as the
 * day of the year, which is the only interpretation that can address a whole year.
 *
 * @param ctx - run state
 * @param users - users that took part in the run
 */
function importAbsences(ctx: RunContext, users: ImportedUser[]): void {
	for (const user of users) {
		const { folder } = user;

		if (folder.absenceTypeFile) {
			const types = parseAbsenceTypes(readText(folder.absenceTypeFile));
			const global = ctx.deps.absences.types();
			const sameAsGlobal =
				types.length > 0 &&
				types.every(type =>
					global.some(
						entry => entry.code === type.code && entry.name === type.name && entry.factor === type.factor,
					),
				);
			if (sameAsGlobal) {
				ctx.warnings.push(
					`${user.login}: absen.txt matches the built-in types — identical per user types were not duplicated (2.9.3)`,
				);
			} else {
				for (const type of types) {
					ctx.deps.absences.upsertType({
						userId: user.userId,
						code: type.code,
						name: type.name,
						factor: type.factor,
						reduceVacation: type.code === "F",
						actorId: ctx.actorId,
						now: ctx.now,
					});
					ctx.stats.absenceTypes++;
				}
			}
		}

		for (const file of folder.absenceFiles) {
			const parsed = parseAbsences(readText(file.path));
			ctx.warnings.push(...parsed.warnings.map(warning => `${user.login}: ${warning}`));
			if (parsed.absences.length > 0) {
				ctx.warnings.push(
					`${user.login}: A${file.year}: field 1 is read as the day of the year (1..366) — please verify`,
				);
			}
			const existing = ctx.deps.absences.listByUser(user.userId, { year: file.year });

			for (const absence of parsed.absences) {
				const date = dateFromDayOfYear(file.year, absence.day);
				const type = ctx.deps.absences.findType(absence.code, user.userId);
				if (!type) {
					ctx.warnings.push(`${user.login}: ${date}: unknown absence code "${absence.code}" — row skipped`);
					continue;
				}
				const present = existing.some(
					entry =>
						entry.dateFrom === date &&
						entry.dateTo === date &&
						entry.typeId === type.id &&
						entry.dayPortion === absence.days,
				);
				if (present) {
					ctx.stats.absencesSkipped++;
					continue;
				}
				ctx.deps.absences.create({
					userId: user.userId,
					typeId: type.id,
					dateFrom: date,
					dateTo: date,
					dayPortion: absence.days,
					status: "taken",
					actorId: ctx.actorId,
					now: ctx.now,
				});
				ctx.stats.absences++;
			}
		}
	}
}

/**
 * Imports the punch instants of `Timetable/<year>.<month>` (2.9.4).
 *
 * The file holds UTC instants (`time()` in PHP), so they are stored unchanged; the time zone only decides
 * which local date a punch belongs to. The idempotency key `import:<user id>:<epoch>` makes a second run a
 * no-op, `created_by` stays `NULL` because the import is a system actor.
 *
 * @param ctx - run state
 * @param users - users that took part in the run
 */
function importEntries(ctx: RunContext, users: ImportedUser[]): void {
	for (const user of users) {
		for (const file of user.folder.punchFiles) {
			for (const epoch of parseMonthPunches(readText(file.path))) {
				const result = ctx.deps.entries.insert({
					userId: user.userId,
					tsUtc: epoch,
					timeZone: ctx.timezone,
					source: "import",
					direction: "auto",
					idempotencyKey: `import:${user.userId}:${epoch}`,
					syncState: "synced",
					actorId: null,
					now: ctx.now,
				});
				if (result.created) {
					ctx.stats.entries++;
				} else {
					ctx.stats.entriesSkipped++;
				}
			}
		}
	}
}

/** Note the imported payouts carry (2.9.7). */
const PAYOUT_NOTE = "smalltime-import";

/**
 * Imports `Timetable/auszahlungen` into `payouts` and keeps the control values of `total.txt` in the report.
 *
 * The control values are deliberately **not** written into a business table (2.9.7).
 *
 * @param ctx - run state
 * @param users - users that took part in the run
 */
function importPayouts(ctx: RunContext, users: ImportedUser[]): void {
	for (const user of users) {
		const { folder } = user;

		if (folder.payoutFile) {
			for (const payout of parsePayouts(readText(folder.payoutFile))) {
				const existing = ctx.deps.payouts.list(user.userId, { year: payout.year });
				if (existing.some(entry => entry.month === payout.month && entry.note === PAYOUT_NOTE)) {
					continue;
				}
				ctx.deps.payouts.create({
					userId: user.userId,
					year: payout.year,
					month: payout.month,
					minutes: Math.round(payout.hours * 60),
					amount: null,
					note: PAYOUT_NOTE,
					actorId: ctx.actorId,
					now: ctx.now,
				});
				ctx.stats.payouts++;
			}
		}

		if (folder.totalsFile) {
			const totals = parseTotals(readText(folder.totalsFile));
			ctx.stats.totalBalanceHours = totals.totalBalanceHours;
			ctx.stats.totalSecondValue = totals.secondValue;
		}
	}
}

/**
 * Recomputes the aggregates from the imported raw data and compares them with the legacy monthly values.
 *
 * The whole calendar year is recalculated (not only the months with punches), because the golden file has
 * twelve rows and a month without punches still has target time. Legacy aggregates are never taken over
 * (2.9.10 step 3). A month that deviates by more than `GOLDEN_TOLERANCE_MINUTES` from `Timetable/<year>`
 * makes the run end with `mismatch` (2.9.5).
 *
 * @param ctx - run state
 * @param users - users that took part in the run
 */
function recomputeAndCompare(ctx: RunContext, users: ImportedUser[]): void {
	for (const user of users) {
		const years = new Set<number>();
		for (const file of user.folder.punchFiles) {
			years.add(file.year);
		}
		for (const file of user.folder.goldenFiles) {
			years.add(file.year);
		}
		for (const file of user.folder.absenceFiles) {
			years.add(file.year);
		}

		for (const year of [...years].sort((a, b) => a - b)) {
			const options = { includeFuture: true, now: ctx.now };
			ctx.deps.aggregation.recalculateRange(user.userId, `${year}-01-01`, `${year}-12-31`, options);
			for (let month = 1; month <= 12; month++) {
				ctx.deps.aggregation.recalculateMonth(user.userId, year, month, options);
			}
			ctx.deps.aggregation.recalculateYear(user.userId, year, { ...options, settled: false });
		}

		for (const file of user.folder.goldenFiles) {
			for (const target of parseYearTargets(readText(file.path))) {
				const computed = ctx.deps.aggregation.month(user.userId, file.year, target.month);
				ctx.stats.goldenMonths++;
				if (!computed) {
					ctx.warnings.push(
						`${user.login}: no monthly aggregate for ${file.year}-${target.month} — golden check skipped`,
					);
					continue;
				}
				const expectedBalanceMin = Math.round(target.balanceHours * 60);
				const expectedTargetMin = Math.round(target.targetHours * 60);
				const deviates =
					Math.abs(computed.balanceMin - expectedBalanceMin) > GOLDEN_TOLERANCE_MINUTES ||
					Math.abs(computed.targetMin - expectedTargetMin) > GOLDEN_TOLERANCE_MINUTES;
				if (!deviates) {
					continue;
				}
				ctx.deviations.push({
					login: user.login,
					year: file.year,
					month: target.month,
					expectedBalanceMin,
					actualBalanceMin: computed.balanceMin,
					expectedTargetMin,
					actualTargetMin: computed.targetMin,
				});
			}
		}
	}

	ctx.stats.goldenDeviations = ctx.deviations.length;
}

/** Marker thrown inside the transaction of a `dry-run` to roll it back. */
const DRY_RUN_ROLLBACK = new Error("dry-run: transaction rolled back on purpose");

/**
 * Runs one legacy import.
 *
 * The `import_runs` row is written first, then everything happens in **one** transaction. A `dry-run` rolls
 * that transaction back on purpose, so only the report survives — including the counters, the remarks and
 * the golden deviations, which makes it possible to check an import before it writes anything.
 *
 * @param deps - data sources
 * @param options - import options (`baseDir` and `actorId` are required)
 * @returns the report of the run
 * @throws {Error} when the import fails; the `import_runs` row is then marked `failed` before the error is rethrown
 */
export function runLegacyImport(deps: LegacyImportDeps, options: LegacyImportOptions): LegacyImportReport {
	const mode: LegacyImportMode = options.mode ?? "dry-run";
	const timezone = options.timezone ?? LEGACY_DEFAULT_TIMEZONE;
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const layout = detectLegacyLayout(options.baseDir);
	const ctx: RunContext = {
		deps,
		layout,
		actorId: options.actorId,
		now,
		timezone,
		dryRun: mode === "dry-run",
		stats: emptyStats(),
		warnings: [...layout.warnings],
		deviations: [],
	};
	const log = options.log ?? ((): void => undefined);
	const runId = insertRunRow(ctx, mode);
	let status: LegacyImportStatus = "failed";

	try {
		if (layout.users.length === 0) {
			throw new Error(`no SMALL-Time data found below ${options.baseDir}`);
		}
		assertDatabaseWritable(ctx, options.resetImport === true);

		const work = (): void => {
			importSettings(ctx);
			const users = importUsers(ctx);
			importAbsences(ctx, users);
			importEntries(ctx, users);
			importPayouts(ctx, users);
			for (const user of users) {
				ctx.stats.skippedFiles += user.folder.skippedFiles.length;
			}
			recomputeAndCompare(ctx, users);
		};

		const transaction = deps.db.transaction((): void => {
			work();
			if (ctx.dryRun) {
				throw DRY_RUN_ROLLBACK;
			}
		});
		try {
			transaction();
		} catch (error) {
			if (error !== DRY_RUN_ROLLBACK) {
				throw error;
			}
			log("dry-run: all writes were rolled back, only the import_runs report remains");
		}

		status = ctx.deviations.length > 0 ? "mismatch" : ctx.warnings.length > 0 ? "warnings" : "ok";
	} catch (error) {
		ctx.warnings.push(error instanceof Error ? error.message : String(error));
		finishRunRow(ctx, runId, "failed", Math.floor(Date.now() / 1000));
		throw error;
	}

	finishRunRow(ctx, runId, status, Math.floor(Date.now() / 1000));
	log(
		`legacy import ${mode} finished with status ${status}: ${ctx.stats.usersCreated} user(s) created, ` +
			`${ctx.stats.entries} punch(es), ${ctx.stats.absences} absence(s), ${ctx.stats.goldenDeviations} golden deviation(s)`,
	);

	return {
		runId,
		mode,
		status,
		baseDir: options.baseDir,
		timezoneAssumed: timezone,
		stats: ctx.stats,
		warnings: ctx.warnings,
		deviations: ctx.deviations,
	};
}
