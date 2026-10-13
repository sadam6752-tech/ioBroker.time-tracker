/* eslint-disable @typescript-eslint/require-await -- the fake server answers synchronously */
import { expect } from "chai";
import {
	copyBackupToRemote,
	hexToFingerprint,
	hostKeyMatches,
	normalizeRemoteDirectory,
	remoteSettingsProblems,
	selectRemoteCopiesToPrune,
	selectStalePartials,
	settingsForConnectionTest,
	testRemoteConnection,
	type RemoteBackupSettings,
	type SftpConnector,
	type SftpSession,
	type Timers,
} from "./remoteBackup";

const settings: RemoteBackupSettings = {
	enabled: true,
	host: "nas.local",
	port: 22,
	username: "backup",
	password: "secret",
	directory: "/backups/time-tracker",
	keep: 0,
};

// An SFTP server in memory: every path is a key, a directory is a path in `directories`.
function fakeServer(options: { failWrite?: boolean; shortWrite?: boolean; failRemove?: string } = {}): {
	files: Map<string, Buffer>;
	directories: Set<string>;
	connects: Parameters<SftpConnector>[0][];
	closed: { count: number };
	connect: SftpConnector;
} {
	const files = new Map<string, Buffer>();
	const directories = new Set<string>();
	const connects: Parameters<SftpConnector>[0][] = [];
	const closed = { count: 0 };
	const session: SftpSession = {
		makeDirectories: async directory => {
			let current = "";
			for (const part of directory.split("/").filter(Boolean)) {
				current += `/${part}`;
				directories.add(current);
			}
		},
		writeFile: async (path, data) => {
			if (options.failWrite) {
				throw new Error("Permission denied");
			}
			files.set(path, options.shortWrite ? data.subarray(0, 1) : data);
		},
		size: async path => {
			const file = files.get(path);
			if (!file) {
				throw new Error("No such file");
			}
			return file.length;
		},
		rename: async (from, to) => {
			files.set(to, files.get(from)!);
			files.delete(from);
		},
		list: async directory =>
			[...files.keys()]
				.filter(path => path.startsWith(`${directory}/`))
				.map(path => path.slice(directory.length + 1)),
		remove: async path => {
			if (options.failRemove && path.endsWith(options.failRemove)) {
				throw new Error("Permission denied");
			}
			files.delete(path);
		},
		close: () => {
			closed.count++;
		},
	};
	const connect: SftpConnector = async connection => {
		connects.push(connection);
		connection.onHostKey("SHA256:abc");
		return session;
	};
	return { files, directories, connects, closed, connect };
}

