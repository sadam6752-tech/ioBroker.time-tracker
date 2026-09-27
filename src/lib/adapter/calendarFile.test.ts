/**
 * The calendar file below `files/`.
 *
 * A recorder stands in for the adapter instance: the object and file API of ioBroker are replaced by maps, so the way
 * the mount point and the calendar come into being can be tested without a running ioBroker. The regression this file
 * guards against sits in the first test — the file has to hang on a mount point, never on the instance namespace
 * itself (0.7.11 wrote below `time-tracker.0` and the object database answered
 * `time-tracker.0 is not an object of type "meta"`).
 */

/// <reference types="mocha" />
import * as path from "node:path";
import { expect } from "chai";
import {
	CALENDAR_FILE_NAME,
	CALENDAR_FOLDER_NAME,
	calendarFilePath,
	calendarMount,
	calendarMountObject,
	ensureCalendarFolder,
	writeCalendarFile,
	type CalendarFilePort,
} from "./calendarFile";
import { STATE_NAMES } from "./stateNames";

/** Namespace of a test instance. */
const NAMESPACE = "time-tracker.0";

/** The fields the tests look at in the recorded object definition. */
interface MountObject {
	/** Object type, `meta` for a mount point */
	type?: string;
	/** Common part: shown name and the kind of the mount point */
	common?: { name?: Record<string, string>; type?: string };
	/** Native part */
	native?: unknown;
}

/** An iCalendar document, as `publishCalendar` builds it. */
const DOCUMENT = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

/**
 * Remembers the objects and files the adapter would have created.
 */
class Recorder implements CalendarFilePort {
	/** Objects that were asked for, keyed by id — like the objects database. */
	public readonly objects = new Map<string, ioBroker.SettableObject>();

	/** Content of every written file, keyed by `mount point/file name`. */
	public readonly files = new Map<string, string>();

	/** How often the mount point was asked for. */
	public mountPointCalls = 0;

	/**
	 * Creates an object when it does not exist yet.
	 *
	 * @param id - full object id
	 * @param object - object definition
	 */
	public setObjectNotExists(id: string, object: ioBroker.SettableObject): void {
		if (id === calendarMount(NAMESPACE)) {
			this.mountPointCalls++;
		}
		if (!this.objects.has(id)) {
			this.objects.set(id, object);
		}
	}

	/**
	 * Writes a file below a mount point.
	 *
	 * @param adapter - id of the mount point
	 * @param file - file name below the mount point
	 * @param data - content of the file
	 */
	public writeFileAsync(adapter: string, file: string, data: string): void {
		this.files.set(`${adapter}/${file}`, data);
	}
}

describe("calendar file below files/", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = new Recorder();
	});

	it("hangs the file on a mount point and never on the instance namespace", async () => {
		// the namespace itself belongs to the instance object: the object database refuses to write files below it
		expect(calendarMount(NAMESPACE)).to.equal(`${NAMESPACE}.${CALENDAR_FOLDER_NAME}`);
		expect(calendarMount(NAMESPACE)).to.not.equal(NAMESPACE);

		await ensureCalendarFolder(recorder, NAMESPACE);
		await writeCalendarFile(recorder, NAMESPACE, DOCUMENT);

		expect([...recorder.files.keys()]).to.deep.equal([
			`${NAMESPACE}.${CALENDAR_FOLDER_NAME}/${CALENDAR_FILE_NAME}`,
		]);
		expect(recorder.objects.has(NAMESPACE)).to.equal(false);
	});

	it("creates the mount point as a folder object that stays out of the data backup", async () => {
		await ensureCalendarFolder(recorder, NAMESPACE);

		const object = recorder.objects.get(calendarMount(NAMESPACE)) as MountObject | undefined;
		expect(object, "the mount point was created").to.not.equal(undefined);
		expect(object?.type).to.equal("meta");
		expect(object?.common?.type).to.equal("meta.folder");
	});

	it("names the mount point in the eleven languages and keeps it after the first start", async () => {
		await ensureCalendarFolder(recorder, NAMESPACE);
		// every further start asks again, the object stays as it is — that is what `setObjectNotExists` does
		await ensureCalendarFolder(recorder, NAMESPACE);

		const object = recorder.objects.get(calendarMount(NAMESPACE)) as MountObject | undefined;
		const name = object?.common?.name ?? {};
		expect(Object.keys(name).sort()).to.deep.equal(Object.keys(STATE_NAMES.storageFolder).sort());
		expect(name.de).to.equal("Dateiablage");
		expect(recorder.mountPointCalls).to.equal(2);
		expect(recorder.objects.size).to.equal(1);
	});

	it("writes the calendar below the mount point and keeps the document unchanged", async () => {
		await ensureCalendarFolder(recorder, NAMESPACE);
		await writeCalendarFile(recorder, NAMESPACE, DOCUMENT);

		expect(recorder.files.get(`${NAMESPACE}.${CALENDAR_FOLDER_NAME}/${CALENDAR_FILE_NAME}`)).to.equal(DOCUMENT);
		expect(recorder.files.get(`${NAMESPACE}/${CALENDAR_FILE_NAME}`)).to.equal(undefined);
	});

	it("names the absolute path of the written file, as the state calendar.feedFile carries it", () => {
		const file = calendarFilePath(path.join("data"), NAMESPACE);

		expect(file.split(path.sep).join("/")).to.equal(
			`data/files/${NAMESPACE}/${CALENDAR_FOLDER_NAME}/${CALENDAR_FILE_NAME}`,
		);
	});

	it("describes the mount point with a plain object definition", () => {
		const object = calendarMountObject();

		expect(object.type).to.equal("meta");
		expect(object.native).to.deep.equal({});
	});
});
