/**
 * Backups: list, download, create, restore and delete.
 */

import * as fs from "node:fs";

import { NotFoundError, ValidationError } from "../../errors";
import { problem } from "../problem";
import { json, noContent, binary } from "../router";

import type { ApiContext } from "./context";
import { MAX_BACKUP_UPLOAD_BYTES } from "./shared";

/**
 * Registers the routes of this area.
 *
 * @param ctx - context of the API
 */
export function registerBackupRoutes(ctx: ApiContext): void {
	const { deps, settings, emit, route } = ctx;

	// backups (administration); the read side lists what exists, the write side takes a new copy

	if (deps.backup) {
		const backup = deps.backup;

		route("GET", "/backup", { permission: "backup.run" }, () =>
			json(200, {
				retentionDays: settings.getNumber("backup_retention_days", 30),
				backups: backup.list(),
				// a restore that waits for the next start, so the screen can say so
				pending: backup.pending(),
			}),
		);

		route("GET", "/backup/:name", { permission: "backup.run" }, context => {
			// only files the service knows are served: the requested name never reaches the file system
			const wanted = context.params.name;
			const file = backup.list().find(entry => entry.name === wanted);
			if (!file) {
				throw new NotFoundError(`backup ${wanted} not found`);
			}
			return binary(200, fs.readFileSync(file.file), "application/vnd.sqlite3", {
				"content-disposition": `attachment; filename="${file.name}"`,
				"cache-control": "no-store",
			});
		});

		route(
			"POST",
			"/backup",
			{ permission: "backup.run", csrf: true, rateLimit: { name: "backup", limit: 10, windowSeconds: 60 } },
			context => {
				const created = backup.create({
					actorId: context.auth?.user.id ?? null,
					reason: "api",
				});
				emit({ type: "backup.create", userId: null, data: { backup: created.backup.name } });
				return json(201, { backup: created.backup, removed: created.removed });
			},
		);

		// A single backup is removed by hand; the retention keeps doing its own job in the background. Only files
		// of the list are deleted, so the requested name never reaches the file system.
		route(
			"DELETE",
			"/backup/:name",
			{ permission: "backup.run", csrf: true, rateLimit: { name: "backup", limit: 10, windowSeconds: 60 } },
			context => {
				try {
					backup.remove(context.params.name, { actorId: context.auth?.user.id ?? null, reason: "api" });
				} catch (error) {
					if (error instanceof ValidationError) {
						// a name that is not in the list is a missing resource, not a bad request
						throw new NotFoundError(error.message);
					}
					throw error;
				}
				return noContent(204);
			},
		);

		// One of the listed backups is queued for the next start: the swap itself happens while the adapter starts,
		// because a restore needs a closed database (see `restore` in the backup service). Only files of the list are
		// accepted, so the requested name never reaches the file system.
		//
		// The same route takes an uploaded file — the way back for a machine that lost its data directory. The browser
		// sends the chosen file as the raw body (`application/octet-stream`), everything else stays JSON with the name
		// of a listed backup. An upload is the only request that may exceed the router-wide body limit, so the route
		// raises it for itself (`MAX_BACKUP_UPLOAD_BYTES`; the server reads with the same bound).
		route(
			"POST",
			"/backup/restore",
			{
				permission: "backup.run",
				csrf: true,
				rateLimit: { name: "backup", limit: 10, windowSeconds: 60 },
				maxBodyBytes: MAX_BACKUP_UPLOAD_BYTES,
			},
			context => {
				const upload = (context.header("content-type") ?? "")
					.toLowerCase()
					.startsWith("application/octet-stream");
				try {
					if (upload) {
						// the file itself travels as the body; name and reason are query parameters
						const pending = backup.queueRestore(context.rawBody(), {
							name: context.query("name") ?? undefined,
							actorId: context.auth?.user.id ?? null,
							reason: context.query("reason") ?? undefined,
						});
						return json(201, { pending });
					}

					const body = context.jsonBody();
					const name = typeof body.name === "string" ? body.name.trim() : "";
					if (name === "") {
						throw problem(400, "backup_invalid", "the request needs `name` with one of the listed backups");
					}
					const pending = backup.queueExistingBackup(name, {
						actorId: context.auth?.user.id ?? null,
						reason: typeof body.reason === "string" ? body.reason : undefined,
					});
					return json(201, { pending });
				} catch (error) {
					if (error instanceof ValidationError) {
						// the file is not a backup of this adapter: the message says what is wrong with it
						throw problem(400, "backup_invalid", error.message);
					}
					throw error;
				}
			},
		);
	}
}
