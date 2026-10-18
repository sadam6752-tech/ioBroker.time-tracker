/// <reference types="mocha" />
import { expect } from "chai";
import {
	absences,
	holidays,
	triggers,
	automations,
	hookCalls,
	settings,
	annaId,
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

	describe("master data", () => {
		it("lists absence types and keeps them with the matching permission", async () => {
			const list = await send("GET", "/absence-types", { headers: headers(annaToken) });
			expect(list.status).to.equal(200);
			const types = bodyOf<{ types: { code: string; name: string; factor: number }[] }>(list).types;
			expect(types.map(type => type.code)).to.include("F");
			expect(types.find(type => type.code === "W")?.factor).to.equal(50);

			// managing types needs `absence.manage_types`
			expect(
				(
					await send("POST", "/absence-types", {
						body: { code: "S", name: "Sonderurlaub" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("POST", "/absence-types", {
				body: { code: "S", name: "Sonderurlaub", factor: 100 },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			expect(bodyOf(created)).to.deep.include({ created: true });
			expect(bodyOf<{ type: { code: string; name: string } }>(created).type).to.deep.include({
				code: "S",
				name: "Sonderurlaub",
			});

			// the same code updates the existing type instead of creating a second one
			const updated = await send("POST", "/absence-types", {
				body: { code: "s", name: "Sonderurlaub bezahlt" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(updated.status).to.equal(200);
			expect(bodyOf(updated)).to.deep.include({ created: false });
			expect(bodyOf<{ type: { name: string } }>(updated).type.name).to.equal("Sonderurlaub bezahlt");
			expect(absences.types().filter(type => type.code === "S")).to.have.lengthOf(1);

			// a code that is not a short key is refused
			expect(
				(
					await send("POST", "/absence-types", {
						body: { code: "zu lang!", name: "X" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
		});

		it("lists, adds and removes holidays", async () => {
			const seeded = await send("GET", "/holidays", { headers: headers(annaToken), query: { year: "2026" } });
			expect(seeded.status).to.equal(200);
			expect(bodyOf<{ holidays: unknown[] }>(seeded).holidays.length).to.be.greaterThan(0);

			// the year is required and the calendar is an administrative topic
			expect((await send("GET", "/holidays", { headers: headers(annaToken) })).status).to.equal(400);
			expect(
				(
					await send("POST", "/holidays", {
						body: { date: "2026-06-01", name: "Brückentag" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("POST", "/holidays", {
				body: { date: "2026-06-01", name: "Brückentag" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const holidayId = bodyOf<{ holiday: { id: number; year: number } }>(created).holiday.id;
			expect(created.headers.location).to.equal(`/holidays/${holidayId}`);

			const listed = await send("GET", "/holidays", { headers: headers(adminToken), query: { year: "2026" } });
			expect(
				bodyOf<{ holidays: { date: string }[] }>(listed).holidays.some(
					holiday => holiday.date === "2026-06-01",
				),
			).to.equal(true);

			const removed = await send("DELETE", `/holidays/${holidayId}`, {
				headers: headers(adminToken, adminCsrf),
			});
			expect(removed.status).to.equal(204);
			expect(
				(await send("DELETE", `/holidays/${holidayId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(404);

			// a holiday without a region belongs to the country of the instance — the calculation looks only there
			settings.set("holiday_country", "CH", adminId);
			const swiss = await send("POST", "/holidays", {
				body: { date: "2026-05-02", name: "Brückentag" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(swiss.status).to.equal(201);
			expect(bodyOf<{ holiday: { region: string } }>(swiss).holiday.region).to.equal("CH");
			expect(holidays.isHoliday("2026-05-02", "CH")).to.equal(true);
		});

		it("reads and changes instance settings through a whitelist", async () => {
			// `settings.view` and `settings.edit` are administrative rights
			expect((await send("GET", "/settings", { headers: headers(annaToken) })).status).to.equal(403);

			const read = await send("GET", "/settings", { headers: headers(adminToken) });
			expect(read.status).to.equal(200);
			expect(bodyOf<{ settings: Record<string, string> }>(read).settings).to.have.property("quick_round_minutes");

			const changed = await send("PUT", "/settings", {
				body: { quick_round_minutes: 15, absence_calc_until_today: false },
				headers: headers(adminToken, adminCsrf),
			});
			expect(changed.status).to.equal(200);
			expect(settings.get("quick_round_minutes")).to.equal("15");
			expect(settings.get("absence_calc_until_today")).to.equal("false");

			// unknown keys, unsupported values and an empty body are client errors
			expect(
				(await send("PUT", "/settings", { body: { unbekannt: "1" }, headers: headers(adminToken, adminCsrf) }))
					.status,
			).to.equal(400);
			expect(
				(
					await send("PUT", "/settings", {
						body: { edit_window_days: { a: 1 } },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			// the pause mode knows three values and refuses everything else
			const mode = await send("PUT", "/settings", {
				body: { pause_mode: "punched" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(mode.status).to.equal(200);
			expect(settings.get("pause_mode")).to.equal("punched");
			expect(
				(
					await send("PUT", "/settings", {
						body: { pause_mode: "manchmal" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(await send("PUT", "/settings", { body: {}, headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(400);

			// values that look like secrets are never handed out
			settings.set("session_secret", "geheim", adminId);
			const filtered = await send("GET", "/settings", { headers: headers(adminToken) });
			expect(bodyOf<{ settings: Record<string, string> }>(filtered).settings).to.not.have.property(
				"session_secret",
			);
		});

		it("replaces the graduated break rules", async () => {
			// the rules are a company setting, so reading and writing need the settings rights
			expect((await send("GET", "/pause-rules", { headers: headers(annaToken) })).status).to.equal(403);

			const empty = await send("GET", "/pause-rules", { headers: headers(adminToken) });
			expect(empty.status).to.equal(200);
			expect(bodyOf<{ pauseRules: unknown[] }>(empty).pauseRules).to.deep.equal([]);

			const saved = await send("PUT", "/pause-rules", {
				body: {
					pauseRules: [
						{ fromMin: 360, toMin: 540, pauseMin: 30 },
						{ fromMin: 540, pauseMin: 60 },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(saved.status).to.equal(200);
			const rules = bodyOf<{ pauseRules: { id: number; fromMin: number; pauseMin: number }[] }>(saved).pauseRules;
			expect(rules.map(rule => rule.fromMin)).to.deep.equal([360, 540]);

			// the payload is the whole table: a rule that is missing is removed, the rest is updated
			const kept = await send("PUT", "/pause-rules", {
				body: { pauseRules: [{ id: rules[1].id, fromMin: 540, pauseMin: 45 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(kept.status).to.equal(200);
			const remaining = bodyOf<{ pauseRules: { fromMin: number; pauseMin: number }[] }>(kept).pauseRules;
			expect(remaining.map(rule => [rule.fromMin, rule.pauseMin])).to.deep.equal([[540, 45]]);

			// a body that is not a table and impossible values are client errors
			expect(
				(
					await send("PUT", "/pause-rules", {
						body: { pauseRules: "nein" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
			expect(
				(
					await send("PUT", "/pause-rules", {
						body: { pauseRules: [{ fromMin: -1, pauseMin: 30 }] },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);
		});

		it("changes and deletes an absence", async () => {
			const created = await send("POST", "/absences", {
				body: { typeCode: "F", dateFrom: "2026-07-06" },
				headers: headers(annaToken, annaCsrf),
			});
			const absenceId = bodyOf<{ absence: { id: number } }>(created).absence.id;

			// the own absence may be corrected, the state is an approval
			const moved = await send("PATCH", `/absences/${absenceId}`, {
				body: { dateTo: "2026-07-08", note: "verlängert" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(moved.status).to.equal(200);
			expect(bodyOf<{ absence: { dateTo: string; note: string } }>(moved).absence).to.deep.include({
				dateTo: "2026-07-08",
				note: "verlängert",
			});

			expect(
				(
					await send("PATCH", `/absences/${absenceId}`, {
						body: { status: "taken" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);
			expect(
				(
					await send("PATCH", `/absences/${absenceId}`, {
						body: { status: "taken" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(200);
			expect(
				(
					await send("PATCH", `/absences/${absenceId}`, {
						body: { status: "irgendwas" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			expect(
				(await send("DELETE", `/absences/${absenceId}`, { headers: headers(annaToken, annaCsrf) })).status,
			).to.equal(204);
			expect(
				(await send("DELETE", `/absences/${absenceId}`, { headers: headers(annaToken, annaCsrf) })).status,
			).to.equal(404);
		});

		it("shows the system information only to the administrator", async () => {
			expect((await send("GET", "/system/info")).status).to.equal(401);
			expect((await send("GET", "/system/info", { headers: headers(annaToken) })).status).to.equal(403);
			const info = await send("GET", "/system/info", { headers: headers(adminToken) });
			expect(info.status).to.equal(200);
			expect(bodyOf(info)).to.deep.equal({ name: "iobroker.time-tracker", version: "9.9.9" });
		});

		it("reports the adapter version without a session", async () => {
			const version = await send("GET", "/version");
			expect(version.status).to.equal(200);
			expect(bodyOf(version)).to.deep.equal({ name: "iobroker.time-tracker", version: "9.9.9" });
		});
	});

	describe("branding", () => {
		/** A 1×1 pixel PNG, small enough for any limit. */
		const png =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

		it("is readable without a session and empty at first", async () => {
			const answer = await send("GET", "/branding");

			expect(answer.status).to.equal(200);
			expect(bodyOf(answer)).to.deep.equal({ color: null, logoUrl: null, backgroundUrl: null });
			// nothing is configured yet, so both pictures are missing
			expect((await send("GET", "/branding/logo")).status).to.equal(404);
			expect((await send("GET", "/branding/background")).status).to.equal(404);
		});

		it("takes a logo and a colour and hands them out", async () => {
			// an employee may not change settings at all
			const denied = await send("PUT", "/settings", {
				body: { brand_color: "#1a2b3c" },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			const saved = await send("PUT", "/settings", {
				body: { brand_logo: png, brand_color: "#1a2b3c" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(saved.status).to.equal(200);

			const state = bodyOf<{ color: string | null; logoUrl: string | null; backgroundUrl: string | null }>(
				await send("GET", "/branding"),
			);
			expect(state.color).to.equal("#1a2b3c");
			expect(state.backgroundUrl).to.equal(null);
			expect(state.logoUrl).to.match(/^\/api\/branding\/logo\?v=[0-9a-f]{12}$/);

			// the picture itself is served with a content type and may be cached (the router knows the path
			// below `/api`, and the version travels as a query parameter)
			const version = /v=([0-9a-f]{12})/.exec(state.logoUrl ?? "")?.[1] ?? "";
			const image = await send("GET", "/branding/logo", { query: { v: version } });
			expect(image.status).to.equal(200);
			expect(image.headers["content-type"]).to.contain("image/png");
			expect(image.headers["cache-control"]).to.contain("max-age");

			// the pictures stay out of the settings payload (they are large), the colour is in it
			const settings = bodyOf<{ settings: Record<string, string> }>(
				await send("GET", "/settings", { headers: headers(adminToken) }),
			);
			expect(settings.settings).to.not.have.property("brand_logo");
			expect(settings.settings.brand_color).to.equal("#1a2b3c");
		});

		it("refuses a colour that is not a hex value and a broken picture", async () => {
			const badColor = await send("PUT", "/settings", {
				body: { brand_color: "red" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(badColor.status).to.equal(400);

			const badPicture = await send("PUT", "/settings", {
				body: { brand_logo: "data:image/bmp;base64,Qk1vY2s=" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(badPicture.status).to.equal(400);

			// clearing is allowed
			const cleared = await send("PUT", "/settings", {
				body: { brand_color: "", brand_logo: "" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(cleared.status).to.equal(200);
			expect(bodyOf(await send("GET", "/branding")).logoUrl).to.equal(null);
		});

		it("accepts a background of the documented size and explains one that is too big", async () => {
			// 400 KiB of base64 are about 300 KiB of picture: above the old body limit (256 KiB), well below
			// MAX_BRANDING_BYTES (512 KiB)
			const large = `data:image/png;base64,${"A".repeat(400 * 1024)}`;
			const saved = await send("PUT", "/settings", {
				body: { brand_background: large },
				headers: headers(adminToken, adminCsrf),
			});
			expect(saved.status, "a picture of the documented size has to fit through the body limit").to.equal(200);

			// 800 KiB of base64 decode to about 600 KiB of picture: the answer names the limit instead of failing
			// on the body size
			const tooBig = `data:image/png;base64,${"A".repeat(800 * 1024)}`;
			const refused = await send("PUT", "/settings", {
				body: { brand_background: tooBig },
				headers: headers(adminToken, adminCsrf),
			});
			expect(refused.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(refused).detail).to.contain("524288");
		});
	});

	describe("trigger rules", () => {
		it("keeps the rules behind the settings permission and tells the adapter about a change", async () => {
			expect((await send("GET", "/trigger-rules", { headers: headers(annaToken) })).status).to.equal(403);
			expect(
				(
					await send("PUT", "/trigger-rules", {
						body: { triggerRules: [] },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);

			const created = await send("PUT", "/trigger-rules", {
				body: {
					triggerRules: [
						{ sourceState: "fingerprint.0.lastMatch", condition: "1", userId: annaId, label: "Finger" },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(200);
			const saved = bodyOf<{ triggerRules: { label: string; cooldownSec: number; sourceState: string }[] }>(
				created,
			);
			expect(saved.triggerRules).to.have.length(1);
			expect(saved.triggerRules[0]).to.include({
				label: "Finger",
				cooldownSec: 0,
				sourceState: "fingerprint.0.lastMatch",
			});
			// the adapter subscribes to the states of the new list right away
			expect(hookCalls).to.be.greaterThan(0);

			const listed = await send("GET", "/trigger-rules", { headers: headers(adminToken) });
			expect(bodyOf<{ triggerRules: unknown[] }>(listed).triggerRules).to.have.length(1);

			// the payload is the whole table: an empty list removes the rule again
			const cleared = await send("PUT", "/trigger-rules", {
				body: { triggerRules: [] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(bodyOf<{ triggerRules: unknown[] }>(cleared).triggerRules).to.be.empty;
			expect(triggers.list({ includeInactive: true })).to.be.empty;
		});

		it("saves the value map and fire-on-every-write, with the defaults of the mode", async () => {
			const saved = await send("PUT", "/trigger-rules", {
				body: {
					triggerRules: [
						{
							sourceState: "fingerprint.0.lastMatch.id",
							mode: "user",
							valueMap: [{ value: "3", userId: annaId }],
						},
						{ sourceState: "a.0.b", condition: "1", userId: annaId },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(saved.status).to.equal(200);
			const rules = bodyOf<{
				triggerRules: { mode: string; fireOnRepeat: boolean; valueMap: { value: string; userId: number }[] }[];
			}>(saved).triggerRules;
			expect(rules[0]).to.deep.include({ mode: "user", fireOnRepeat: true });
			expect(rules[0].valueMap).to.deep.equal([{ value: "3", userId: annaId }]);
			expect(rules[1]).to.deep.include({ mode: "condition", fireOnRepeat: false });

			const unknown = await send("PUT", "/trigger-rules", {
				body: {
					triggerRules: [{ sourceState: "a.0.b", mode: "user", valueMap: [{ value: "1", userId: 999 }] }],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(unknown.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(unknown).detail).to.contain("existing employees");
			const notList = await send("PUT", "/trigger-rules", {
				body: { triggerRules: [{ sourceState: "a.0.b", mode: "user", valueMap: "nope" }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(notList.status).to.equal(400);
		});

		it("refuses a rule that cannot work", async () => {
			const unknown = await send("PUT", "/trigger-rules", {
				body: { triggerRules: [{ sourceState: "a.0.b", condition: "1", userId: 999 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(unknown.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(unknown).detail).to.contain("existing employee");

			const mixed = await send("PUT", "/trigger-rules", {
				body: { triggerRules: [{ sourceState: "a.0.b", mode: "user", userId: annaId }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(mixed.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(mixed).detail).to.contain("mode user");

			const noValue = await send("PUT", "/trigger-rules", {
				body: { triggerRules: [{ sourceState: "a.0.b", userId: annaId }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(noValue.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(noValue).detail).to.contain("condition is required");

			const noArray = await send("PUT", "/trigger-rules", {
				body: { triggerRules: "nope" },
				headers: headers(adminToken, adminCsrf),
			});
			expect(noArray.status).to.equal(400);
			expect(triggers.list({ includeInactive: true })).to.be.empty;
		});
	});

	describe("automation rules", () => {
		it("keeps the rules behind the settings permission and replaces the whole table", async () => {
			expect((await send("GET", "/automation-rules", { headers: headers(annaToken) })).status).to.equal(403);

			const created = await send("PUT", "/automation-rules", {
				body: {
					automationRules: [
						{ kind: "clockOut", atMinute: 1200, label: "Feierabend" },
						{ kind: "breakReminder", afterMinutes: 360, userId: annaId },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(200);
			const saved = bodyOf<{
				automationRules: { id: number; kind: string; atMinute: number | null; afterMinutes: number | null }[];
			}>(created);
			expect(saved.automationRules).to.have.length(2);
			expect(saved.automationRules[0]).to.include({ kind: "clockOut", atMinute: 1200, afterMinutes: null });
			expect(saved.automationRules[1]).to.include({ kind: "breakReminder", atMinute: null, afterMinutes: 360 });

			// what a rule did shows up in the log the administration reads
			automations.recordRun({
				ruleId: saved.automationRules[0].id,
				userId: annaId,
				period: "2026-09-18",
				action: "clocked out",
				now: 5000,
			});
			const runs = await send("GET", "/automation-rules/runs", { headers: headers(adminToken) });
			expect(
				bodyOf<{ runs: { action: string; userId: number; period: string }[] }>(runs).runs[0],
			).to.deep.include({
				action: "clocked out",
				userId: annaId,
				period: "2026-09-18",
			});

			// a rule that ran six times is still one line: the answer carries the newest run of every rule
			for (let day = 1; day <= 6; day += 1) {
				automations.recordRun({
					ruleId: saved.automationRules[0].id,
					userId: annaId,
					period: `2026-09-${String(day).padStart(2, "0")}`,
					action: `run ${day}`,
					now: 5000 + day,
				});
			}
			const recent = await send("GET", "/automation-rules/runs", { headers: headers(adminToken) });
			const latest = bodyOf<{ runs: { ruleId: number; action: string }[] }>(recent).runs;
			// only the rule that ran appears, and with its newest run — not with the six rows of the log
			expect(latest).to.have.length(1);
			expect(latest[0]).to.deep.include({ ruleId: saved.automationRules[0].id, action: "run 6" });

			// the payload is the whole table: an empty list removes the rules again
			const cleared = await send("PUT", "/automation-rules", {
				body: { automationRules: [] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(bodyOf<{ automationRules: unknown[] }>(cleared).automationRules).to.be.empty;
			expect(automations.list({ includeInactive: true })).to.be.empty;

			// the days of the week and the repeat travel with the rule
			const scheduled = await send("PUT", "/automation-rules", {
				body: {
					automationRules: [
						{ kind: "clockOut", atMinute: 1200, weekdays: [1, 2, 3, 4, 5], repeat: "week" },
						{ kind: "breakReminder", afterMinutes: 360 },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(scheduled.status).to.equal(200);
			const withDays = bodyOf<{ automationRules: { weekdays: number[]; repeat: string }[] }>(scheduled);
			expect(withDays.automationRules[0]).to.deep.include({ weekdays: [1, 2, 3, 4, 5], repeat: "week" });
			// without a selection a rule runs every day, once a day
			expect(withDays.automationRules[1]).to.deep.include({ weekdays: [1, 2, 3, 4, 5, 6, 7], repeat: "day" });

			// a rule can be limited to a period, and both dates travel with it
			const limited = await send("PUT", "/automation-rules", {
				body: {
					automationRules: [
						{ kind: "clockOut", atMinute: 1200, activeFrom: "2026-10-01", activeUntil: "2026-10-15" },
					],
				},
				headers: headers(adminToken, adminCsrf),
			});
			expect(limited.status).to.equal(200);
			expect(
				bodyOf<{ automationRules: { activeFrom: string | null; activeUntil: string | null }[] }>(limited)
					.automationRules[0],
			).to.deep.include({ activeFrom: "2026-10-01", activeUntil: "2026-10-15" });

			// a day that does not exist and an end before the start are refused as well
			for (const broken of [
				{ activeFrom: "2026-02-30" },
				{ activeFrom: "2026-10-05", activeUntil: "2026-10-01" },
			]) {
				const refusedDates = await send("PUT", "/automation-rules", {
					body: { automationRules: [{ kind: "clockOut", atMinute: 1200, ...broken }] },
					headers: headers(adminToken, adminCsrf),
				});
				expect(refusedDates.status, JSON.stringify(broken)).to.equal(400);
			}

			// a day that does not exist, an empty selection and an unknown repeat are refused
			for (const broken of [{ weekdays: [0, 8] }, { weekdays: [] }, { repeat: "month" }]) {
				const refused = await send("PUT", "/automation-rules", {
					body: { automationRules: [{ kind: "clockOut", atMinute: 1200, ...broken }] },
					headers: headers(adminToken, adminCsrf),
				});
				expect(refused.status, JSON.stringify(broken)).to.equal(400);
			}
		});

		it("refuses a rule that cannot work", async () => {
			const withoutTime = await send("PUT", "/automation-rules", {
				body: { automationRules: [{ kind: "clockOut" }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(withoutTime.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(withoutTime).detail).to.contain("atMinute");

			const unknownUser = await send("PUT", "/automation-rules", {
				body: { automationRules: [{ kind: "missingPunch", atMinute: 1200, userId: 999 }] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(unknownUser.status).to.equal(400);
			expect(bodyOf<{ detail: string }>(unknownUser).detail).to.contain("existing employee");
			expect(automations.list({ includeInactive: true })).to.be.empty;
		});
	});
});
