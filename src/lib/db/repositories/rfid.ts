/**
 * RFID/NFC tags (`rfid_tags`).
 *
 * A tag is a **signed deep link**: `uid.userId.exp.signature`, where the signature is
 * `HMAC-SHA256(hmacSecret, "uid.userId.exp")`. That way a tag needs no login on the scanning phone, cannot be
 * guessed (a forged payload fails the signature) and can be revoked or given an expiry. The stored `token_hash`
 * is the signature itself; the extra `uid` row keeps the lookup cheap and lets a tag be revoked individually.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../database";
import { ValidationError } from "../../errors";
import { writeAuditLog } from "./audit";

/** A tag as it is stored (without the signature). */
export interface RfidTagRecord {
	/** Primary key */
	id: number;
	/** Identifier of the tag (`uid` of the NFC tag or a generated value) */
	uid: string;
	/** Owner of the tag, `null` after the user was deleted */
	userId: number | null;
	/** Free-form label */
	label: string | null;
	/** False for revoked tags */
	isActive: boolean;
	/** Instant the tag stops working, `null` = never */
	expiresAt: number | null;
	/** Instant of the last scan, `null` if never used */
	lastUsedAt: number | null;
	/** Instant of creation, UTC epoch seconds */
	createdAt: number;
}

/** Tag storage operations. */
export interface RfidRepository {
	/** Creates a tag and audits it (the signature is never written to the audit trail) */
	create(input: {
		uid: string;
		userId: number;
		signature: string;
		label?: string | null;
		/** Instant the tag stops working, `null` = never */
		expiresAt?: number | null;
		actorId: number;
		actorIp?: string | null;
		now?: number;
	}): RfidTagRecord;
	/** All tags, optionally including the revoked ones */
	list(options?: { includeInactive?: boolean }): RfidTagRecord[];
	/** Reads a tag by id */
	findById(id: number): RfidTagRecord | null;
	/** Checks a scanned token and returns the tag when signature, activity, owner and expiry match */
	verify(input: { uid: string; userId: number; signature: string; now?: number }): RfidTagRecord | null;
	/** Records a successful scan */
	touch(input: { id: number; now?: number }): void;
	/** Revokes a tag */
	revoke(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean;
}

/**
 * Creates a random tag identifier.
 *
 * @returns base64url encoded identifier
 */
export function newTagUid(): string {
	return randomBytes(16).toString("base64url");
}

/**
 * Signs a tag payload.
 *
 * @param secret - instance secret (`hmacSecret`)
 * @param uid - tag identifier
 * @param userId - owner of the tag
 * @param expiresAt - expiry of the payload, UTC epoch seconds
 * @returns base64url encoded signature
 */
export function signTag(secret: string, uid: string, userId: number, expiresAt: number): string {
	return createHmac("sha256", secret).update(`${uid}.${userId}.${expiresAt}`).digest("base64url");
}

/**
 * Builds the token a tag carries.
 *
 * @param uid - tag identifier
 * @param userId - owner of the tag
 * @param expiresAt - expiry of the payload
 * @param signature - signature of the payload
 * @returns the token
 */
export function buildTagToken(uid: string, userId: number, expiresAt: number, signature: string): string {
	return `${uid}.${userId}.${expiresAt}.${signature}`;
}

/**
 * Splits a scanned token.
 *
 * @param token - token from the deep link or the QR code
 * @returns the parsed payload or `null` when the token is malformed
 */
export function parseTagToken(
	token: string,
): { uid: string; userId: number; expiresAt: number; signature: string } | null {
	const parts = token.trim().split(".");
	if (parts.length !== 4) {
		return null;
	}
	const [uid, rawUserId, rawExpires, signature] = parts;
	const userId = Number(rawUserId);
	const expiresAt = Number(rawExpires);
	if (!uid || !signature || !Number.isInteger(userId) || !Number.isInteger(expiresAt)) {
		return null;
	}
	return { uid, userId, expiresAt, signature };
}

/**
 * Compares two signatures without leaking the position of the first difference.
 *
 * @param expected - signature computed by the server
 * @param received - signature from the token
 * @returns true when both are identical
 */
export function sameSignature(expected: string, received: string): boolean {
	const left = Buffer.from(expected);
	const right = Buffer.from(received);
	return left.length === right.length && timingSafeEqual(left, right);
}

interface RfidRow {
	id: number;
	uid: string;
	token_hash: string;
	user_id: number | null;
	label: string | null;
	is_active: number;
	expires_at: number | null;
	last_used_at: number | null;
	created_at: number;
}

const TAG_COLUMNS = `id, uid, token_hash, user_id, label, is_active, expires_at, last_used_at, created_at`;

/**
 * Maps a database row to a tag record (the signature stays inside the repository).
 *
 * @param row - raw database row
 * @returns tag record
 */
function mapTagRow(row: RfidRow): RfidTagRecord {
	return {
		id: row.id,
		uid: row.uid,
		userId: row.user_id,
		label: row.label,
		isActive: row.is_active !== 0,
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
		createdAt: row.created_at,
	};
}

/**
 * Creates the tag repository.
 *
 * @param db - open database handle
 * @returns repository instance
 */
export function createRfidRepository(db: Db): RfidRepository {
	const insertTag = db.prepare(
		`INSERT INTO rfid_tags (uid, token_hash, user_id, label, is_active, expires_at, created_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?)`,
	);
	const selectById = db.prepare(`SELECT ${TAG_COLUMNS} FROM rfid_tags WHERE id = ?`);
	const selectByUid = db.prepare(`SELECT ${TAG_COLUMNS} FROM rfid_tags WHERE uid = ?`);
	const selectAll = db.prepare(`SELECT ${TAG_COLUMNS} FROM rfid_tags ORDER BY created_at DESC, id DESC`);
	const selectActive = db.prepare(
		`SELECT ${TAG_COLUMNS} FROM rfid_tags WHERE is_active = 1 ORDER BY created_at DESC, id DESC`,
	);
	const updateLastUsed = db.prepare("UPDATE rfid_tags SET last_used_at = ? WHERE id = ?");
	const deactivate = db.prepare("UPDATE rfid_tags SET is_active = 0 WHERE id = ?");

	/**
	 * Reads a tag.
	 *
	 * @param id - tag id
	 * @returns tag or `null`
	 */
	const read = (id: number): RfidTagRecord | null => {
		const row = selectById.get(id) as RfidRow | undefined;
		return row ? mapTagRow(row) : null;
	};

	return {
		create(input: {
			uid: string;
			userId: number;
			signature: string;
			label?: string | null;
			expiresAt?: number | null;
			actorId: number;
			actorIp?: string | null;
			now?: number;
		}): RfidTagRecord {
			const uid = input.uid.trim();
			if (!uid) {
				throw new ValidationError("uid is required");
			}
			// the caller passes the expiry it signed, so the stored value and the token cannot drift apart
			const expiresAt = input.expiresAt ?? null;
			if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= 0)) {
				throw new ValidationError(`expiresAt must be a positive instant (got ${input.expiresAt})`);
			}
			if (!input.signature) {
				throw new ValidationError("signature is required");
			}

			const now = input.now ?? Math.floor(Date.now() / 1000);

			let tagId = 0;
			const run = db.transaction((): void => {
				const result = insertTag.run(uid, input.signature, input.userId, input.label ?? null, expiresAt, now);
				tagId = Number(result.lastInsertRowid);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "rfid.create",
					entity: "rfid_tag",
					entityId: tagId,
					// the signature is a credential and never part of the audit trail
					detail: { uid, userId: input.userId, label: input.label ?? null, expiresAt },
					ip: input.actorIp ?? null,
				});
			});
			run();

			const tag = read(tagId);
			if (!tag) {
				throw new Error(`tag ${tagId} disappeared right after creation`);
			}
			return tag;
		},

		list(options?: { includeInactive?: boolean }): RfidTagRecord[] {
			const rows = (options?.includeInactive === true ? selectAll : selectActive).all() as RfidRow[];
			return rows.map(mapTagRow);
		},

		findById: read,

		verify(input: { uid: string; userId: number; signature: string; now?: number }): RfidTagRecord | null {
			const row = selectByUid.get(input.uid.trim()) as RfidRow | undefined;
			if (!row) {
				return null;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const tag = mapTagRow(row);
			if (!tag.isActive) {
				return null;
			}
			// an expired tag (or payload) is worthless even when the signature is correct
			if (tag.expiresAt !== null && tag.expiresAt <= now) {
				return null;
			}
			if (tag.userId !== input.userId) {
				return null;
			}
			// the stored signature has to match the signature of the scanned payload
			return sameSignature(row.token_hash, input.signature) ? tag : null;
		},

		touch(input: { id: number; now?: number }): void {
			updateLastUsed.run(input.now ?? Math.floor(Date.now() / 1000), input.id);
		},

		revoke(input: { id: number; actorId: number; actorIp?: string | null; now?: number }): boolean {
			const tag = read(input.id);
			if (!tag || !tag.isActive) {
				return false;
			}
			const now = input.now ?? Math.floor(Date.now() / 1000);
			const run = db.transaction((): void => {
				deactivate.run(input.id);
				writeAuditLog(db, {
					atUtc: now,
					actorId: input.actorId,
					action: "rfid.revoke",
					entity: "rfid_tag",
					entityId: input.id,
					detail: { uid: tag.uid, userId: tag.userId },
					ip: input.actorIp ?? null,
				});
			});
			run();
			return true;
		},
	};
}
