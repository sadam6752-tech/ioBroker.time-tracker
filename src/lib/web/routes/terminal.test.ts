/// <reference types="mocha" />
import { expect } from "chai";
import { createApi } from "../api";
import {
	db,
	users,
	entries,
	absences,
	dayNotes,
	holidays,
	rules,
	payouts,
	terminals,
	rfid,
	triggers,
	automations,
	aggregation,
	sync,
	auth,
	settings,
	annaId,
	adminId,
	annaToken,
	annaCsrf,
	adminToken,
	adminCsrf,
	clock,
	send,
	bodyOf,
	headers,
	setClock,
	useApiFixture,
} from "./apiFixture.test";

describe("web api", () => {
	useApiFixture();

	describe("kiosk terminal", () => {
		/**
		 * Prepares a terminal with a badge user.
		 *
		 * @param options - whether the employee gets a PIN and whether the device demands one
		 * @param options.pin - true to set the PIN of the employee
		 * @param options.pinRequired - value for the device flag
		 * @returns device token and the requested session
		 */
		async function prepareTerminal(options: { pin: boolean; pinRequired: boolean }): Promise<{
			deviceToken: string;
			terminalSession: string;
		}> {
			await send("PATCH", `/users/${annaId}`, {
				body: { rfidCard: "CARD-42" },
				headers: headers(adminToken, adminCsrf),
			});
			if (options.pin) {
				await send("POST", `/users/${annaId}/pin`, {
					body: { pin: "1234" },
					headers: headers(adminToken, adminCsrf),
				});
			}
			const created = await send("POST", "/terminals", {
				body: { name: "Werkstatt", location: "Halle 1", pinRequired: options.pinRequired },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const deviceToken = bodyOf<{ deviceToken: string }>(created).deviceToken;

			const session = await send("POST", "/terminal/session", { body: { deviceToken } });
			expect(session.status).to.equal(200);
			return { deviceToken, terminalSession: bodyOf<{ terminalSession: string }>(session).terminalSession };
		}

		it("hands out a device token once and punches with badge and PIN", async () => {
			// the status is public so a device can show a setup hint
			const status = await send("GET", "/terminal/status");
			expect(status.status).to.equal(200);
			expect(bodyOf(status)).to.deep.include({ enabled: true, version: "9.9.9" });

			// only administrators manage devices and PINs
			expect((await send("GET", "/terminals", { headers: headers(annaToken) })).status).to.equal(403);
			expect(
				(
					await send("POST", `/users/${annaId}/pin`, {
						body: { pin: "1234" },
						headers: headers(annaToken, annaCsrf),
					})
				).status,
			).to.equal(403);
			expect(
				(
					await send("POST", `/users/${annaId}/pin`, {
						body: { pin: "12" },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			const { deviceToken, terminalSession } = await prepareTerminal({ pin: true, pinRequired: true });

			// the token is visible exactly once
			const listed = await send("GET", "/terminals", { headers: headers(adminToken) });
			expect(listed.status).to.equal(200);
			expect(JSON.stringify(bodyOf(listed))).to.not.contain(deviceToken);
			expect(bodyOf<{ terminals: { name: string; pinRequired: boolean }[] }>(listed).terminals).to.have.lengthOf(
				1,
			);

			// the selection list stays minimal
			const people = await send("GET", "/terminal/users", { query: { terminalSession } });
			expect(people.status).to.equal(200);
			const people2 = bodyOf<{ users: Record<string, unknown>[] }>(people).users;
			expect(people2).to.have.lengthOf(2);
			expect(Object.keys(people2[0]).sort()).to.deep.equal(["avatarUrl", "displayName", "id", "present"]);

			// a badge alone is not enough when the device demands a PIN
			expect(
				(await send("POST", "/terminal/punch", { body: { terminalSession, badge: "CARD-42" } })).status,
			).to.equal(401);

			const punched = await send("POST", "/terminal/punch", {
				body: { terminalSession, badge: "CARD-42", pin: "1234", tsUtc: 1000 },
			});
			expect(punched.status).to.equal(201);
			expect(bodyOf<{ user: { id: number; displayName: string } }>(punched).user).to.deep.equal({
				id: annaId,
				displayName: "Anna",
			});
			expect(bodyOf<{ entry: { direction: string } }>(punched).entry.direction).to.equal("auto");
			// the state of the day tells the terminal whether the employee is clocked in
			expect(bodyOf<{ day: { hasOpenEntry: boolean } }>(punched).day.hasOpenEntry).to.equal(true);

			// wrong PIN, unknown badge and a stale session are all refused
			expect(
				(
					await send("POST", "/terminal/punch", {
						body: { terminalSession, badge: "CARD-42", pin: "9999" },
					})
				).status,
			).to.equal(401);
			expect(
				(
					await send("POST", "/terminal/punch", {
						body: { terminalSession, badge: "UNBEKANNT", pin: "1234" },
					})
				).status,
			).to.equal(401);
			expect(
				(await send("POST", "/terminal/punch", { body: { terminalSession: "falsch", badge: "CARD-42" } }))
					.status,
			).to.equal(401);
			expect((await send("POST", "/terminal/punch", { body: { terminalSession, pin: "1234" } })).status).to.equal(
				400,
			);

			// the PIN also works without a badge, and the heartbeat keeps the session alive
			const byPin = await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, pin: "1234", tsUtc: 1000 + 8 * 3600 },
			});
			expect(byPin.status).to.equal(201);
			// Anna has not allowed the working time on the presence card, so the terminal never sees it
			expect(bodyOf<{ day: { hasOpenEntry: boolean; workedMin?: number } }>(byPin).day.hasOpenEntry).to.equal(
				false,
			);
			expect(bodyOf<{ day: { workedMin?: number } }>(byPin).day.workedMin).to.equal(undefined);

			// with the permission in the work profile the very same answer carries the minutes of the day …
			users.saveWorkProfile({ userId: annaId, profile: { showWorkedTime: true }, actorId: adminId });
			const withTime = await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, pin: "1234", tsUtc: 1000 + 9 * 3600 },
			});
			expect(withTime.status).to.equal(201);
			expect(bodyOf<{ day: { hasOpenEntry: boolean; workedMin?: number } }>(withTime).day).to.deep.include({
				hasOpenEntry: true,
				workedMin: 480,
			});

			// … and the list of the terminal shows them too
			const terminalUsers = await send("GET", "/terminal/users", { query: { terminalSession } });
			expect(
				bodyOf<{ users: { id: number; workedMin?: number }[] }>(terminalUsers).users.find(
					user => user.id === annaId,
				)?.workedMin,
			).to.equal(480);

			// The board shows the running time of an open punch — the day aggregate alone counts finished pairs.
			// The clock moves ten minutes (the terminal session lives fifteen), and the punch starts ten minutes
			// in the past: the board has to show those ten minutes without anybody punching again.
			await send("POST", "/terminal/punch", { body: { terminalSession, userId: annaId, pin: "1234" } });
			setClock(clock + 10 * 60);
			await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, pin: "1234", tsUtc: clock - 10 * 60 },
			});
			const board = await send("GET", "/terminal/users", { query: { terminalSession } });
			const running = bodyOf<{ users: { id: number; workedMin?: number }[] }>(board).users.find(
				user => user.id === annaId,
			)?.workedMin;
			expect(running, "the open punch counts with the ten minutes it runs").to.be.at.least(10);

			const heartbeat = await send("POST", "/terminal/heartbeat", { body: { terminalSession } });
			expect(heartbeat.status).to.equal(200);
			expect(bodyOf(heartbeat)).to.deep.include({ status: "ok" });

			// revoking the device ends everything
			const terminalId = bodyOf<{ terminals: { id: number }[] }>(listed).terminals[0].id;
			expect(
				(await send("DELETE", `/terminals/${terminalId}`, { headers: headers(adminToken, adminCsrf) })).status,
			).to.equal(204);
			expect((await send("GET", "/terminal/users", { query: { terminalSession } })).status).to.equal(401);
			expect((await send("POST", "/terminal/session", { body: { deviceToken } })).status).to.equal(401);
		});

		it("blocks an account after too many wrong PINs", async () => {
			const { terminalSession } = await prepareTerminal({ pin: true, pinRequired: true });

			// five wrong PINs inside the window block the account (specification 4.10) …
			for (let attempt = 0; attempt < 5; attempt++) {
				const refused = await send("POST", "/terminal/punch", {
					body: { terminalSession, userId: annaId, pin: "0000" },
				});
				expect(refused.status, `attempt ${attempt + 1}`).to.equal(401);
			}

			// … and now even the correct PIN is refused, no matter whether it comes with the badge
			const blocked = await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, pin: "1234" },
			});
			expect(blocked.status).to.equal(423);
			expect(bodyOf(blocked).code).to.equal("locked_out");
			expect(bodyOf(blocked).detail).to.contain("wrong PINs");

			const withBadge = await send("POST", "/terminal/punch", {
				body: { terminalSession, badge: "CARD-42", pin: "1234" },
			});
			expect(withBadge.status, "the block belongs to the account, not to the input form").to.equal(423);
		});

		it("accepts a badge alone when the device does not ask for a PIN", async () => {
			const { terminalSession } = await prepareTerminal({ pin: false, pinRequired: false });

			const punched = await send("POST", "/terminal/punch", {
				body: { terminalSession, badge: "CARD-42", tsUtc: 1000 },
			});
			expect(punched.status).to.equal(201);

			// without a stored PIN a PIN attempt fails instead of being ignored
			expect(
				(await send("POST", "/terminal/punch", { body: { terminalSession, userId: annaId, pin: "1234" } }))
					.status,
			).to.equal(401);
		});

		it("accepts a selected employee without a PIN when the device does not ask for one", async () => {
			const { terminalSession } = await prepareTerminal({ pin: true, pinRequired: false });

			// no PIN at all: the administrator decided that this place is trusted
			const punched = await send("POST", "/terminal/punch", {
				body: { terminalSession, userId: annaId, tsUtc: 1000 },
			});
			expect(punched.status).to.equal(201);

			// a wrong PIN is refused everywhere — the counter protects the account
			expect(
				(
					await send("POST", "/terminal/punch", {
						body: { terminalSession, userId: annaId, pin: "0000" },
					})
				).status,
			).to.equal(401);

			// on a device that demands the PIN the same request without one is rejected as invalid
			const guarded = await prepareTerminal({ pin: true, pinRequired: true });
			expect(
				(
					await send("POST", "/terminal/punch", {
						body: { terminalSession: guarded.terminalSession, userId: annaId },
					})
				).status,
			).to.equal(400);
		});

		it("shows only the employees that are assigned to a terminal", async () => {
			// a terminal for the workshop: only Anna works there
			const created = await send("POST", "/terminals", {
				body: { name: "Werkstatt", userIds: [annaId] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(created.status).to.equal(201);
			const workshop = bodyOf<{ terminal: { id: number; userIds: number[] }; deviceToken: string }>(created);
			expect(workshop.terminal.userIds).to.deep.equal([annaId]);

			const session = await send("POST", "/terminal/session", { body: { deviceToken: workshop.deviceToken } });
			const terminalSession = bodyOf<{ terminalSession: string }>(session).terminalSession;
			const listed = await send("GET", "/terminal/users", { query: { terminalSession } });
			expect(bodyOf<{ users: { id: number }[] }>(listed).users.map(user => user.id)).to.deep.equal([annaId]);

			// an empty list means “all employees” — and that is how a terminal starts its life
			const open = await send("POST", "/terminals", {
				body: { name: "Büro" },
				headers: headers(adminToken, adminCsrf),
			});
			const openSession = await send("POST", "/terminal/session", {
				body: { deviceToken: bodyOf<{ deviceToken: string }>(open).deviceToken },
			});
			const everyone = await send("GET", "/terminal/users", {
				query: { terminalSession: bodyOf<{ terminalSession: string }>(openSession).terminalSession },
			});
			expect(bodyOf<{ users: unknown[] }>(everyone).users.length).to.be.greaterThan(1);

			// changing the assignment needs the right to manage terminals
			const denied = await send("PUT", `/terminals/${workshop.terminal.id}/users`, {
				body: { userIds: [] },
				headers: headers(annaToken, annaCsrf),
			});
			expect(denied.status).to.equal(403);

			const changed = await send("PUT", `/terminals/${workshop.terminal.id}/users`, {
				body: { userIds: [] },
				headers: headers(adminToken, adminCsrf),
			});
			expect(changed.status).to.equal(200);
			expect(bodyOf<{ terminal: { userIds: number[] } }>(changed).terminal.userIds).to.deep.equal([]);

			// an employee that does not exist is refused
			expect(
				(
					await send("PUT", `/terminals/${workshop.terminal.id}/users`, {
						body: { userIds: [999999] },
						headers: headers(adminToken, adminCsrf),
					})
				).status,
			).to.equal(400);

			// the same session of the workshop device now sees everybody as well
			const after = await send("GET", "/terminal/users", { query: { terminalSession } });
			expect(bodyOf<{ users: unknown[] }>(after).users.length).to.be.greaterThan(1);
		});

		it("refuses every terminal call when the kiosk is switched off", async () => {
			const disabled = createApi({
				db,
				auth,
				users,
				entries,
				absences,
				dayNotes,
				holidays,
				rules,
				payouts,
				terminals,
				rfid,
				triggers,
				automations,
				aggregation,
				sync,
				settings,
				kioskEnabled: false,
				now: () => 1000,
			});
			const status = await disabled.router.handle({
				method: "GET",
				path: "/terminal/status",
				query: {},
				headers: {},
				remoteAddress: "127.0.0.1",
			});
			expect(status.status).to.equal(200);
			expect(JSON.parse(status.body.toString())).to.deep.include({ enabled: false });

			const session = await disabled.router.handle({
				method: "POST",
				path: "/terminal/session",
				query: {},
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceToken: "egal" }),
				remoteAddress: "127.0.0.1",
			});
			expect(session.status).to.equal(403);
			expect(JSON.parse(session.body.toString())).to.deep.include({ code: "kiosk_disabled" });
		});
	});
});
