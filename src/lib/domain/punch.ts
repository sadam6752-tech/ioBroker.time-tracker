/**
 * Punch (clock-in/out) logic: pairing, duplicate protection, employment window and quick rounding.
 *
 * Source of truth is the order of the punches by `(ts_utc, id)`; the stored `direction` is only a UI hint.
 * Punches that are not yet synchronised (`pending`) or flagged as conflict do not count.
 */

import { DateTime } from "luxon";
import { utcToWallTime, wallTimeToUtc } from "../util/time";

const UTC = "utc";

/** Minimal punch information needed for pairing. */
export interface PunchEntry {
	/** Database id (used as tie breaker for identical timestamps) */
	id: number;
	/** Punch instant, UTC epoch seconds */
	tsUtc: number;
	/** Synchronisation state; `pending` and `conflict` punches are ignored */
	syncState?: "synced" | "pending" | "conflict";
}

/** A pair of punches; `outEntry` is `null` while the punch is still open. */
export interface PunchPair {
	/** First punch of the pair (clock in) */
	inEntry: PunchEntry;
	/** Second punch of the pair (clock out), `null` while the punch is open */
	outEntry: PunchEntry | null;
	/** Duration of the pair in minutes (0 for an open pair) */
	minutes: number;
}

/** Result of pairing all punches of one day. */
export interface DayPunches {
	/** All pairs of the day in chronological order */
	pairs: PunchPair[];
	/** True when the last punch has no counterpart yet */
	hasOpenEntry: boolean;
	/** Timestamp of the first punch of the day */
	firstInUtc: number | null;
	/** Timestamp of the last completed clock-out, `null` while a punch is open */
	lastOutUtc: number | null;
	/** Sum of all complete pairs in minutes */
	workedMinutes: number;
}

/** Options for pairing. */
export interface PairingOptions {
	/** Punches closer than this to the previous kept punch are ignored (default 30 seconds) */
	minDistanceSeconds?: number;
}

/** Errors of the employment window. */
export type EmploymentError = "before_start_date" | "after_end_date";

/**
 * Pairs the punches of one day (ascending by `ts_utc`, then `id`).
 *
 * @param entries - punches of a single local day
 * @param options - pairing options
 * @returns pairs, open state and worked minutes
 */
export function buildDayPunches(entries: PunchEntry[], options: PairingOptions = {}): DayPunches {
	const minDistance = options.minDistanceSeconds ?? 30;

	const usable = entries
		.filter(entry => (entry.syncState ?? "synced") === "synced")
		.slice()
		.sort((a, b) => a.tsUtc - b.tsUtc || a.id - b.id);

	const kept: PunchEntry[] = [];
	for (const entry of usable) {
		const previous = kept[kept.length - 1];
		if (previous && entry.tsUtc - previous.tsUtc < minDistance) {
			// duplicate protection: keep the first punch, drop the immediate repetition
			continue;
		}
		kept.push(entry);
	}

	const pairs: PunchPair[] = [];
	let totalSeconds = 0;
	for (let index = 0; index < kept.length; index += 2) {
		const inEntry = kept[index];
		const outEntry = kept[index + 1] ?? null;
		const seconds = outEntry ? Math.max(0, outEntry.tsUtc - inEntry.tsUtc) : 0;
		totalSeconds += seconds;
		pairs.push({ inEntry, outEntry, minutes: Math.round(seconds / 60) });
	}

	return {
		pairs,
		hasOpenEntry: kept.length % 2 === 1,
		firstInUtc: kept.length > 0 ? kept[0].tsUtc : null,
		lastOutUtc: kept.length > 0 && kept.length % 2 === 0 ? kept[kept.length - 1].tsUtc : null,
		workedMinutes: Math.round(totalSeconds / 60),
	};
}

/**
 * Direction the next punch would have (“out” while a punch is open, otherwise “in”).
 *
 * @param day - result of `buildDayPunches`
 * @returns expected direction
 */
export function nextDirection(day: DayPunches): "in" | "out" {
	return day.hasOpenEntry ? "out" : "in";
}

/**
 * Checks whether a punch lies inside the employment window (`start_date`/`end_date`).
 *
 * @param tsUtc - punch instant, UTC epoch seconds
 * @param window - employment window (either bound may be missing)
 * @param window.startDate - first day the employee may punch (optional)
 * @param window.endDate - last day the employee may punch (optional)
 * @returns the violated bound or `null` when the punch is allowed
 */
export function checkEmploymentWindow(
	tsUtc: number,
	window: { startDate?: number | null; endDate?: number | null },
): EmploymentError | null {
	if (window.startDate != null && tsUtc < window.startDate) {
		return "before_start_date";
	}
	if (window.endDate != null && tsUtc > window.endDate) {
		return "after_end_date";
	}
	return null;
}

/**
 * Rounds an instant to the nearest multiple of a step, based on the local wall clock time.
 *
 * @param tsUtc - instant to round, UTC epoch seconds
 * @param stepMinutes - step in minutes (`0` disables rounding)
 * @param timeZone - time zone used for the wall clock
 * @returns rounded instant, UTC epoch seconds
 */
export function roundToStep(tsUtc: number, stepMinutes: number, timeZone: string): number {
	if (stepMinutes <= 0) {
		return tsUtc;
	}

	const stepSeconds = stepMinutes * 60;
	const local = DateTime.fromSeconds(tsUtc, { zone: UTC }).setZone(timeZone);
	const secondsOfDay = local.hour * 3600 + local.minute * 60 + local.second;
	const roundedSecondsOfDay = Math.round(secondsOfDay / stepSeconds) * stepSeconds;

	const wallSeconds = utcToWallTime(tsUtc, timeZone);
	const roundedWallSeconds = wallSeconds - secondsOfDay + roundedSecondsOfDay;
	return wallTimeToUtc(roundedWallSeconds, timeZone).tsUtc;
}
