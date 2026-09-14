/**
 * Instance settings (`app_settings`), stored as key/value pairs.
 *
 * Seeds provide the defaults; this repository never overwrites a value that an administrator changed.
 */

import type { Db } from "../database";
import { writeAuditLog } from "./audit";

/** Value that can be stored: strings are kept verbatim, everything else is JSON serialised. */
export type SettingValue = string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };

/** Typed access to the instance settings. */
export interface SettingsRepository {
	/** All settings as string map */
	all(): Record<string, string>;
	/** Raw string value or `null` */
	get(key: string): string | null;
	/** Number value with fallback when missing or not numeric */
	getNumber(key: string, fallback: number): number;
	/** Boolean value (`1`/`true`/`yes` are true) with fallback */
	getBoolean(key: string, fallback: boolean): boolean;
	/** JSON value with fallback when missing or invalid */
	getJson<T>(key: string, fallback: T): T;
	/** Stores a value (strings as-is, everything else JSON encoded) */
	set(key: string, value: SettingValue, actorId?: number | null, now?: number): void;
}

/**
 * Creates the settings repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createSettingsRepository(db: Db): SettingsRepository {
	const selectValue = db.prepare("SELECT value FROM app_settings WHERE key = ?");
	const selectAll = db.prepare("SELECT key, value FROM app_settings");
	const upsert = db.prepare(
		`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	);

	const read = (key: string): string | null => {
		const row = selectValue.get(key) as { value: string } | undefined;
		return row ? row.value : null;
	};

	return {
		all(): Record<string, string> {
			const rows = selectAll.all() as { key: string; value: string }[];
			return Object.fromEntries(rows.map(row => [row.key, row.value]));
		},

		get: read,

		getNumber(key: string, fallback: number): number {
			const raw = read(key);
			if (raw === null) {
				return fallback;
			}
			const parsed = Number(raw);
			return Number.isFinite(parsed) ? parsed : fallback;
		},

		getBoolean(key: string, fallback: boolean): boolean {
			const raw = read(key);
			if (raw === null) {
				return fallback;
			}
			return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
		},

		getJson<T>(key: string, fallback: T): T {
			const raw = read(key);
			if (raw === null) {
				return fallback;
			}
			try {
				return JSON.parse(raw) as T;
			} catch {
				return fallback;
			}
		},

		set(key: string, value: SettingValue, actorId: number | null = null, now?: number): void {
			const previous = read(key);
			const serialised = typeof value === "string" ? value : JSON.stringify(value);
			const atUtc = now ?? Math.floor(Date.now() / 1000);

			const run = db.transaction((): void => {
				upsert.run(key, serialised, atUtc);
				writeAuditLog(db, {
					atUtc,
					actorId,
					action: "settings.set",
					entity: "app_settings",
					entityId: key,
					detail: { old: previous, new: serialised },
				});
			});
			run();
		},
	};
}
