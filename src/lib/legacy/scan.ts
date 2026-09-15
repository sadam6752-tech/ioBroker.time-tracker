/**
 * Detection of a SMALL-Time installation (specification 2.9.10 step 1).
 *
 * The legacy system keeps its data in two places below the installation folder:
 *
 * ```
 * <baseDir>/Data/users.txt                         one line per user
 * <baseDir>/Data/group.txt                         group names
 * <baseDir>/Data/<login>/userdaten.txt             work profile
 * <baseDir>/Data/<login>/absenz.txt                absence types
 * <baseDir>/Data/<login>/Timetable/<year>          monthly target/balance (golden values)
 * <baseDir>/Data/<login>/Timetable/<year>.<month>  punch instants
 * <baseDir>/Data/<login>/Timetable/A<year>         absences
 * <baseDir>/Data/<login>/Timetable/auszahlungen    payouts
 * <baseDir>/Data/<login>/Timetable/total.txt       control values
 * <baseDir>/include/Settings/settings.txt          instance settings
 * <baseDir>/include/Settings/pausen.txt            break rules
 * ```
 *
 * This module only looks at the file system and returns plain data — no database, no side effects. Nothing
 * below the installation folder is changed. Every unknown file is collected in `skippedFiles`, so the
 * import report can document it (2.9.12).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A monthly punch file `Timetable/<year>.<month>`. */
export interface LegacyPunchFile {
	/** Calendar year */
	year: number;
	/** Month, 1 based */
	month: number;
	/** Absolute path of the file */
	path: string;
}

/** A golden file `Timetable/<year>` with the monthly target and balance. */
export interface LegacyGoldenFile {
	/** Calendar year */
	year: number;
	/** Absolute path of the file */
	path: string;
}

/** An absence file `Timetable/A<year>`. */
export interface LegacyAbsenceFile {
	/** Calendar year */
	year: number;
	/** Absolute path of the file */
	path: string;
}

/** Everything one user folder contains. */
export interface LegacyUserFolder {
	/** Technical login = name of the folder */
	login: string;
	/** Absolute path of the user folder */
	path: string;
	/** Absolute path of `userdaten.txt` — the file that makes a folder a user folder */
	userDataFile: string;
	/** Absolute path of `personaldaten.txt`, `null` when absent */
	personalDataFile: string | null;
	/** Absolute path of `absenz.txt`, `null` when absent */
	absenceTypeFile: string | null;
	/** Absolute path of the `Timetable` folder, `null` when absent */
	timetableDir: string | null;
	/** Monthly punch files, sorted by year and month */
	punchFiles: LegacyPunchFile[];
	/** Golden files, sorted by year */
	goldenFiles: LegacyGoldenFile[];
	/** Absence files, sorted by year */
	absenceFiles: LegacyAbsenceFile[];
	/** Absolute path of `Timetable/auszahlungen`, `null` when absent */
	payoutFile: string | null;
	/** Absolute path of `Timetable/total.txt`, `null` when absent */
	totalsFile: string | null;
	/** Files and folders below the user folder that the import ignores */
	skippedFiles: string[];
}

/** A detected installation. */
export interface LegacyLayout {
	/** Folder that was inspected */
	baseDir: string;
	/** Absolute path of the `Data` folder */
	dataDir: string;
	/** Absolute path of `Data/users.txt`, `null` when missing */
	usersFile: string | null;
	/** Absolute path of `Data/group.txt`, `null` when missing */
	groupFile: string | null;
	/** Absolute path of `include/Settings/settings.txt`, `null` when missing */
	settingsFile: string | null;
	/** Absolute path of `include/Settings/pausen.txt`, `null` when missing */
	pauseFile: string | null;
	/** User folders, sorted by login (case insensitive) */
	users: LegacyUserFolder[];
	/** Remarks for `import_runs.warnings` */
	warnings: string[];
}

/** Matches `2026` — the golden file with twelve monthly rows. */
const GOLDEN_NAME = /^(\d{4})$/;
/** Matches `2026.2` — the punches of February 2026. */
const PUNCH_NAME = /^(\d{4})\.(\d{1,2})$/;
/** Matches `A2026` — the absences of 2026. */
const ABSENCE_NAME = /^A(\d{4})$/;

