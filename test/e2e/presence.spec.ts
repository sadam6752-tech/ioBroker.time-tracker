/**
 * Browser test of the presence screen (mini kiosk).
 *
 * The screen authenticates with the **device token** of a terminal, so the test creates one through the API with the
 * administrator session and then opens the screen with that token. Anna is seeded with the PIN `1234`.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/** A 1×1 PNG, as the administration would send a picture. */
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Session of the test: the bearer token and the CSRF token the browser side needs. */
interface AdminSession {
	/** Session token */
	token: string;
	/** CSRF token of the same session */
	csrfToken: string;
}

/**
 * Signs in as the administrator. The request context keeps the session cookie, exactly like a browser.
 *
 * @param request - API client of the test
 * @returns the tokens of the session
 */
async function signIn(request: APIRequestContext): Promise<AdminSession> {
	const login = await request.post("/api/auth/login", { data: admin });
	expect(login.status()).toBe(200);
	return (await login.json()) as AdminSession;
}

/**
 * Creates a terminal and returns its device token.
 *
 * @param request - API client of the test
 * @param session - administrator session
 * @returns the device token of the new terminal
 */
async function createTerminal(request: APIRequestContext, session: AdminSession): Promise<string> {
	// the request context carries the session cookie, so a state changing request needs the CSRF token
	const created = await request.post("/api/terminals", {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { name: "E2E Presence", location: "Test", pinRequired: true },
	});
	if (created.status() !== 201) {
		throw new Error(`POST /api/terminals answered ${created.status()}: ${await created.text()}`);
	}
	return ((await created.json()) as { deviceToken: string }).deviceToken;
}

/**
 * Finds the id of an employee.
 *
 * @param request - API client of the test
 * @param session - administrator session
 * @param login - login name of the employee
 * @returns the database id
 */
async function userIdOf(request: APIRequestContext, session: AdminSession, login: string): Promise<number> {
	const list = await request.get("/api/users", { headers: { "x-session-token": session.token } });
	expect(list.status()).toBe(200);
	const users = ((await list.json()) as { users: { id: number; login: string }[] }).users;
	const found = users.find(user => user.login === login);
	expect(found, `employee ${login} exists`).toBeTruthy();
	return found!.id;
}

test("shows who is present, uses the stored picture and the placeholder otherwise", async ({ page, request }) => {
	const session = await signIn(request);
	const deviceToken = await createTerminal(request, session);
	const annaId = await userIdOf(request, session, "anna");

	// Anna gets a picture, so the tile must use it instead of the placeholder
	const stored = await request.patch(`/api/users/${annaId}`, {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { avatar: PNG },
	});
	expect(stored.status()).toBe(200);
	expect((await stored.json()).user.avatarUrl).toContain(`/api/users/${annaId}/avatar?v=`);

	// the picture has its own route: with the session of the administrator …
	const bySession = await request.get(`/api/users/${annaId}/avatar`, {
		headers: { "x-session-token": session.token },
	});
	expect(bySession.status()).toBe(200);
	expect(bySession.headers()["content-type"]).toContain("image/png");

	// … and with the session of the terminal, which is what an `<img>` on the presence screen uses
	const started = await request.post("/api/terminal/session", { data: { deviceToken } });
	expect(started.status()).toBe(200);
	const terminalSession = ((await started.json()) as { terminalSession: string }).terminalSession;
	const byTerminal = await request.get(
		`/api/users/${annaId}/avatar?terminalSession=${encodeURIComponent(terminalSession)}`,
	);
	expect(byTerminal.status()).toBe(200);
	expect(byTerminal.headers()["content-type"]).toContain("image/png");

	await page.goto(`/presence?token=${encodeURIComponent(deviceToken)}`);

	// the header shows the time, the same way the kiosk terminal does
	await expect(page.getByRole("heading", { level: 5 }).filter({ hasText: /^\d{1,2}:\d{2}/ })).toBeVisible();

	// the tiles come from the terminal API: every employee with the state of the day
	const tile = page.getByRole("button", { name: /Anna Muster/ }).first();
	await expect(tile).toBeVisible();

	// The suite shares one server, so another spec may have punched for Anna already. The screen is put into a
	// known state first: the tile toggles with every punch (tap, PIN, stamp), exactly like the kiosk does it.
	if ((await tile.innerText()).includes("Anwesend")) {
		await tile.click();
		for (const digit of "1234") {
			await page.getByRole("button", { name: digit, exact: true }).click();
		}
		await page.getByRole("button", { name: "Stempeln" }).click();
		await expect(tile).toContainText("Abwesend");
	}

	await expect(tile).toContainText("Abwesend");
	// the stored picture is used …
	await expect(tile.locator("img")).toHaveAttribute("src", new RegExp(`/api/users/${annaId}/avatar`));
	// … and an employee without a picture gets the placeholder of the project
	const adminTile = page.getByRole("button", { name: /E2E Admin/ }).first();
	await expect(adminTile.locator("img")).toHaveAttribute("src", /\/person\.png$/);
	// Anna allows the working time of today on the presence card: the tile then shows it next to the state.
	// Without that permission the API never sends the minutes — the card is visible before the PIN is entered.
	const allowed = await request.put(`/api/users/${annaId}/profile`, {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { showWorkedTime: true, reason: "e2e test" },
	});
	expect(allowed.status()).toBe(200);
	await page.reload();
	await expect(page.getByRole("button", { name: /Anna Muster/ }).first()).toContainText("Abwesend");
	// the tile shows the minutes of the day next to the state; the exact value depends on the punches of the
	// other specs, so the format is what is checked here (h:mm, and 0:00 when nobody punched yet)
	await expect(page.getByRole("button", { name: /Anna Muster/ }).first()).toHaveText(
		/^Abwesend\s*\d{1,2}:\d{2}\s*Anna Muster$/,
	);

	// tapping the tile asks for the PIN of that employee — entered on the built-in keypad, because the screen
	// has to work without a keyboard
	await tile.click();
	for (const digit of "1234") {
		await page.getByRole("button", { name: digit, exact: true }).click();
	}
	await expect(page.getByLabel("PIN")).toHaveValue("1234");
	await page.getByRole("button", { name: "Stempeln" }).click();

	// the answer of the server carries the new state, so the tile switches to present
	await expect(page.getByRole("button", { name: /Anna Muster/ }).first()).toContainText("Anwesend");
	await expect(page.getByText(/Anna Muster ist jetzt Anwesend/)).toBeVisible();
});

test("keeps working after the terminal session expired (no reload needed)", async ({ page, request }) => {
	const session = await signIn(request);
	const deviceToken = await createTerminal(request, session);

	await page.goto(`/presence?token=${encodeURIComponent(deviceToken)}`);
	await expect(page.getByRole("button", { name: /Anna Muster/ }).first()).toBeVisible();

	// the test server lets a terminal session live about six seconds; a screen in a workshop runs much longer than
	// that and has to get a new session on its own — the heartbeat is late in a sleeping browser, so the call itself
	// has to renew it
	await page.waitForTimeout(7000);
	await page.getByRole("button", { name: "Aktualisieren" }).click();

	// the tiles are there again, and the screen never told the user to sign in or to reload
	await expect(page.getByRole("button", { name: /Anna Muster/ }).first()).toBeVisible();
	await expect(page.getByText(/abgelaufen/)).toHaveCount(0);
});

test("asks the presence screen for its device token", async ({ page }) => {
	await page.goto("/presence");
	await expect(page.getByLabel("Geräte-Token")).toBeVisible();
	await expect(page.getByRole("button", { name: "Verbinden" })).toBeDisabled();
});
