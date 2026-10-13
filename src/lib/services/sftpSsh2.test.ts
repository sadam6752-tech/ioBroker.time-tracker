/**
 * The real SSH/SFTP connection against a small SFTP server inside the test (ssh2 server side), so the
 * connector is exercised end to end: login, host key check, directories, upload, rename, listing, delete.
 */
import { expect } from "chai";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { copyBackupToRemote, testRemoteConnection, type RemoteBackupSettings, type Timers } from "./remoteBackup";
import { connectSsh2 } from "./sftpSsh2";

const { STATUS_CODE } = utils.sftp;
// the tests use the timers of Node.js; the adapter hands in its own
const timers: Timers = {
	start: (callback, ms) => globalThis.setTimeout(callback, ms),
	stop: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
const quiet = { info: (): void => undefined, warn: (): void => undefined };

/** What the in-memory server holds. */
interface Disk {
	files: Map<string, Buffer>;
	directories: Set<string>;
}

// Starts an SFTP server on a free port; `fingerprint` is its host key as OpenSSH shows it.
async function startServer(
	disk: Disk,
	login = { username: "backup", password: "secret" },
): Promise<{ port: number; fingerprint: string; close: () => void }> {
	const keys = utils.generateKeyPairSync("ed25519");
	const parsed = utils.parseKey(keys.public);
	const publicBlob = (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH();
	const fingerprint = `SHA256:${createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")}`;
	const clients = new Set<{ end(): void }>();

	const server = new Server({ hostKeys: [keys.private] }, client => {
		clients.add(client);
		client.on("close", () => clients.delete(client));
		client.on("authentication", context => {
			if (
				context.method === "password" &&
				context.username === login.username &&
				context.password === login.password
			) {
				context.accept();
			} else {
				context.reject(["password"]);
			}
		});
		client.on("error", () => undefined);
		client.on("ready", () => {
			client.on("session", accept => {
				const session = accept();
				session.on("sftp", acceptSftp => {
					const sftp = acceptSftp();
					const handles = new Map<number, { path: string; kind: "file" | "dir"; listed?: boolean }>();
					let next = 1;
					const open = (path: string, kind: "file" | "dir"): Buffer => {
						const id = next++;
						handles.set(id, { path, kind });
						const handle = Buffer.alloc(4);
						handle.writeUInt32BE(id);
						return handle;
					};
					const of = (handle: Buffer): { path: string; kind: "file" | "dir"; listed?: boolean } | undefined =>
						handles.get(handle.readUInt32BE(0));
					const attrsOf = (
						path: string,
					): {
						mode: number;
						size: number;
						uid: number;
						gid: number;
						atime: number;
						mtime: number;
					} | null => {
						const stamp = Math.floor(Date.now() / 1000);
						const file = disk.files.get(path);
						if (file) {
							return { mode: 0o100644, size: file.length, uid: 0, gid: 0, atime: stamp, mtime: stamp };
						}
						if (disk.directories.has(path)) {
							return { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: stamp, mtime: stamp };
						}
						return null;
					};
					const ok = (id: number): void => sftp.status(id, STATUS_CODE.OK);
					const missing = (id: number): void => sftp.status(id, STATUS_CODE.NO_SUCH_FILE);

					sftp.on("REALPATH", (id, path) => {
						sftp.name(id, [{ filename: path, longname: path, attrs: {} as never }]);
					});
					sftp.on("OPEN", (id, path) => {
						disk.files.set(path, Buffer.alloc(0));
						sftp.handle(id, open(path, "file"));
					});
					sftp.on("WRITE", (id, handle, offset, data) => {
						const entry = of(handle);
						if (!entry) {
							sftp.status(id, STATUS_CODE.FAILURE);
							return;
						}
						const old = disk.files.get(entry.path) ?? Buffer.alloc(0);
						const grown = Buffer.alloc(Math.max(old.length, offset + data.length));
						old.copy(grown);
						data.copy(grown, offset);
						disk.files.set(entry.path, grown);
						ok(id);
					});
					sftp.on("CLOSE", (id, handle) => {
						handles.delete(handle.readUInt32BE(0));
						ok(id);
					});
					const stat = (id: number, path: string): void => {
						const attrs = attrsOf(path);
						if (attrs) {
							sftp.attrs(id, attrs);
						} else {
							missing(id);
						}
					};
					sftp.on("STAT", stat);
					sftp.on("LSTAT", stat);
					sftp.on("FSTAT", (id, handle) => {
						const entry = of(handle);
						if (entry) {
							stat(id, entry.path);
						} else {
							missing(id);
						}
					});
					sftp.on("MKDIR", (id, path) => {
						if (disk.directories.has(path) || disk.files.has(path)) {
							sftp.status(id, STATUS_CODE.FAILURE);
							return;
						}
						disk.directories.add(path);
						ok(id);
					});
					sftp.on("RENAME", (id, from, to) => {
						const file = disk.files.get(from);
						if (!file) {
							missing(id);
							return;
						}
						disk.files.set(to, file);
						disk.files.delete(from);
						ok(id);
					});
					sftp.on("REMOVE", (id, path) => {
						if (disk.files.delete(path)) {
							ok(id);
						} else {
							missing(id);
						}
					});
					sftp.on("OPENDIR", (id, path) => {
						if (disk.directories.has(path)) {
							sftp.handle(id, open(path, "dir"));
						} else {
							missing(id);
						}
					});
					sftp.on("READDIR", (id, handle) => {
						const entry = of(handle);
						if (!entry || entry.listed) {
							sftp.status(id, STATUS_CODE.EOF);
							return;
						}
						entry.listed = true;
						const names = [...disk.files.keys()]
							.filter(
								path =>
									path.startsWith(`${entry.path}/`) &&
									!path.slice(entry.path.length + 1).includes("/"),
							)
							.map(path => path.slice(entry.path.length + 1));
						sftp.name(
							id,
							names.map(name => ({ filename: name, longname: name, attrs: {} as never })),
						);
					});
				});
			});
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as AddressInfo).port,
		fingerprint,
		close: () => {
			for (const client of clients) {
				client.end();
			}
			server.close();
		},
	};
}

describe("sftp-ssh2 => against a real SFTP server", function () {
	this.timeout(30000);

	const settings = (port: number, extra: Partial<RemoteBackupSettings> = {}): RemoteBackupSettings => ({
		enabled: true,
		host: "127.0.0.1",
		port,
		username: "backup",
		password: "secret",
		directory: "/backups/time-tracker",
		...extra,
	});
	const backup = { name: "time-tracker-2026-10-12T08-00-00.sqlite", data: Buffer.alloc(200_000, 7) };

	let disk: Disk;
	let server: Awaited<ReturnType<typeof startServer>>;
	beforeEach(async () => {
		disk = { files: new Map(), directories: new Set(["/"]) };
		server = await startServer(disk);
	});
	afterEach(() => server.close());

	it("copies a backup of several chunks, creating the directories", async () => {
		const result = await copyBackupToRemote(connectSsh2, settings(server.port), backup, quiet, timers);
		expect(result).to.deep.include({
			ok: true,
			remoteFile: "/backups/time-tracker/time-tracker-2026-10-12T08-00-00.sqlite",
		});
		expect(disk.files.get(result.remoteFile!)!.equals(backup.data)).to.equal(true);
		expect(disk.directories.has("/backups/time-tracker")).to.equal(true);
		expect([...disk.files.keys()].some(path => path.endsWith(".part"))).to.equal(false);
	});

	it("accepts the right fingerprint and refuses another one before the password is used", async () => {
		const right = await copyBackupToRemote(
			connectSsh2,
			settings(server.port, { hostKey: server.fingerprint }),
			backup,
			quiet,
			timers,
		);
		expect(right.ok).to.equal(true);

		const wrong = await copyBackupToRemote(
			connectSsh2,
			settings(server.port, { hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
			backup,
			quiet,
			timers,
		);
		expect(wrong.ok).to.equal(false);
		expect(wrong.message).to.contain("does not match");
		expect(wrong.message).to.contain(server.fingerprint);
	});

	it("reports a wrong password", async () => {
		const result = await copyBackupToRemote(
			connectSsh2,
			settings(server.port, { password: "wrong" }),
			backup,
			quiet,
			timers,
		);
		expect(result.ok).to.equal(false);
		expect(result.message).to.match(/authentication/i);
	});

	it("reports a server that is not there", async () => {
		const port = server.port;
		server.close();
		const result = await copyBackupToRemote(connectSsh2, settings(port), backup, quiet, timers);
		expect(result.ok).to.equal(false);
	});

	it("tidies up the old automatic copies and leaves the rest", async () => {
		for (const name of [
			"time-tracker-2026-10-09T08-00-00.sqlite",
			"time-tracker-2026-10-10T08-00-00.sqlite",
			"other.txt",
		]) {
			disk.files.set(`/backups/time-tracker/${name}`, Buffer.from("x"));
		}
		disk.directories.add("/backups");
		disk.directories.add("/backups/time-tracker");
		const result = await copyBackupToRemote(connectSsh2, settings(server.port, { keep: 2 }), backup, quiet, timers);
		expect(result.ok).to.equal(true);
		expect(result.deleted).to.deep.equal(["time-tracker-2026-10-09T08-00-00.sqlite"]);
		expect(disk.files.has("/backups/time-tracker/other.txt")).to.equal(true);
	});

	it("removes the half file of an interrupted earlier upload", async () => {
		disk.directories.add("/backups");
		disk.directories.add("/backups/time-tracker");
		disk.files.set("/backups/time-tracker/time-tracker-2026-10-11T08-00-00.sqlite.part", Buffer.from("half"));
		const result = await copyBackupToRemote(connectSsh2, settings(server.port), backup, quiet, timers);
		expect(result.ok).to.equal(true);
		expect(result.partialsRemoved).to.deep.equal(["time-tracker-2026-10-11T08-00-00.sqlite.part"]);
		expect([...disk.files.keys()]).to.deep.equal(["/backups/time-tracker/time-tracker-2026-10-12T08-00-00.sqlite"]);
	});

	it("tests the connection and shows the fingerprint", async () => {
		const result = await testRemoteConnection(connectSsh2, settings(server.port), timers);
		expect(result).to.deep.include({ ok: true, fingerprint: server.fingerprint });
		expect([...disk.files.keys()]).to.deep.equal([]);
	});
});
