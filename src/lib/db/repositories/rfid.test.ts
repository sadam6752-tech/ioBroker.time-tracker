/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createUsersRepository, type UsersRepository } from "./users";
import { buildTagToken, createRfidRepository, newTagUid, parseTagToken, signTag, type RfidRepository } from "./rfid";

const SECRET = "test-secret";

describe("rfid repository", () => {
	let db: Db;
	let users: UsersRepository;
	let repo: RfidRepository;
	let annaId: number;
	let adminId: number;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		repo = createRfidRepository(db);
		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
	});

	afterEach(() => {
		db.close();
	});

	/**
	 * Creates a signed tag for the test user.
	 *
	 * @param options - optional overrides
	 * @param options.expiresIn - seconds the tag stays valid (0 = never expires)
	 * @param options.signature - signature to store instead of the correct one
	 * @returns tag, token and payload
	 */
	function signedTag(options: { expiresIn?: number; signature?: string } = {}): {
		tagId: number;
		token: string;
		uid: string;
		expiresAt: number;
	} {
		const uid = newTagUid();
		const expiresAt = options.expiresIn === 0 ? 0 : 1000 + (options.expiresIn ?? 3600);
		const signature = options.signature ?? signTag(SECRET, uid, annaId, expiresAt);
		const tag = repo.create({
			uid,
			userId: annaId,
			signature,
			label: "Schlüsselbund",
			expiresAt: options.expiresIn === 0 ? null : expiresAt,
			actorId: adminId,
			now: 1000,
		});
		return { tagId: tag.id, token: buildTagToken(uid, annaId, expiresAt, signature), uid, expiresAt };
	}

	it("creates a tag without ever handing out the signature", () => {
		const { tagId, uid } = signedTag();

		const tag = repo.findById(tagId);
		expect(tag).to.deep.include({ uid, userId: annaId, label: "Schlüsselbund", isActive: true });
		expect(Object.keys(tag ?? {})).to.not.include("tokenHash");
		expect(JSON.stringify(tag)).to.not.contain(SECRET);

		// the signature is stored, but the audit trail only names the tag
		const row = db.prepare("SELECT token_hash FROM rfid_tags WHERE id = ?").get(tagId) as { token_hash: string };
		expect(row.token_hash).to.equal(signTag(SECRET, uid, annaId, 1000 + 3600));
		const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'rfid.create'").get() as {
			detail: string;
		};
		expect(audit.detail).to.not.contain(row.token_hash);

		expect(repo.list().map(entry => entry.uid)).to.deep.equal([uid]);
	});

	it("verifies signature, owner and expiry", () => {
		const { uid, expiresAt, tagId } = signedTag();

		expect(
			repo.verify({ uid, userId: annaId, signature: signTag(SECRET, uid, annaId, expiresAt), now: 1000 })?.id,
		).to.equal(tagId);
		// a forged signature, another owner or an expired instant are all refused
		expect(repo.verify({ uid, userId: annaId, signature: "gefaelscht", now: 1000 })).to.equal(null);
		expect(
			repo.verify({ uid, userId: adminId, signature: signTag(SECRET, uid, adminId, expiresAt), now: 1000 }),
		).to.equal(null);
		expect(
			repo.verify({ uid, userId: annaId, signature: signTag(SECRET, uid, annaId, expiresAt), now: 99999 }),
		).to.equal(null);
		expect(repo.verify({ uid: "unbekannt", userId: annaId, signature: "x", now: 1000 })).to.equal(null);

		// a tag without expiry stays valid
		const forever = signedTag({ expiresIn: 0 });
		expect(
			repo.verify({
				uid: forever.uid,
				userId: annaId,
				signature: signTag(SECRET, forever.uid, annaId, forever.expiresAt),
				now: 999999,
			}),
		).to.not.equal(null);
	});

	it("records the last use and can be revoked", () => {
		const { uid, expiresAt, tagId } = signedTag();
		const signature = signTag(SECRET, uid, annaId, expiresAt);

		repo.touch({ id: tagId, now: 2000 });
		expect(repo.findById(tagId)?.lastUsedAt).to.equal(2000);

		expect(repo.revoke({ id: tagId, actorId: adminId, now: 3000 })).to.equal(true);
		expect(repo.verify({ uid, userId: annaId, signature, now: 3000 })).to.equal(null);
		expect(repo.list()).to.have.lengthOf(0);
		expect(repo.list({ includeInactive: true })).to.have.lengthOf(1);
		expect(repo.revoke({ id: tagId, actorId: adminId })).to.equal(false);
	});

	it("rejects impossible input and malformed tokens", () => {
		expect(() => repo.create({ uid: "  ", userId: annaId, signature: "x", actorId: adminId })).to.throw(
			/uid is required/,
		);
		expect(() => repo.create({ uid: "a", userId: annaId, signature: "", actorId: adminId })).to.throw(
			/signature is required/,
		);
		expect(() =>
			repo.create({ uid: "a", userId: annaId, signature: "x", expiresAt: -1, actorId: adminId }),
		).to.throw(/expiresAt must be/);

		const { token } = signedTag();
		const parsed = parseTagToken(token);
		expect(parsed?.userId).to.equal(annaId);
		expect(parsed?.expiresAt).to.be.greaterThan(0);
		expect(parsed?.signature).to.have.length.greaterThan(10);
		expect(parseTagToken("nur.ein.wort")).to.equal(null);
		expect(parseTagToken("a.keine-zahl.1.2")).to.equal(null);
		expect(parseTagToken("")).to.equal(null);
	});
});
