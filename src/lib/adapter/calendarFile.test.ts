/**
 * The calendar file below `files/`.
 *
 * A recorder stands in for the adapter instance: the file API of ioBroker is replaced by a map, so the way the folder
 * and the calendar come into being can be tested without a running ioBroker.
 */

/// <reference types="mocha" />
import { expect } from "chai";
import {
	CALENDAR_FILE_NAME,
	CALENDAR_NOTE_FILE_NAME,
	calendarNote,
	ensureCalendarFolder,
	writeCalendarFile,
	type CalendarFilePort,
} from "./calendarFile";

/** Namespace of a test instance. */
const NAMESPACE = "time-tracker.0";

/**
 * Remembers the files the adapter would have written.
 */
class Recorder implements CalendarFilePort {
	/** Content of every written file, keyed by `namespace/file name`. */
	public readonly files = new Map<string, string>();

	/**
	 * Looks a file up.
	 *
	 * @param adapter - namespace of the instance
	 * @param path - file name
	 * @returns true when the file exists
	 */
	public fileExistsAsync(adapter: string, path: string): boolean {
		return this.files.has(`${adapter}/${path}`);
	}

	/**
	 * Writes a file.
	 *
	 * @param adapter - namespace of the instance
	 * @param path - file name
	 * @param data - content of the file
	 */
	public writeFileAsync(adapter: string, path: string, data: string): void {
		this.files.set(`${adapter}/${path}`, data);
	}
}

describe("calendar file below files/", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = new Recorder();
	});

	it("creates the folder through the file API and writes the note only once", async () => {
		expect(await ensureCalendarFolder(recorder, NAMESPACE)).to.equal(true);
		expect(recorder.files.get(`${NAMESPACE}/${CALENDAR_NOTE_FILE_NAME}`)).to.equal(calendarNote());

		// every further start finds the note and leaves the folder alone
		expect(await ensureCalendarFolder(recorder, NAMESPACE)).to.equal(false);
		expect(recorder.files.size).to.equal(1);
	});

	it("names the calendar file after the note and keeps the document unchanged", async () => {
		const document = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

		await ensureCalendarFolder(recorder, NAMESPACE);
		await writeCalendarFile(recorder, NAMESPACE, document);

		expect(recorder.files.get(`${NAMESPACE}/${CALENDAR_FILE_NAME}`)).to.equal(document);
	});

	it("tells a reader what the folder holds", () => {
		const note = calendarNote();

		expect(note).to.contain(CALENDAR_FILE_NAME);
		expect(note).to.contain("calendar.feedFile");
		expect(note).to.contain("calendar.feedUrl");
	});
});
