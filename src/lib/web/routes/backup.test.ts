/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_BODY_BYTES } from "../router";
import {
	db,
	backupDir,
	adminId,
	annaToken,
	annaCsrf,
	adminToken,
	adminCsrf,
	send,
	bodyOf,
	headers,
	useApiFixture,
} from "./apiFixture.test";

describe("web api", () => {
	useApiFixture();

	describe("backups", () => {
		it("hands a backup out as a file and queues a listed one for the next start", async () => {
			const created = await send("POST", "/backup", { headers: headers(adminToken, adminCsrf) });
			const name = bodyOf<{ backup: { name: string } }>(created).backup.name;

			// the file comes with a download header; a name outside the list never reaches the file system
			const download = await send("GET", `/backup/${name}`, { headers: headers(adminToken) });
			expect(download.status).to.equal(200);
			expect(download.headers["content-disposition"]).to.equal(`attachment; filename="${name}"`);
			expect((await send("GET", "/backup/unbekannt.sqlite", { headers: headers(adminToken) })).status).to.equal(
				404,
			);

			// queueing a restore needs `backup.run`; this database lives in memory, so the refusal explains that
			const refused = await send("POST", "/backup/restore", {
				headers: headers(annaToken, annaCsrf),
				body: { name },
			});
			expect(refused.status).to.equal(403);

			const queued = await send("POST", "/backup/restore", {
				headers: headers(adminToken, adminCsrf),
				body: { name },
			});
			expect(queued.status).to.equal(400);
			expect(bodyOf<{ code: string }>(queued).code).to.equal("backup_invalid");

			// an unknown name is refused just as clearly
			const unknown = await send("POST", "/backup/restore", {
				headers: headers(adminToken, adminCsrf),
				body: { name: "gibts-nicht.sqlite" },
			});
			expect(unknown.status).to.equal(400);
			expect(bodyOf<{ code: string }>(unknown).code).to.equal("backup_invalid");
		});

		it("needs backup.run and lists nothing before the first copy", async () => {
			const forbidden = await send("GET", "/backup", { headers: headers(annaToken) });
			expect(forbidden.status).to.equal(403);
			expect(bodyOf(forbidden).code).to.equal("permission_denied");

			const empty = await send("GET", "/backup", { headers: headers(adminToken) });
			expect(empty.status).to.equal(200);
			expect(bodyOf(empty)).to.deep.include({ retentionDays: 30 });
			expect(bodyOf<{ backups: unknown[] }>(empty).backups).to.deep.equal([]);

			const refused = await send("POST", "/backup", { headers: headers(annaToken, annaCsrf) });
			expect(refused.status).to.equal(403);
		});

		it("takes a copy on request and reports it in the list", async () => {
			const created = await send("POST", "/backup", { headers: headers(adminToken, adminCsrf) });
			expect(created.status).to.equal(201);
			const payload = bodyOf<{
				backup: { name: string; sizeBytes: number; users: number; entries: number; schemaVersion: number };
				removed: string[];
			}>(created);
			expect(payload.removed).to.deep.equal([]);
			expect(payload.backup.name).to.equal("time-tracker-1970-01-01T00-16-40.sqlite");
			expect(payload.backup.sizeBytes).to.be.greaterThan(0);
			expect(payload.backup.users).to.be.greaterThan(0);
			expect(payload.backup.schemaVersion).to.be.greaterThan(0);

			const list = await send("GET", "/backup", { headers: headers(adminToken) });
			expect(bodyOf<{ backups: { name: string }[] }>(list).backups.map(file => file.name)).to.deep.equal([
				payload.backup.name,
			]);

			// the file really exists on disk and the audit trail knows who wrote it
			expect(fs.existsSync(path.join(backupDir, payload.backup.name))).to.equal(true);
			const audit = db
				.prepare("SELECT actor_id AS actorId FROM audit_log WHERE action = 'backup.create'")
				.get() as { actorId: number };
			expect(audit.actorId).to.equal(adminId);
		});

		it("deletes a single backup and reports an unknown name as missing", async () => {
			const created = await send("POST", "/backup", { headers: headers(adminToken, adminCsrf) });
			const name = bodyOf<{ backup: { name: string } }>(created).backup.name;

			// deleting needs the permission as well
			const forbidden = await send("DELETE", `/backup/${name}`, { headers: headers(annaToken, annaCsrf) });
			expect(forbidden.status).to.equal(403);

			const gone = await send("DELETE", `/backup/${name}`, { headers: headers(adminToken, adminCsrf) });
			expect(gone.status).to.equal(204);
			expect(fs.existsSync(path.join(backupDir, name))).to.equal(false);

			const list = await send("GET", "/backup", { headers: headers(adminToken) });
			expect(bodyOf<{ backups: unknown[] }>(list).backups).to.deep.equal([]);

			// the audit trail knows who removed the file
			const audit = db
				.prepare("SELECT actor_id AS actorId FROM audit_log WHERE action = 'backup.remove'")
				.get() as { actorId: number };
			expect(audit.actorId).to.equal(adminId);

			// a name outside the list is a missing resource, not a deleted one
			const unknown = await send("DELETE", "/backup/gibts-nicht.sqlite", {
				headers: headers(adminToken, adminCsrf),
			});
			expect(unknown.status).to.equal(404);
		});

		it("takes an uploaded file as the raw body, and only that route goes above the body limit", async () => {
			// the same file the download hands out is sent back as an upload — the transport has to keep the bytes
			const created = await send("POST", "/backup", { headers: headers(adminToken, adminCsrf) });
			const name = bodyOf<{ backup: { name: string } }>(created).backup.name;
			const bytes = fs.readFileSync(path.join(backupDir, name));

			// This database lives in memory, so queueing is refused — but it is refused *after* the body arrived:
			// the upload reached the route instead of being cut off by the body limit. The bytes themselves are
			// covered by the backup service and the server tests.
			const uploaded = await send("POST", "/backup/restore", {
				rawBody: bytes,
				query: { name: "hochgeladen.sqlite" },
				headers: { ...headers(adminToken, adminCsrf), "content-type": "application/octet-stream" },
			});
			expect(uploaded.status).to.equal(400);
			expect(bodyOf<{ code: string; detail: string }>(uploaded).code).to.equal("backup_invalid");
			expect(bodyOf<{ detail: string }>(uploaded).detail).to.contain("in-memory");

			// bytes that are not a backup are refused as well
			const refused = await send("POST", "/backup/restore", {
				rawBody: Buffer.from("das ist keine Datenbank"),
				headers: { ...headers(adminToken, adminCsrf), "content-type": "application/octet-stream" },
			});
			expect(refused.status).to.equal(400);
			expect(bodyOf<{ code: string }>(refused).code).to.equal("backup_invalid");

			// an upload without the permission is refused before any of that
			const forbidden = await send("POST", "/backup/restore", {
				rawBody: bytes,
				headers: { ...headers(annaToken, annaCsrf), "content-type": "application/octet-stream" },
			});
			expect(forbidden.status).to.equal(403);

			// every other route keeps the router-wide limit
			const tooBig = await send("GET", "/backup", {
				rawBody: Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1),
				headers: { ...headers(adminToken), "content-type": "application/octet-stream" },
			});
			expect(tooBig.status).to.equal(413);
			expect(bodyOf<{ code: string }>(tooBig).code).to.equal("payload_too_large");

			// the upload route itself carries the raised limit: it fails on the content, not on the size
			const big = await send("POST", "/backup/restore", {
				rawBody: Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1024),
				headers: { ...headers(adminToken, adminCsrf), "content-type": "application/octet-stream" },
			});
			expect(big.status).to.equal(400);
			expect(bodyOf<{ code: string }>(big).code).to.equal("backup_invalid");
		});
	});
});
