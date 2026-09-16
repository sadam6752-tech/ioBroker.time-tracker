/**
 * Session secret of the instance.
 *
 * The secret signs the CSRF tokens that every write of the web app carries (see `services/auth.ts`). A value
 * configured in the instance settings always wins. Without one the adapter generates a value on the first start and
 * stores it next to the database, so a restart no longer invalidates the CSRF tokens of clients that are already
 * open. The secret itself never leaves the server: a client only ever sees a token derived from it.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Name of the file that holds a generated secret (next to the database). */
export const SECRET_FILE_NAME = "session-secret";

/** Shortest usable secret: a generated value has 43 characters, so a much shorter file is broken. */
export const MIN_SECRET_LENGTH = 16;

/** Source of the secret. */
export type SessionSecretSource = "configured" | "stored" | "generated";

/** Result of {@link resolveSessionSecret}. */
export interface ResolvedSessionSecret {
	/** Secret used to sign CSRF tokens */
	secret: string;
	/** `configured` = instance settings, `stored` = generated earlier, `generated` = created by this call */
	source: SessionSecretSource;
	/** File a generated secret lives in, `null` when the secret is only valid for this run */
	file: string | null;
	/** Set when a generated secret could not be stored (it then only lasts for this run) */
	error?: string;
}

/**
 * Generates a secret.
 *
 * @returns 32 random bytes as base64url (the same shape the device tokens of the terminals have)
 */
export function generateSecret(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Reads a stored secret.
 *
 * @param file - file that may hold a secret
 * @returns the secret, or `null` when the file is missing, empty or too short
 */
export function readStoredSecret(file: string): string | null {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch {
		// a missing file (or a directory the adapter cannot read) simply means “nothing stored yet”
		return null;
	}

	const secret = content.trim();
	return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/**
 * Stores a secret for the following starts.
 *
 * The file is written through a temporary one, so an interrupted start cannot leave half a secret behind. It is
 * created for the account that runs ioBroker only; on Windows the mode only marks it read-only.
 *
 * @param file - file to write
 * @param secret - secret to store
 */
export function writeStoredSecret(file: string, secret: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	fs.writeFileSync(temporary, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// Windows does not know POSIX modes; the write above is what matters there
	}
}

/**
 * Resolves the secret of the instance: a configured value wins, then a stored one, otherwise a new one is generated
 * and stored for the next start.
 *
 * @param input - configured value and the file a generated secret is kept in
 * @param input.configured - value from the instance settings (empty = not configured)
 * @param input.file - file used for a generated secret
 * @returns the secret, its source and the file it lives in
 */
export function resolveSessionSecret(input: { configured?: string | null; file: string }): ResolvedSessionSecret {
	const configured = (input.configured ?? "").trim();
	if (configured) {
		return { secret: configured, source: "configured", file: null };
	}

	const stored = readStoredSecret(input.file);
	if (stored) {
		return { secret: stored, source: "stored", file: input.file };
	}

	const secret = generateSecret();
	try {
		writeStoredSecret(input.file, secret);
		return { secret, source: "generated", file: input.file };
	} catch (error) {
		return {
			secret,
			source: "generated",
			file: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
