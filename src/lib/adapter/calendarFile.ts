/**
 * The calendar file below `files/`.
 *
 * The files of an instance live below `<iobroker-data>/files/<namespace>/` — that is the area the file manager of the
 * admin UI shows and a `web` instance hands out. The file API of ioBroker writes there **only below a mount point**:
 * an object of type `meta` the file hangs on, and that object is what makes the folder known (D11). The instance
 * namespace itself is not a mount point — `writeFileAsync("time-tracker.0", …)` is answered with
 * `time-tracker.0 is not an object of type "meta"`, and nothing is written (seen on a real installation in 0.7.11).
 *
 * The calendar therefore hangs on `<namespace>.storage` of the kind `meta.folder`: the adapter rebuilds the file on
 * every start and every five minutes, so it may stay out of the data backup (ioBroker keeps regenerable files there
 * and stores durable ones under `meta.user`).
 *
 * The logic works on a tiny port interface (`CalendarFilePort`) — the adapter instance in production, a recorder in
 * the tests.
 */

import * as path from "node:path";
import { STATE_NAMES } from "./stateNames";

/** Subset of the adapter API this module needs. */
export interface CalendarFilePort {
	/**
	 * Creates an object when it does not exist yet.
	 *
	 * @param id - full object id (including the instance prefix)
	 * @param object - object definition
	 */
	setObjectNotExists(id: string, object: ioBroker.SettableObject): Promise<unknown> | void;
	/**
	 * Writes a file below a mount point.
	 *
	 * @param adapter - id of the mount point (`time-tracker.0.storage`)
	 * @param path - file name below the mount point
	 * @param data - content of the file
	 */
	writeFileAsync(adapter: string, path: string, data: string): Promise<void> | void;
}

/** Name of the calendar file below the mount point. */
export const CALENDAR_FILE_NAME = "calendar.ics";

/** Name of the mount point below the instance namespace. */
export const CALENDAR_FOLDER_NAME = "storage";

/**
 * Id of the mount point the calendar file hangs on.
 *
 * It carries the instance namespace and one more level: the namespace itself belongs to the instance object, so it
 * cannot be the mount point (D11).
 *
 * @param namespace - namespace of the instance (`time-tracker.0`)
 * @returns id of the mount point (`time-tracker.0.storage`)
 */
export function calendarMount(namespace: string): string {
	return `${namespace}.${CALENDAR_FOLDER_NAME}`;
}

/**
 * Definition of the mount point.
 *
 * `common.type` decides about the data backup: `meta.folder` keeps the calendar out of it, which is right — the
 * adapter writes the file again on every start.
 *
 * @returns the object to create
 */
export function calendarMountObject(): ioBroker.SettableObject {
	return {
		type: "meta",
		common: { name: STATE_NAMES.storageFolder, type: "meta.folder" },
		native: {},
	};
}

/**
 * Makes sure the mount point of the calendar exists.
 *
 * It runs on every start (idempotent), so the folder is in the file manager from the first start on — before the
 * first calendar run, and also on an instance that was installed earlier.
 *
 * @param port - adapter object API
 * @param namespace - namespace of the instance (`time-tracker.0`)
 */
export async function ensureCalendarFolder(port: CalendarFilePort, namespace: string): Promise<void> {
	await port.setObjectNotExists(calendarMount(namespace), calendarMountObject());
}

/**
 * Writes the calendar of the company.
 *
 * @param port - adapter file API
 * @param namespace - namespace of the instance (`time-tracker.0`)
 * @param document - the complete iCalendar document
 */
export async function writeCalendarFile(port: CalendarFilePort, namespace: string, document: string): Promise<void> {
	await port.writeFileAsync(calendarMount(namespace), CALENDAR_FILE_NAME, document);
}

/**
 * Absolute path of the calendar file — what `calendar.feedFile` carries for the `ical` adapter.
 *
 * @param dataDir - data folder of the installation (`<iobroker-data>`)
 * @param namespace - namespace of the instance (`time-tracker.0`)
 * @returns the path of the written file
 */
export function calendarFilePath(dataDir: string, namespace: string): string {
	return path.join(dataDir, "files", namespace, CALENDAR_FOLDER_NAME, CALENDAR_FILE_NAME);
}
