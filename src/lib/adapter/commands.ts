/**
 * Command states of the adapter.
 *
 * The adapter reacts to the states below, so a script, a dashboard or another adapter can punch, close a month
 * or trigger a recalculation without the REST API. Commands are triggered from inside ioBroker, not from a
 * browser, so no session is involved; the audit trail records them with `actorId: 0` (system).
 */

import type { Db } from "../db/database";
import type { EntriesRepository } from "../db/repositories/entries";
import type { SettingsRepository } from "../db/repositories/settings";
import type { UsersRepository } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import type { ClosingService } from "../services/closing";
import { ValidationError } from "../errors";
import { buildDayPunches, nextDirection, roundToStep, type PunchEntry } from "../domain/punch";
import { localDate as resolveLocalDate } from "../util/time";
import { COMMAND_IDS } from "./states";

/** Data sources of the command handler. */
export interface CommandDeps {
	/** Open database handle */
	db: Db;
	/** Punch storage */
	entries: EntriesRepository;
	/** User storage */
	users: UsersRepository;
	/** Instance settings (quick rounding, target employee) */
	settings: SettingsRepository;
	/** Aggregation service */
	aggregation: Pick<AggregationService, "recalculateDay" | "recalculateMonth" | "recalculateYear">;
	/** Closing service (month close) */
	closing: Pick<ClosingService, "closeMonth">;
	/** Instant source, defaults to the system clock */
	now?: () => number;
}

/** Result of a command. */
export interface CommandResult {
	/** True when the command was executed */
	ok: boolean;
	/** Human readable summary for the log */
	message: string;
	/** Local dates that were recalculated */
	recalculated: string[];
}

/** A period taken from a command value. */
interface Period {
	/** Four digit year */
	year: number;
	/** Month (1 to 12) or `null` for a whole year */
	month: number | null;
}

/**
 * Parses a period string.
 *
 * @param value - `YYYY-MM` or `YYYY`
 * @returns the parsed period
 */
function parsePeriod(value: string): Period {
	const monthMatch = /^(\d{4})-(\d{1,2})$/.exec(value.trim());
	if (monthMatch) {
		const month = Number(monthMatch[2]);
		if (month < 1 || month > 12) {
			throw new ValidationError(`month must be between 1 and 12 (got ${value})`);
		}
		return { year: Number(monthMatch[1]), month };
	}

	const yearMatch = /^(\d{4})$/.exec(value.trim());
	if (yearMatch) {
		return { year: Number(yearMatch[1]), month: null };
	}
	throw new ValidationError(`expected YYYY-MM or YYYY (got "${value}")`);
}

/**
 * Resolves the employee a command applies to: the only one, or the configured one.
 *
 * @param deps - data sources
 * @returns the employee
 */
function targetUser(deps: CommandDeps): { id: number; displayName: string; timezone: string } {
	const configured = Number(deps.settings.get("command_punch_user_id") ?? Number.NaN);
	const explicit = Number.isInteger(configured) ? deps.users.findById(configured) : null;
	if (explicit) {
		return explicit;
	}

	const candidates = deps.users.list();
	if (candidates.length === 1) {
		return candidates[0];
	}
	if (candidates.length === 0) {
		throw new ValidationError("no employee exists yet");
	}
	throw new ValidationError("several employees exist - set command_punch_user_id or write users.<id> commands");
}

/**
 * Handles a command state.
 *
 * @param deps - data sources
 * @param id - state id that was written (without the instance prefix)
 * @param value - value that was written
 * @returns result of the command
 */
export function handleCommand(deps: CommandDeps, id: string, value: ioBroker.StateValue): CommandResult {
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const timestamp = now();

	if (id === COMMAND_IDS.closeMonth || id === COMMAND_IDS.recalc) {
		const period = parsePeriod(String(value ?? ""));
		const target = targetUser(deps);

		if (id === COMMAND_IDS.recalc) {
			if (period.month === null) {
				deps.aggregation.recalculateYear(target.id, period.year, { now: timestamp });
				return { ok: true, message: `year ${period.year} recalculated`, recalculated: [] };
			}
			deps.aggregation.recalculateMonth(target.id, period.year, period.month, { now: timestamp });
			return {
				ok: true,
				message: `month ${period.year}-${String(period.month).padStart(2, "0")} recalculated`,
				recalculated: [],
			};
		}

		if (period.month === null) {
			throw new ValidationError("closing a month needs YYYY-MM");
		}
		const closed = deps.closing.closeMonth({
			userId: target.id,
			year: period.year,
			month: period.month,
			actorId: 0,
			now: timestamp,
		});
		return {
			ok: true,
			message: `month ${period.year}-${String(period.month).padStart(2, "0")} closed for ${target.displayName} (balance ${closed.month.balanceMin} min, overtime ${closed.month.overtimeMin} min)`,
			recalculated: [],
		};
	}

	if (id === COMMAND_IDS.punch || id === COMMAND_IDS.quickPunch) {
		if (value !== true) {
			// buttons only act on `true`
			return { ok: false, message: "ignored (buttons act on true)", recalculated: [] };
		}

		const target = targetUser(deps);
		const quickRound = id === COMMAND_IDS.quickPunch ? deps.settings.getNumber("quick_round_minutes", 0) : 0;
		const tsUtc = quickRound > 0 ? roundToStep(timestamp, quickRound, target.timezone) : timestamp;
		const today = resolveLocalDate(tsUtc, target.timezone);

		const existing: PunchEntry[] = deps.entries
			.listByDate(target.id, today)
			.map(entry => ({ id: entry.id, tsUtc: entry.tsUtc, syncState: entry.syncState }));
		const direction = nextDirection(buildDayPunches(existing));

		const stored = deps.entries.insert({
			userId: target.id,
			tsUtc,
			timeZone: target.timezone,
			source: "api",
			direction,
			note: "command.punch",
			now: timestamp,
		});
		const day = deps.aggregation.recalculateDay(target.id, stored.entry.localDate, { now: timestamp });

		return {
			ok: true,
			message: `${target.displayName} punched ${direction} (${day.workedMin} min today, open: ${day.hasOpenEntry})`,
			recalculated: [stored.entry.localDate],
		};
	}

	throw new ValidationError(`unknown command state ${id}`);
}