/**
 * Lists the entries of a directory, tolerating a missing directory.
 *
 * @param path - absolute path of the directory
 * @returns names of the entries, empty when the directory does not exist
 */
function listDirectory(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/**
 * Checks whether a path is a directory.
 *
 * @param path - path to check
 * @returns true when the path is a directory
 */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Checks whether a path is a file.
 *
 * @param path - path to check
 * @returns true when the path is a file
 */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Reads the first email address of the legacy personal data file.
 *
 * The format is not documented and the sample data is empty, so the email is the only field taken over
 * (2.9.1); everything else in that file is discarded.
 *
 * @param path - absolute path of `personaldaten.txt`
 * @returns the email address or `null` when the file holds none
 */
export function readLegacyEmail(path: string): string | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	for (const field of text.split(/[;\r\n]+/)) {
		const value = field.trim();
		if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
			return value;
		}
	}
	return null;
}

/**
 * Reads the `Timetable` folder of one user folder.
 *
 * @param userPath - absolute path of the user folder
 * @param skippedFiles - collector for ignored names
 * @returns the timetable part of the user folder
 */
function scanTimetable(
	userPath: string,
	skippedFiles: string[],
): {
	timetableDir: string | null;
	punchFiles: LegacyPunchFile[];
	goldenFiles: LegacyGoldenFile[];
	absenceFiles: LegacyAbsenceFile[];
	payoutFile: string | null;
	totalsFile: string | null;
} {
	const timetableDir = join(userPath, "Timetable");
	if (!isDirectory(timetableDir)) {
		return {
			timetableDir: null,
			punchFiles: [],
			goldenFiles: [],
			absenceFiles: [],
			payoutFile: null,
			totalsFile: null,
		};
	}

	const punchFiles: LegacyPunchFile[] = [];
	const goldenFiles: LegacyGoldenFile[] = [];
	const absenceFiles: LegacyAbsenceFile[] = [];
	let payoutFile: string | null = null;
	let totalsFile: string | null = null;

	for (const name of listDirectory(timetableDir)) {
		const path = join(timetableDir, name);
		if (!isFile(path)) {
			skippedFiles.push(`Timetable/${name}/`);
			continue;
		}

		const punch = PUNCH_NAME.exec(name);
		if (punch) {
			const month = Number(punch[2]);
			if (month >= 1 && month <= 12) {
				punchFiles.push({ year: Number(punch[1]), month, path });
			} else {
				skippedFiles.push(`Timetable/${name}`);
			}
			continue;
		}

		const golden = GOLDEN_NAME.exec(name);
		if (golden) {
			goldenFiles.push({ year: Number(golden[1]), path });
			continue;
		}

		const absence = ABSENCE_NAME.exec(name);
		if (absence) {
			absenceFiles.push({ year: Number(absence[1]), path });
			continue;
		}

		if (name === "auszahlungen") {
			payoutFile = path;
			continue;
		}
		if (name === "total.txt") {
			totalsFile = path;
			continue;
		}
		skippedFiles.push(`Timetable/${name}`);
	}

	punchFiles.sort((a, b) => a.year - b.year || a.month - b.month);
	goldenFiles.sort((a, b) => a.year - b.year);
	absenceFiles.sort((a, b) => a.year - b.year);
	return { timetableDir, punchFiles, goldenFiles, absenceFiles, payoutFile, totalsFile };
}

/** Folders below a user folder that are deliberately not migrated (2.9.12). */
const NOT_MIGRATED_FOLDERS = ["Rapport", "Dokumente", "img"];
/** Names below a user folder that the import knows about. */
const KNOWN_USER_ENTRIES = new Set([
	"userdaten.txt",
	"personaldaten.txt",
	"absenz.txt",
	"Timetable",
	...NOT_MIGRATED_FOLDERS,
]);

/**
 * Reads one user folder.
 *
 * @param login - name of the folder = technical login
 * @param path - absolute path of the folder
 * @returns the scanned user folder
 */
