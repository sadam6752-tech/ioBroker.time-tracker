/**
 * Browser test of the presence screen (mini kiosk).
 *
 * The screen authenticates with the **device token** of a terminal, so the test creates one through the API with the
 * administrator session and then opens the screen with that token. Anna is seeded with the PIN `1234`.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/**
 * Creates a terminal and returns its device token.
 *
 * @param request - API client of the test
 * @returns the device token of the new terminal
 */
async function createTerminal(request: APIRequestContext): Promise<string> {
	const login = await request.post("/api/auth/login", { data: admin });
	expect(login.status()).toBe(200);
	const session = (await login.json()) as { token: string; csrfToken: string };

	// the request context keeps the session cookie of the login, and a request that carries the cookie needs the
	// CSRF token — exactly like a browser
	const created = await request.post("/api/terminals", {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { name: "E2E Presence", location: "Test", pinRequired: true },
	});
	if (created.status() !== 201) {
		throw new Error(`POST /api/terminals answered ${created.status()}: ${await created.text()}`);
	}
	return ((await created.json()) as { deviceToken: string }).deviceToken;
}

test("shows who is present and clocks an employee with the PIN", async ({ page, request }) => {
	const deviceToken = await createTerminal(request);
	await page.goto(`/presence?token=${encodeURIComponent(deviceToken)}`);

	// the tiles come from the terminal API: every employee with the state of the day
	const tile = page.getByRole("button", { name: /Anna Muster/ }).first();
	await expect(tile).toBeVisible();
	await expect(tile).toContainText("Abwesend");

	// tapping the tile asks for the PIN of that employee
	await tile.click();
	await page.getByLabel("PIN").fill("1234");
	await page.getByRole("button", { name: "Stempeln" }).click();

	// the answer of the server carries the new state, so the tile switches to present
	await expect(page.getByRole("button", { name: /Anna Muster/ }).first()).toContainText("Anwesend");
	await expect(page.getByText(/Anna Muster ist jetzt Anwesend/)).toBeVisible();
});

test("asks the presence screen for its device token", async ({ page }) => {
	await page.goto("/presence");
	await expect(page.getByLabel("Geräte-Token")).toBeVisible();
	await expect(page.getByRole("button", { name: "Verbinden" })).toBeDisabled();
});
