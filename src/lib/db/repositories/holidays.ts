/**
 * Holiday repository (`holidays`).
 *
 * Holidays are stored per region, the region is the country code of the instance (`CH`, `DE`, `AT`).
 * `ensureYear` generates the holidays of a country idempotently and never touches edited rows, so
 * administrators can rename or delete single days.
 */

import type { Db } from "../database";
import { holidaysForYear, type HolidayCountry } from "../../domain/holidays";
import { isDateString } from "../../util/time";
import { ValidationError } from "../../errors";
import { writeAuditLog } from "./audit";

/** A public holiday as stored in the database. */
export interface HolidayRecord {
	/** Primary key */
	id: number;
	/** Region (country code) the holiday belongs to */
	region: string;
	/** Year of the holiday (derived from `date`) */
	year: number;
	/** Local date, `YYYY-MM-DD` */
	date: string;
	/** Display name */
	name: string;
	/** Key of a seeded holiday (`null` for one that was added by hand) */
	key: string | null;
}

/** Holiday storage operations. */
export interface HolidaysRepository {
	/** Holidays of one year, sorted by date */
	listByYear(year: number, region?: string): HolidayRecord[];
	/** Years for which holidays are stored */
	years(): number[];
	/** True when the date is a holiday of the region */
	isHoliday(date: string, region?: string): boolean;
	/** All holiday dates of a year as a set (input for the calculation service) */
	dateSet(year: number, region?: string): Set<string>;
	/** Generates the missing holidays of a country for one year */
	ensureYear(input: { year: number; country: HolidayCountry; actorId?: number | null; now?: number }): {
		year: number;
		inserted: number;
	};
	/** Adds a holiday; an existing date of the region is renamed */
	add(input: {
		date: string;
		name: string;
		region?: string;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): HolidayRecord;
	/** Deletes a holiday by id */
	remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
}

interface HolidayRow {
	id: number;
	region: string;
	year: number;
	date: string;
	name: string;
	key: string | null;
}

/** Default region used when the caller does not pass one. */
const DEFAULT_REGION = "DE";

const COLUMNS = "id, region, year, date, name, key";

/**
 * Checks and normalises a holiday date.
 *
 * @param date - date to validate
 * @returns the validated date
 */
function requireDate(date: string): string {
	const trimmed = date.trim();
	if (!isDateString(trimmed)) {
		throw new ValidationError(`invalid date "${date}", expected YYYY-MM-DD`);
	}
	return trimmed;
}

/**
 * Creates the holiday repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createHolidaysRepository(db: Db): HolidaysRepository {
	const selectByYear = db.prepare(`SELECT ${COLUMNS} FROM holidays WHERE year = ? AND region = ? ORDER BY date`);
	const selectByDate = db.prepare(`SELECT ${COLUMNS} FROM holidays WHERE date = ? AND region = ?`);
	const selectYears = db.prepare("SELECT DISTINCT year FROM holidays ORDER BY year");
	const selectById = db.prepare(`SELECT ${COLUMNS} FROM holidays WHERE id = ?`);
	const insertHoliday = db.prepare(
		`INSERT INTO holidays (region, year, date, name, key) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(region, date) DO UPDATE SET name = excluded.name, year = excluded.year, key = excluded.key`,
	);
	const deleteHoliday = db.prepare("DELETE FROM holidays WHERE id = ?");

	const read = (id: number): HolidayRecord | null => {
		const row = selectById.get(id) as HolidayRow | undefined;
		return row ?? null;
	};

	return {
		listByYear(year: number, region: string = DEFAULT_REGION): HolidayRecord[] {
			return selectByYear.all(year, region) as HolidayRecord[];
		},

		years(): number[] {
			return (selectYears.all() as { year: number }[]).map(row => row.year);
		},

		isHoliday(date: string, region: string = DEFAULT_REGION): boolean {
			return selectByDate.get(date, region) !== undefined;
		},

		dateSet(year: number, region: string = DEFAULT_REGION): Set<string> {
			const rows = selectByYear.all(year, region) as HolidayRow[];
			return new Set(rows.map(row => row.date));
		},

		ensureYear(input: { year: number; country: HolidayCountry; actorId?: number | null; now?: number }): {
			year: number;
			inserted: number;
		} {
			const now = input.now ?? Math.floor(Date.now() / 1000);
			let inserted = 0;

			const run = db.transaction((): void => {
				const insertMissing = db.prepare(
					"INSERT OR IGNORE INTO holidays (region, year, date, name, key) VALUES (?, ?, ?, ?, ?)",
				);
				for (const holiday of holidaysForYear(input.year, input.country)) {
					inserted += insertMissing.run(
						input.country,
						input.year,
						holiday.date,
						holiday.name,
						holiday.key,
					).changes;
				}
			});
			run();

			if (inserted > 0) {
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId ?? null,
					action: "holiday.ensure",
					entity: "holiday",
					entityId: input.year,
					detail: { year: input.year, country: input.country, inserted },
				});
			}
			return { year: input.year, inserted };
		},

		add(input: {
			date: string;
			name: string;
			region?: string;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): HolidayRecord {
			const date = requireDate(input.date);
			const name = input.name.trim();
			if (!name) {
				throw new ValidationError("name must not be empty");
			}
			const region = input.region ?? DEFAULT_REGION;
			const year = Number(date.slice(0, 4));
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const existing = selectByDate.get(date, region) as HolidayRow | undefined;

			const run = db.transaction((): void => {
				// a day somebody adds by hand has no key: it keeps the name it was given
				insertHoliday.run(region, year, date, name, null);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: existing ? "holiday.update" : "holiday.create",
					entity: "holiday",
					entityId: date,
					detail: existing
						? { changes: { name: { old: existing.name, new: name } } }
						: { date, name, region },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const saved = selectByDate.get(date, region) as HolidayRow | undefined;
			if (!saved) {
				throw new Error(`holiday ${date} disappeared right after the write`);
			}
			return saved;
		},

		remove(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const existing = read(input.id);
			if (!existing) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);

			const run = db.transaction((): void => {
				deleteHoliday.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "holiday.delete",
					entity: "holiday",
					entityId: existing.date,
					detail: { region: existing.region, name: existing.name },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},
	};
}
