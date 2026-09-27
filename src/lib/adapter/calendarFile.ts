/**
 * The calendar file below `files/`.
 *
 * ioBroker keeps the files of an instance below `<iobroker-data>/files/<namespace>/`. That area is what the file
 * manager of the admin UI shows and what a `web` instance serves — but only what was created through the **file API**
 * of the adapter is known there: that call registers the folder as well. A folder made with `fs.mkdir` stays a folder
 * nobody knows about (D11). The calendar is therefore written with `writeFileAsync`, and a small note file makes sure
 * the folder exists before the first calendar run — a new instance has an empty folder and no calendar for a while.
 *
 * The logic works on a tiny port interface (`CalendarFilePort`) — the adapter instance in production, a recorder in
 * the tests.
 */

/** Subset of the adapter file API this module needs. */
export interface CalendarFilePort {
	/**
	 * Checks whether a file of the instance exists.
	 *
	 * @param adapter - namespace of the instance (`time-tracker.0`)
	 * @param path - file name below the `files` folder of the instance
	 */
	fileExistsAsync(adapter: string, path: string): Promise<boolean> | boolean;
	/**
	 * Writes a file into the `files` folder of the instance.
	 *
	 * @param adapter - namespace of the instance (`time-tracker.0`)
	 * @param path - file name below the `files` folder of the instance
	 * @param data - content of the file
	 */
	writeFileAsync(adapter: string, path: string, data: string): Promise<void> | void;
}

/** Name of the calendar file below `files/<namespace>/`. */
export const CALENDAR_FILE_NAME = "calendar.ics";

/** Name of the note that keeps the folder visible in the file manager. */
export const CALENDAR_NOTE_FILE_NAME = "INFO.txt";

/**
 * Text of the note file — what a person sees who opens the folder.
 *
 * @returns the content of `INFO.txt`
 */
export function calendarNote(): string {
	return [
		"Files of the ioBroker adapter time-tracker.",
		"",
		`${CALENDAR_FILE_NAME} is the company calendar. The adapter rewrites it on every change and every five`,
		"minutes — please do not edit or delete it.",
		"The path stands in the state calendar.feedFile, the subscription link in calendar.feedUrl.",
	].join("\n");
}

/**
 * Makes sure the `files` folder of the instance exists.
 *
 * The folder comes into being through the file API, so the file manager and the web file server know it before the
 * first calendar was written. It runs on every start and writes only when the note is missing.
 *
 * @param port - adapter file API
 * @param namespace - namespace of the instance (`time-tracker.0`)
 * @returns true when the note had to be written
 */
export async function ensureCalendarFolder(port: CalendarFilePort, namespace: string): Promise<boolean> {
	if (await port.fileExistsAsync(namespace, CALENDAR_NOTE_FILE_NAME)) {
		return false;
	}
	await port.writeFileAsync(namespace, CALENDAR_NOTE_FILE_NAME, calendarNote());
	return true;
}

/**
 * Writes the calendar of the company.
 *
 * @param port - adapter file API
 * @param namespace - namespace of the instance (`time-tracker.0`)
 * @param document - the complete iCalendar document
 */
export async function writeCalendarFile(port: CalendarFilePort, namespace: string, document: string): Promise<void> {
	await port.writeFileAsync(namespace, CALENDAR_FILE_NAME, document);
}
