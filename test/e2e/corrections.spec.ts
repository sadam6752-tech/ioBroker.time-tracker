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

	// a forgotten day: both punches are added for the employee, with a reason for the audit trail. The pair is
	// anchored inside the local day — “eight hours ago” would land on the day before when the suite runs shortly
	// after midnight, and the day of the employee would stay open for the specs that follow.
	const dayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
	for (const [tsUtc, direction] of [
		[dayStart + 6 * 3600, "in"],
		[dayStart + 14 * 3600, "out"],
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

	// Correcting a punch is what the administration does every day, and it is exactly what was broken once (the
	// server insists on the revision of the punch): the test therefore saves a change instead of only looking.
	await page.getByLabel("Stempel ändern").first().click();
	await page.getByLabel("Kommen").fill("09:30");
	await page.getByRole("button", { name: "Speichern" }).click();

	await expect(page.getByText(/09:30/).first()).toBeVisible();
	await expect(page.getByText(/nicht akzeptiert/)).toHaveCount(0);

	// Adding a punch through the dialog is the other everyday job (“forgot to clock in and out”): the test uses the
	// button and the dialog of the screen, so a broken request is noticed here and not by the user.
	await page.getByRole("button", { name: "Stempel oder Tag nachtragen" }).click();
	await page.getByLabel("Kommen").fill("06:00");
	await page.getByLabel("Gehen").fill("14:00");
	await page.getByLabel("Notiz").fill("Nachgetragen über den Dialog");
	await page.getByLabel("Begründung").last().fill("über den Dialog nachgetragen");
	await page.getByRole("button", { name: "Speichern" }).click();

	await expect(page.getByText("Nachgetragen über den Dialog").first()).toBeVisible();
	await expect(page.getByText(/nicht akzeptiert/)).toHaveCount(0);

	// the history of that punch shows who corrected it and why: the typed reason really reaches the audit trail
	// (both punches of the added day carry the same note, so the first one is used)
	const row = page.getByRole("listitem").filter({ hasText: "Nachgetragen über den Dialog" }).first();
	await row.getByLabel("Verlauf").click();
	await expect(page.getByText(/über den Dialog nachgetragen/).last()).toBeVisible();
	await expect(page.getByText(/Nachgetragen · /).last()).toBeVisible();
	await page.getByRole("button", { name: "Schließen" }).click();
});
