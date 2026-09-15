/**
 * Presence state of an employee (`users.<userId>.present`).
 *
 * `present` is the writable twin of `users.<userId>.hasOpenEntry`: writing `true` opens an entry — paid working
 * time starts — and writing `false` closes it. A fingerprint reader, an RFID bridge, a dashboard or a plain script
 * can therefore tell the adapter that somebody arrived or left, without speaking to the REST API.
 *
 * The write is idempotent: `true` while the day is already open does not create a second punch, so a reader that
 * fires twice is harmless. Punches written this way are recorded like any other one (`source: "api"`, note
 * `state.present`), so they appear in the entry list and in the audit trail, just like `commands.*`.
 */

import type { EntriesRepository } from "../db/repositories/entries";
import type { UsersRepository } from "../db/repositories/users";
import type { AggregationService } from "../services/aggregation";
import { buildDayPunches, nextDirection, type PunchEntry } from "../domain/punch";
import { localDate as resolveLocalDate } from "../util/time";

/** Suffix of the writable presence state. */
export const PRESENCE_SUFFIX = "present";

/** Data sources of the presence handler. */
export interface PresenceDeps {
	/** Punch storage */
	entries: EntriesRepository;
	/** User storage */
	users: UsersRepository;
	/** Aggregation service */
	aggregation: Pick<AggregationService, "recalculateDay">;
	/** Instant source, defaults to the system clock */
	now?: () => number;
}

/** Result of a write on a presence state. */
export interface PresenceResult {
	/** True when the write was understood, even when nothing changed */
	ok: boolean;
	/** Human readable summary for the log */
	message: string;
	/** Employee the write was meant for, `null` when the id was not a presence state */
	userId: number | null;
	/** Whether the employee is present after the write */
	present: boolean;
	/** True when a punch was written */
	changed: boolean;
	/** Local date the punch belongs to */
	localDate?: string;
}

/**
 * Reads the employee id from a presence state id.
 *
 * @param localId - state id without the instance prefix
 * @returns the employee id, or `null` when the id is not a presence state
 */
export function parsePresenceStateId(localId: string): number | null {
	const match = /^users\.(\d+)\.present$/.exec(localId.trim());
	return match ? Number(match[1]) : null;
}

/**
 * Reads a boolean from a written state value.
 *
 * Dashboards and script adapters deliver `true`, `"true"`, `1` or `"1"` — and the opposites.
 *
 * @param value - value that was written
 * @returns the boolean, or `null` when the value is not boolean-like
 */
export function readPresenceValue(value: ioBroker.StateValue): boolean | null {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value === 1 ? true : value === 0 ? false : null;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1" || normalized === "on") {
			return true;
		}
		if (normalized === "false" || normalized === "0" || normalized === "off" || normalized === "") {
			return false;
		}
	}
	return null;
}

/**
 * Applies a write on `users.<id>.present`.
 *
 * @param deps - data sources
 * @param localId - state id without the instance prefix
 * @param value - value that was written
 * @returns what happened, so the caller can log it and republish the figures
 */
export function handlePresenceState(deps: PresenceDeps, localId: string, value: ioBroker.StateValue): PresenceResult {
	const userId = parsePresenceStateId(localId);
	if (userId === null) {
		return {
			ok: false,
			message: `"${localId}" is not a presence state`,
			userId: null,
			present: false,
			changed: false,
		};
	}

	const desired = readPresenceValue(value);
	if (desired === null) {
		return {
			ok: false,
			message: `write true or false (got ${JSON.stringify(value)})`,
			userId,
			present: false,
			changed: false,
		};
	}

	const user = deps.users.findById(userId);
	if (!user) {
		return { ok: false, message: `employee ${userId} does not exist`, userId, present: false, changed: false };
	}
	if (!user.isActive) {
		return {
			ok: false,
			message: `${user.displayName} is deactivated, no punch was written`,
			userId,
			present: false,
			changed: false,
		};
	}

	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const timestamp = now();
	const today = resolveLocalDate(timestamp, user.timezone);
	const existing: PunchEntry[] = deps.entries
		.listByDate(user.id, today)
		.map(entry => ({ id: entry.id, tsUtc: entry.tsUtc, syncState: entry.syncState }));
	const present = nextDirection(buildDayPunches(existing)) === "out";

	if (present === desired) {
		// the reader fired twice, the dashboard was refreshed or a script repeats itself: nothing to store
		return {
			ok: true,
			message: `${user.displayName} is already ${desired ? "present" : "absent"} (no punch written)`,
			userId: user.id,
			present: desired,
			changed: false,
			localDate: today,
		};
	}

	const direction = desired ? "in" : "out";
	const stored = deps.entries.insert({
		userId: user.id,
		tsUtc: timestamp,
		timeZone: user.timezone,
		source: "api",
		direction,
		note: "state.present",
		now: timestamp,
	});
	const day = deps.aggregation.recalculateDay(user.id, stored.entry.localDate, { now: timestamp });

	return {
		ok: true,
		message: `${user.displayName} punched ${direction} from the presence state (${day.workedMin} min today, present: ${day.hasOpenEntry})`,
		userId: user.id,
		present: day.hasOpenEntry,
		changed: true,
		localDate: stored.entry.localDate,
	};
}
