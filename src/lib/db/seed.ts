/**
 * Initial data (seeds): roles, permission catalogue, absence types, instance settings and holidays.
 *
 * All seed operations are idempotent (`INSERT OR IGNORE`), so `seed()` can run on every adapter start.
 */

import type { Db } from "./database";
import { holidaysForYear, type HolidayCountry } from "../domain/holidays";

/** Permission catalogue (keys are stored in `permissions.key`). */
export const PERMISSIONS = {
	time: ["time.punch", "time.edit_own", "time.edit_other", "time.delete", "time.import", "time.resolve_conflict"],
	absence: ["absence.request", "absence.approve", "absence.edit_other", "absence.manage_types"],
	user: ["user.view", "user.create", "user.edit", "user.deactivate", "user.manage_roles"],
	report: ["report.view_own", "report.view_other", "report.export", "report.statistics", "report.print_locked"],
	payout: ["payout.view", "payout.create"],
	system: [
		"settings.view",
		"settings.edit",
		"rfid.manage",
		"terminal.manage",
		"holiday.manage",
		"import.run",
		"audit.view",
		"backup.run",
	],
	command: ["command.punch", "command.close_month", "command.recalc"],
} as const;

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSIONS).flat();

/** Role → permissions (specification section 4.8). */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
	admin: ALL_PERMISSIONS,
	manager: [
		"time.punch",
		"time.edit_own",
		"time.edit_other",
		"time.delete",
		"time.resolve_conflict",
		"absence.request",
		"absence.approve",
		"absence.edit_other",
		"absence.manage_types",
		"user.view",
		"report.view_own",
		"report.view_other",
		"report.export",
		"report.statistics",
		"report.print_locked",
		"payout.view",
		"settings.view",
		"holiday.manage",
		"audit.view",
		"command.punch",
		"command.close_month",
		"command.recalc",
	],
	employee: ["time.punch", "time.edit_own", "absence.request", "report.view_own"],
};

/**
 * Default absence types of the time tracking: code, name, factor, reduces vacation, visible for everybody.
 *
 * “Visible for everybody” (`active`) says whether an employee may pick the type in the app. Sickness, accident and
 * military service start switched off: a company gets those notes on the same day and books them itself, while
 * vacation, further training and the like are requested by the employee.
 */
export const ABSENCE_TYPES: {
	code: string;
	name: string;
	factor: number;
	reduceVacation: boolean;
	active: boolean;
	color: string;
}[] = [
	{ code: "F", name: "Ferien", factor: 100, reduceVacation: true, active: true, color: "#2e7d32" },
	{ code: "K", name: "Krankheit", factor: 100, reduceVacation: false, active: false, color: "#c62828" },
	{ code: "U", name: "Unfall", factor: 100, reduceVacation: false, active: false, color: "#ef6c00" },
	{ code: "M", name: "Militär", factor: 100, reduceVacation: false, active: false, color: "#455a64" },
	{ code: "I", name: "Intern", factor: 100, reduceVacation: false, active: true, color: "#1565c0" },
	{ code: "W", name: "Weiterbildung", factor: 50, reduceVacation: false, active: true, color: "#6a1b9a" },
	{ code: "E", name: "Extern", factor: 50, reduceVacation: false, active: true, color: "#795548" },
];

/** Default instance settings (specification section 2.9.9); existing values are never overwritten. */
export const SETTING_DEFAULTS: Record<string, string> = {
	edit_window_days: "7",
	quick_round_minutes: "0",
	absence_calc_until_today: "1",
	absence_deduct_worktime: "0",
	print_limit_days: "0",
	holiday_country: "DE",
	default_language: "de",
	session_ttl_minutes: "720",
	backup_retention_days: "30",
	attendance_list_visible: "0",
	// how the pause of a day is determined: `auto` = the punched break, otherwise the graduated rules
	pause_mode: "auto",
	// path of a Unicode font for the PDF statement; empty uses the built-in Latin fonts
	report_font_path: "",
	// branding of the installation: logo and background as data URLs (empty = not set), accent colour as hex
	brand_logo: "",
	brand_background: "",
	brand_color: "",
};

/**
 * Options controlling which initial data is written.
 */
export interface SeedOptions {
	/** Country used to generate public holidays (default `CH`) */
	holidayCountry?: HolidayCountry;
	/** Years for which holidays are generated (default: current and next year) */
	holidayYears?: number[];
}

/**
 * Writes all initial data. Idempotent: repeated calls change nothing and never overwrite
 * user-modified settings.
 *
 * @param db - open database handle
 * @param options - seed options
 * @returns summary of what is now present
 */
export function seed(db: Db, options: SeedOptions = {}): { permissions: number; holidays: number } {
	const country: HolidayCountry = options.holidayCountry ?? "DE";
	const currentYear = new Date().getUTCFullYear();
	const years = options.holidayYears ?? [currentYear, currentYear + 1];

	const run = db.transaction((): void => {
		const now = Math.floor(Date.now() / 1000);

		const insertRole = db.prepare("INSERT OR IGNORE INTO roles (key, name) VALUES (?, ?)");
		insertRole.run("admin", "Administrator");
		insertRole.run("manager", "Manager");
		insertRole.run("employee", "Employee");

		const insertPermission = db.prepare("INSERT OR IGNORE INTO permissions (key) VALUES (?)");
		for (const permission of ALL_PERMISSIONS) {
			insertPermission.run(permission);
		}

		const findRole = db.prepare("SELECT id FROM roles WHERE key = ?");
		const findPermission = db.prepare("SELECT id FROM permissions WHERE key = ?");
		const linkRole = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)");
		for (const [roleKey, permissions] of Object.entries(ROLE_PERMISSIONS)) {
			const role = findRole.get(roleKey) as { id: number } | undefined;
			if (!role) {
				continue;
			}
			for (const permission of permissions) {
				const row = findPermission.get(permission) as { id: number } | undefined;
				if (row) {
					linkRole.run(role.id, row.id);
				}
			}
		}

		const insertAbsenceType = db.prepare(
			`INSERT OR IGNORE INTO absence_types (user_id, code, name, paid, factor, reduce_vacation, is_active, color)
			 VALUES (NULL, ?, ?, 1, ?, ?, ?, ?)`,
		);
		for (const type of ABSENCE_TYPES) {
			insertAbsenceType.run(
				type.code,
				type.name,
				type.factor,
				type.reduceVacation ? 1 : 0,
				type.active ? 1 : 0,
				type.color,
			);
		}

		const insertSetting = db.prepare(
			"INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
		);
		for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
			insertSetting.run(key, key === "holiday_country" ? country : value, now);
		}
	});
	run();

	let holidayCount = 0;
	for (const year of years) {
		holidayCount += ensureHolidaysForYear(db, country, year);
	}

	const permissionCount = (db.prepare("SELECT COUNT(*) AS c FROM permissions").get() as { c: number }).c;
	return { permissions: permissionCount, holidays: holidayCount };
}

/**
 * Generates and stores the public holidays of one year for a country (idempotent).
 *
 * @param db - open database handle
 * @param country - supported country code
 * @param year - four digit year
 * @returns number of inserted holiday rows
 */
export function ensureHolidaysForYear(db: Db, country: HolidayCountry, year: number): number {
	const insert = db.prepare("INSERT OR IGNORE INTO holidays (region, year, date, name, key) VALUES (?, ?, ?, ?, ?)");
	let inserted = 0;
	const run = db.transaction((): void => {
		for (const holiday of holidaysForYear(year, country)) {
			inserted += insert.run(country, year, holiday.date, holiday.name, holiday.key).changes;
		}
	});
	run();
	return inserted;
}
