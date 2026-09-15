/**
 * Browser test of the time corrections: an administrator fixes the punches of an employee.
 *
 * The punches are added through the API (that is what the dialog does as well), and the test then walks the real
 * screen: sign in, open the administration, pick the employee and look for the punch that was just added.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/** Session of the test. */
interface AdminSession {
	/** Session token */
	token: string;
	/** CSRF token of the same session */
	csrfToken: string;
}

/**
 * Signs in as the administrator, like a browser does.
 *
 * @param request - API client of the test
 * @returns the tokens of the session
 */
async function signInApi(request: APIRequestContext): Promise<AdminSession> {
	const login = await request.post("/api/auth/login", { data: admin });
	expect(login.status()).toBe(200);
	return (await login.json()) as AdminSession;
}

/**
 * Signs in on the page.
 *
 * @param page - page under test
 */
async function signIn(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
}

test("an administrator adds a forgotten day and finds it in the correction list", async ({ page, request }) => {
	const session = await signInApi(request);
	const list = await request.get("/api/users", { headers: { "x-session-token": session.token } });
	const users = ((await list.json()) as { users: { id: number; login: string }[] }).users;
	const annaId = users.find(user => user.login === "anna")!.id;

	// a forgotten day: both punches are added for the employee, with a reason for the audit trail
	const now = Math.floor(Date.now() / 1000);
	for (const [tsUtc, direction] of [
		[now - 8 * 3600, "in"],
		[now - 0.5 * 3600, "out"],
	] as const) {
		const created = await request.post(`/api/entries?userId=${annaId}`, {
			headers: {
				"x-session-token": session.token,
				"x-csrf-token": session.csrfToken,
				"content-type": "application/json",
			},
			data: { tsUtc, direction, note: "Nachtrag Test", reason: "Testkorrektur" },
		});
		expect(created.status()).toBe(201);
	}

	await signIn(page);
	await page.goto("/admin");
	await page.getByRole("tab", { name: "Zeitkorrektur" }).click();

	// the tab starts with the first employee: pick the one whose day was added
	await page.getByLabel("Mitarbeiter").click();
	await page.getByRole("option", { name: "Anna Muster" }).click();

	// the punch is listed, marked as a correction and can be edited or deleted
	await expect(page.getByText("Nachtrag Test").first()).toBeVisible();
	await expect(page.getByText(/durch die Verwaltung/).first()).toBeVisible();
	await expect(page.getByLabel("Begründung").first()).toBeVisible();
});