// the tests use the timers of Node.js; the adapter hands in its own
const timers: Timers = {
	start: (callback, ms) => globalThis.setTimeout(callback, ms),
	stop: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
const quiet = { info: (): void => undefined, warn: (): void => undefined };
const backup = { name: "time-tracker-2026-10-12T08-00-00.sqlite", data: Buffer.from("zip bytes") };

describe("remote backup => settings", () => {
	it("normalizes the directory and refuses ..", () => {
		expect(normalizeRemoteDirectory("/backups//time-tracker/")).to.equal("/backups/time-tracker");
		expect(normalizeRemoteDirectory("backups\\time-tracker")).to.equal("backups/time-tracker");
		expect(normalizeRemoteDirectory("/")).to.equal("/");
		expect(normalizeRemoteDirectory("")).to.equal("");
		expect(normalizeRemoteDirectory("/backups/../etc")).to.equal(null);
	});

	it("names what is missing", () => {
		expect(remoteSettingsProblems(settings)).to.deep.equal([]);
		expect(remoteSettingsProblems({ enabled: true })).to.have.lengthOf(3);
		expect(remoteSettingsProblems({ ...settings, port: 70000 })).to.deep.equal([
			"the port must be between 1 and 65535",
		]);
		expect(remoteSettingsProblems({ ...settings, directory: "../x" })).to.deep.equal([
			'the directory must not contain ".."',
		]);
		// no port entered = 22
		expect(remoteSettingsProblems({ ...settings, port: undefined })).to.deep.equal([]);
	});
});

describe("remote backup => host key", () => {
	const hex = "0f".repeat(32);
	const fingerprint = hexToFingerprint(hex);

	it("writes the fingerprint like OpenSSH", () => {
		expect(fingerprint).to.match(/^SHA256:[A-Za-z0-9+/]{43}$/);
	});

	it("accepts the matching key in every notation and nothing else", () => {
		expect(hostKeyMatches("", hex)).to.equal(true);
		expect(hostKeyMatches(fingerprint, hex)).to.equal(true);
		expect(hostKeyMatches(fingerprint.replace("SHA256:", ""), hex)).to.equal(true);
		expect(hostKeyMatches(hex, hex)).to.equal(true);
		expect(hostKeyMatches(hex.replace(/(..)/g, "$1:").slice(0, -1).toUpperCase(), hex)).to.equal(true);
		expect(hostKeyMatches(hexToFingerprint("1e".repeat(32)), hex)).to.equal(false);
		expect(hostKeyMatches("1e".repeat(32), hex)).to.equal(false);
		expect(hostKeyMatches("nonsense", hex)).to.equal(false);
	});
});

describe("remote backup => keeping the copies", () => {
	const names = [
		"time-tracker-2026-10-10T08-00-00.sqlite",
		"time-tracker-2026-10-12T08-00-00.sqlite",
		"time-tracker-2026-10-11T08-00-00.sqlite",
		"time-tracker-2026-10-01T08-00-00.sqlite",
		"notes.txt",
	];

	it("picks the oldest copies and nothing else", () => {
		expect(selectRemoteCopiesToPrune(names, 2)).to.deep.equal([
			"time-tracker-2026-10-10T08-00-00.sqlite",
			"time-tracker-2026-10-01T08-00-00.sqlite",
		]);
		expect(selectRemoteCopiesToPrune(names, 1)).to.deep.equal([
			"time-tracker-2026-10-11T08-00-00.sqlite",
			"time-tracker-2026-10-10T08-00-00.sqlite",
			"time-tracker-2026-10-01T08-00-00.sqlite",
		]);
		// a file that only looks similar is never a backup of this adapter
		expect(
			selectRemoteCopiesToPrune(
				[
					"time-tracker-notes.sqlite",
					"time-tracker-2026-10-01T08-00-00.sqlite.part",
					"time-tracker-2026-10-01.sqlite",
				],
				1,
			),
		).to.deep.equal([]);
	});

	it("keeps everything for 0 or a broken number", () => {
		expect(selectRemoteCopiesToPrune(names, 0)).to.deep.equal([]);
		expect(selectRemoteCopiesToPrune(names, Number.NaN)).to.deep.equal([]);
		expect(selectRemoteCopiesToPrune(names, -3)).to.deep.equal([]);
	});
});

describe("remote backup => copy", () => {
	it("writes the file under its final name and creates the directory", async () => {
		const server = fakeServer();
		const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
		expect(result.ok).to.equal(true);
		expect(result.remoteFile).to.equal("/backups/time-tracker/time-tracker-2026-10-12T08-00-00.sqlite");
		expect(server.files.get(result.remoteFile!)!.equals(backup.data)).to.equal(true);
		// the partial file is gone, the directories exist, the connection is closed
		expect([...server.files.keys()].some(path => path.endsWith(".part"))).to.equal(false);
		expect(server.directories.has("/backups/time-tracker")).to.equal(true);
		expect(server.closed.count).to.be.greaterThan(0);
	});

	it("passes the login and trims host and user", async () => {
		const server = fakeServer();
		await copyBackupToRemote(
			server.connect,
			{ ...settings, host: " nas.local ", port: undefined },
			backup,
			quiet,
			timers,
		);
		expect(server.connects[0]).to.include({ host: "nas.local", port: 22, username: "backup", password: "secret" });
	});

	it("warns once about the missing fingerprint, with the fingerprint", async () => {
		const warnings: string[] = [];
		await copyBackupToRemote(
			fakeServer().connect,
			settings,
			backup,
			{
				info: (): void => undefined,
				warn: m => warnings.push(m),
			},
			timers,
		);
		expect(warnings).to.have.lengthOf(1);
		expect(warnings[0]).to.contain("SHA256:abc");
		const quietWarnings: string[] = [];
		await copyBackupToRemote(
			fakeServer().connect,
			{ ...settings, hostKey: "SHA256:abc" },
			backup,
			{
				info: (): void => undefined,
				warn: m => quietWarnings.push(m),
			},
			timers,
		);
		expect(quietWarnings).to.deep.equal([]);
	});

	it("reports a failed upload and leaves nothing under the final name", async () => {
		const server = fakeServer({ failWrite: true });
		const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
		expect(result.ok).to.equal(false);
		expect(result.message).to.contain("Permission denied");
		expect(server.files.size).to.equal(0);
		expect(server.closed.count).to.be.greaterThan(0);
	});

	it("refuses an upload of the wrong size and does not rename it", async () => {
		const server = fakeServer({ shortWrite: true });
		const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
		expect(result.ok).to.equal(false);
		expect(result.message).to.contain("incomplete");
		// the half file is removed at once, nothing is left under any name
		expect(server.files.size).to.equal(0);
	});

	it("does not even connect with incomplete settings", async () => {
		const server = fakeServer();
		const result = await copyBackupToRemote(server.connect, { enabled: true }, backup, quiet, timers);
		expect(result.ok).to.equal(false);
		expect(result.message).to.contain("settings incomplete");
		expect(server.connects).to.have.lengthOf(0);
	});

	it("turns a connection error into a result", async () => {
		const result = await copyBackupToRemote(
			async () => {
				throw new Error("All configured authentication methods failed");
			},
			settings,
			backup,
			quiet,
			timers,
		);
		expect(result).to.deep.include({ ok: false, message: "All configured authentication methods failed" });
	});

	it("gives up on a server that never answers and closes the connection", async () => {
		const closed = { count: 0 };
		const hanging: SftpConnector = async () => ({
			makeDirectories: () => new Promise<void>(() => undefined),
			writeFile: async () => undefined,
			size: async () => 0,
			rename: async () => undefined,
			list: async () => [],
			remove: async () => undefined,
			close: () => {
				closed.count++;
			},
		});
		const result = await copyBackupToRemote(hanging, settings, backup, quiet, timers, 50);
		expect(result.ok).to.equal(false);
		expect(result.message).to.contain("took longer");
		expect(closed.count).to.be.greaterThan(0);
	});

	it("deletes old copies when asked and only those", async () => {
		const server = fakeServer();
		const dir = "/backups/time-tracker";
		for (const name of [
			"time-tracker-2026-10-09T08-00-00.sqlite",
			"time-tracker-2026-10-10T08-00-00.sqlite",
			"time-tracker-2026-10-11T08-00-00.sqlite",
			"time-tracker-2026-09-01T08-00-00.sqlite",
			"foreign.txt",
		]) {
			server.files.set(`${dir}/${name}`, Buffer.from("x"));
		}
		const result = await copyBackupToRemote(server.connect, { ...settings, keep: 2 }, backup, quiet, timers);
		expect(result.ok).to.equal(true);
		expect(result.deleted).to.deep.equal([
			"time-tracker-2026-10-10T08-00-00.sqlite",
			"time-tracker-2026-10-09T08-00-00.sqlite",
			"time-tracker-2026-09-01T08-00-00.sqlite",
		]);
		expect([...server.files.keys()].map(path => path.slice(dir.length + 1)).sort()).to.deep.equal([
			"foreign.txt",
			"time-tracker-2026-10-11T08-00-00.sqlite",
			"time-tracker-2026-10-12T08-00-00.sqlite",
		]);
	});

	it("keeps every copy when nothing is asked for", async () => {
		const server = fakeServer();
		server.files.set("/backups/time-tracker/time-tracker-2026-10-09T08-00-00.sqlite", Buffer.from("x"));
		const result = await copyBackupToRemote(server.connect, { ...settings, keep: 0 }, backup, quiet, timers);
		expect(result.ok).to.equal(true);
		expect(result.deleted).to.deep.equal([]);
	});

	it("keeps the copy and reports ok when an old copy cannot be deleted", async () => {
		const warnings: string[] = [];
		const server = fakeServer({ failRemove: "2026-10-09T08-00-00.sqlite" });
		server.files.set("/backups/time-tracker/time-tracker-2026-10-09T08-00-00.sqlite", Buffer.from("x"));
		const result = await copyBackupToRemote(
			server.connect,
			{ ...settings, keep: 1 },
			backup,
			{
				info: (): void => undefined,
				warn: m => warnings.push(m),
			},
			timers,
		);
		expect(result.ok).to.equal(true);
		expect(warnings.join(" ")).to.contain("Cannot delete the old copy");
	});

	it("works in the root directory", async () => {
		const server = fakeServer();
		const result = await copyBackupToRemote(server.connect, { ...settings, directory: "/" }, backup, quiet, timers);
		expect(result.remoteFile).to.equal("/time-tracker-2026-10-12T08-00-00.sqlite");
	});
});

describe("remote backup => interrupted uploads", () => {
	const dir = "/backups/time-tracker";

	it("picks only the half files of this adapter", () => {
		expect(
			selectStalePartials([
				"time-tracker-2026-10-11T08-00-00.sqlite.part",
				"time-tracker-2026-10-11T08-00-00.sqlite.part",
				"time-tracker-2026-10-11T08-00-00.sqlite",
				"time-tracker-prerestore-2026-10-11T08-00-00.sqlite.part",
				"holiday.sqlite.part",
				"notes.part",
			]),
		).to.deep.equal([
			"time-tracker-2026-10-11T08-00-00.sqlite.part",
			"time-tracker-2026-10-11T08-00-00.sqlite.part",
		]);
	});

	it("removes the leftovers of earlier interrupted uploads after a good copy, and nothing else", async () => {
		const server = fakeServer();
		for (const name of [
			"time-tracker-2026-10-10T08-00-00.sqlite.part",
			"time-tracker-2026-10-09T08-00-00.sqlite.part",
			"time-tracker-2026-10-10T07-00-00.sqlite",
			"holiday.sqlite.part",
		]) {
			server.files.set(`${dir}/${name}`, Buffer.from("x"));
		}
		const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
		expect(result.ok).to.equal(true);
		expect(result.partialsRemoved.sort()).to.deep.equal([
			"time-tracker-2026-10-09T08-00-00.sqlite.part",
			"time-tracker-2026-10-10T08-00-00.sqlite.part",
		]);
		expect([...server.files.keys()].map(path => path.slice(dir.length + 1)).sort()).to.deep.equal([
			"holiday.sqlite.part",
			"time-tracker-2026-10-10T07-00-00.sqlite",
			"time-tracker-2026-10-12T08-00-00.sqlite",
		]);
	});

	it("keeps the copy ok when a leftover cannot be deleted", async () => {
		const warnings: string[] = [];
		const server = fakeServer({ failRemove: ".sqlite.part" });
		server.files.set(`${dir}/time-tracker-2026-10-10T08-00-00.sqlite.part`, Buffer.from("x"));
		const result = await copyBackupToRemote(
			server.connect,
			settings,
			backup,
			{ info: (): void => undefined, warn: m => warnings.push(m) },
			timers,
		);
		expect(result.ok).to.equal(true);
		expect(warnings.join(" ")).to.contain("Cannot delete the interrupted upload");
	});
});

describe("remote backup => late connection after the time limit", () => {
	it("closes a connection that arrives after the limit and writes nothing", async () => {
		const server = fakeServer();
		let release: () => void = () => undefined;
		const slow: SftpConnector = async connection => {
			// the server answers only after the copy has given up
			await new Promise<void>(resolve => {
				release = resolve;
			});
			return server.connect(connection);
		};
		const result = await copyBackupToRemote(slow, settings, backup, quiet, timers, 20);
		expect(result.ok).to.equal(false);
		expect(result.message).to.contain("took longer");
		release();
		await new Promise(resolve => globalThis.setTimeout(resolve, 20));
		expect(server.files.size).to.equal(0);
		expect(server.closed.count).to.be.greaterThan(0);
	});
});

describe("remote backup => settings of the connection test", () => {
	const saved: RemoteBackupSettings = { ...settings, hostKey: "SHA256:saved" };

	it("takes the values of the form, also unsaved ones", () => {
		const test = settingsForConnectionTest(
			{
				remoteHost: "other.local",
				remoteUser: "u",
				remotePassword: "typed",
				remotePort: 2222,
				remoteDirectory: "/x",
			},
			saved,
		);
		expect(test).to.include({ host: "other.local", username: "u", password: "typed", port: 2222, directory: "/x" });
	});

	it("uses the saved password for the saved server when the field is empty", () => {
		const test = settingsForConnectionTest(
			{ remoteHost: "nas.local", remoteUser: "backup", remotePassword: "" },
			saved,
		);
		expect(test.password).to.equal("secret");
		expect(settingsForConnectionTest({}, saved).password).to.equal("secret");
	});

	it("never sends the saved password to another server, user or port", () => {
		expect(settingsForConnectionTest({ remoteHost: "evil.example" }, saved).password).to.equal(undefined);
		expect(settingsForConnectionTest({ remoteUser: "root" }, saved).password).to.equal(undefined);
		expect(settingsForConnectionTest({ remotePort: 2200 }, saved).password).to.equal(undefined);
		// without a password the test stops before it connects
		expect(remoteSettingsProblems(settingsForConnectionTest({ remoteHost: "evil.example" }, saved))).to.include(
			"the password is missing",
		);
	});
});

describe("remote backup => connection test", () => {
	it("writes and deletes a small test file and reports the fingerprint", async () => {
		const server = fakeServer();
		const result = await testRemoteConnection(server.connect, settings, timers);
		expect(result).to.deep.include({ ok: true, fingerprint: "SHA256:abc" });
		expect(server.files.size).to.equal(0);
		expect(server.directories.has("/backups/time-tracker")).to.equal(true);
	});

	it("says why it failed", async () => {
		const result = await testRemoteConnection(fakeServer({ failWrite: true }).connect, settings, timers);
		expect(result.ok).to.equal(false);
		expect(result.message).to.contain("Permission denied");
		expect((await testRemoteConnection(fakeServer().connect, { enabled: true }, timers)).message).to.contain(
			"settings incomplete",
		);
	});
});
