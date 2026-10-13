/**
 * The real SFTP connection for `remote-backup.ts`, made with the `ssh2` library (pure JavaScript, no
 * subprocess, no mount).
 */
import { Client, type SFTPWrapper } from "ssh2";
import { hexToFingerprint, hostKeyMatches, type SftpConnector, type SftpSession } from "./remoteBackup";

/** Longest time the server may take to answer the SSH handshake. */
const READY_TIMEOUT_MS = 20_000;

// Calls an SFTP method that reports through a node-style callback.
function call<T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
	return new Promise((resolve, reject) => {
		run((error, value) => (error ? reject(error) : resolve(value as T)));
	});
}

// The session on top of an opened SFTP channel.
function sessionOf(client: Client, sftp: SFTPWrapper): SftpSession {
	return {
		async makeDirectories(directory: string): Promise<void> {
			const absolute = directory.startsWith("/");
			let current = absolute ? "" : ".";
			for (const part of directory.split("/").filter(Boolean)) {
				current = current === "." ? part : `${current}/${part}`;
				const path = absolute && !current.startsWith("/") ? `/${current}` : current;
				try {
					await call<unknown>(done => sftp.stat(path, done));
				} catch {
					// missing: create it (a failure here is a real one, e.g. no permission)
					await call<void>(done => sftp.mkdir(path, done));
				}
			}
		},
		writeFile: (path, data) => call<void>(done => sftp.writeFile(path, data, done)),
		size: async path => (await call<{ size: number }>(done => sftp.stat(path, done))).size,
		rename: (from, to) => call<void>(done => sftp.rename(from, to, done)),
		list: async directory =>
			(await call<{ filename: string }[]>(done => sftp.readdir(directory, done))).map(entry => entry.filename),
		remove: path => call<void>(done => sftp.unlink(path, done)),
		close: () => {
			client.end();
		},
	};
}

/**
 * Connects to an SFTP server with user name and password.
 *
 * A fingerprint entered in the settings is checked while the connection is made: a different server is refused
 * before the password is sent.
 *
 * @param settings - Server, login and the expected host key fingerprint.
 */
export const connectSsh2: SftpConnector = settings =>
	new Promise<SftpSession>((resolve, reject) => {
		const client = new Client();
		let refused: Error | undefined;
		client.on("ready", () => {
			client.sftp((error, sftp) => {
				if (error) {
					client.end();
					reject(error);
					return;
				}
				resolve(sessionOf(client, sftp));
			});
		});
		client.on("error", error => {
			reject(refused ?? error);
		});
		client.on("close", () => {
			reject(refused ?? new Error("the server closed the connection"));
		});
		client.connect({
			host: settings.host,
			port: settings.port,
			username: settings.username,
			password: settings.password,
			readyTimeout: READY_TIMEOUT_MS,
			keepaliveInterval: 15_000,
			hostHash: "sha256",
			hostVerifier: (hash: string): boolean => {
				settings.onHostKey(hexToFingerprint(hash));
				if (hostKeyMatches(settings.hostKey, hash)) {
					return true;
				}
				refused = new Error(
					`the host key of the server does not match the fingerprint in the settings (the server shows ${hexToFingerprint(hash)})`,
				);
				return false;
			},
		});
	});