export function scanUserFolder(login: string, path: string): LegacyUserFolder {
	const skippedFiles: string[] = [];
	const timetable = scanTimetable(path, skippedFiles);

	for (const name of listDirectory(path)) {
		if (KNOWN_USER_ENTRIES.has(name)) {
			continue;
		}
		const childPath = join(path, name);
		if (isDirectory(childPath)) {
			skippedFiles.push(`${name}/`);
		} else {
			skippedFiles.push(name);
		}
	}
	for (const name of NOT_MIGRATED_FOLDERS) {
		const childPath = join(path, name);
		if (isDirectory(childPath)) {
			skippedFiles.push(`${name}/ (${listDirectory(childPath).length} file(s), not migrated)`);
		}
	}
	skippedFiles.sort();

	const personalDataFile = join(path, "personaldaten.txt");
	const absenceTypeFile = join(path, "absenz.txt");
	return {
		login,
		path,
		userDataFile: join(path, "userdaten.txt"),
		personalDataFile: isFile(personalDataFile) ? personalDataFile : null,
		absenceTypeFile: isFile(absenceTypeFile) ? absenceTypeFile : null,
		timetableDir: timetable.timetableDir,
		punchFiles: timetable.punchFiles,
		goldenFiles: timetable.goldenFiles,
		absenceFiles: timetable.absenceFiles,
		payoutFile: timetable.payoutFile,
		totalsFile: timetable.totalsFile,
		skippedFiles,
	};
}

/**
 * Detects the layout of a SMALL-Time installation.
 *
 * The folder chosen by the operator may be the installation folder (containing `Data` and `include`) or
 * the `Data` folder itself. A user folder is every directory holding a `userdaten.txt` (2.9.10 step 1);
 * everything else is ignored and reported.
 *
 * @param baseDir - folder chosen by the operator
 * @returns the detected layout; `users` stays empty when nothing was found
 */
export function detectLegacyLayout(baseDir: string): LegacyLayout {
	const warnings: string[] = [];
	const dataDir = isDirectory(join(baseDir, "Data")) ? join(baseDir, "Data") : baseDir;
	const includeSettings = isDirectory(join(baseDir, "include", "Settings"))
		? join(baseDir, "include", "Settings")
		: join(dataDir, "..", "include", "Settings");

	const users: LegacyUserFolder[] = [];
	const ignored: string[] = [];
	for (const name of listDirectory(dataDir)) {
		const path = join(dataDir, name);
		if (isDirectory(path)) {
			if (isFile(join(path, "userdaten.txt"))) {
				users.push(scanUserFolder(name, path));
			} else {
				ignored.push(`${name}/`);
			}
		} else if (name !== "users.txt" && name !== "group.txt") {
			ignored.push(name);
		}
	}
	users.sort((a, b) => a.login.localeCompare(b.login, "en", { sensitivity: "base" }));

	const usersFile = join(dataDir, "users.txt");
	const groupFile = join(dataDir, "group.txt");
	const settingsFile = join(includeSettings, "settings.txt");
	const pauseFile = join(includeSettings, "pausen.txt");

	if (users.length === 0) {
		warnings.push(`no user folder with a userdaten.txt below ${dataDir}`);
	}
	if (!isFile(usersFile)) {
		warnings.push("Data/users.txt is missing — users are created from the user folders alone");
	}
	if (!isFile(groupFile)) {
		warnings.push("Data/group.txt is missing — imported users become employees");
	}
	if (!isFile(settingsFile)) {
		warnings.push("include/Settings/settings.txt is missing — the settings keep their defaults");
	}
	if (!isFile(pauseFile)) {
		warnings.push("include/Settings/pausen.txt is missing — the break rules are derived from the settings");
	}
	if (ignored.length > 0) {
		warnings.push(`ignored entries below Data: ${ignored.sort().join(", ")}`);
	}

	return {
		baseDir,
		dataDir,
		usersFile: isFile(usersFile) ? usersFile : null,
		groupFile: isFile(groupFile) ? groupFile : null,
		settingsFile: isFile(settingsFile) ? settingsFile : null,
		pauseFile: isFile(pauseFile) ? pauseFile : null,
		users,
		warnings,
	};
}
