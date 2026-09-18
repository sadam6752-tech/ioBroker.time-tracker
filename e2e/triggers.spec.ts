/**
 * Browser test of the trigger rules: the administration creates a rule that punches from a state of another
 * adapter.
 *
 * The rule itself runs inside the adapter, which is not part of the end-to-end server — so this test walks the
 * administration end to end (create, save, read back, remove) while the execution logic is covered by the unit
 * tests of `src/lib/adapter/triggers.test.ts`.
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
 * Signs in through the API, like the web app does.
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
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
}

test("creates a trigger rule for a state of another adapter and removes it again", async ({ page, request }) => {
	const session = await signInApi(request);
	const headers = { "x-session-token": session.token, "x-csrf-token": session.csrfToken };
	const stored = async (): Promise<{ sourceState: string; condition: string | null; userId: number | null }[]> => {
		const response = await request.get("/api/trigger-rules", { headers });
		return (
			(await response.json()) as {
				triggerRules: { sourceState: string; condition: string | null; userId: number | null }[];
			}
		).triggerRules;
	};

	// the employee the rule punches for
	const people = await request.get("/api/users", { headers });
	const users = ((await people.json()) as { users: { id: number; login: string; displayName: string }[] }).users;
	const anna = users.find(user => user.login === "anna") ?? users[0];
	expect(anna, "the seeded instance has an employee").toBeTruthy();

	await page.goto("/");
	await signIn(page);
	await page.goto("/admin");
	await page.getByRole("tab", { name: "Aktionen (ioBroker)" }).click();

	// a rule like the one a fingerprint reader needs: the state carries `1`, the punch goes to Anna
	await page.getByRole("button", { name: "Aktion hinzufügen" }).click();
	await page.getByLabel("Bezeichnung").fill("Finger am Leser");
	await page.getByLabel("Datenpunkt").fill("fingerprint.0.lastMatch");
	await page.getByLabel("Wert", { exact: true }).fill("1");
	await page.getByLabel("Mitarbeiter").click();
	await page.getByRole("option", { name: anna.displayName }).click();
	await page.getByRole("button", { name: "Speichern", exact: true }).click();

	await expect
		.poll(async () => (await stored()).map(rule => `${rule.sourceState}|${rule.condition}|${rule.userId}`))
		.toEqual([`fingerprint.0.lastMatch|1|${anna.id}`]);

	// the table is saved as a whole: removing the row and saving an empty table clears it
	await page.getByTitle("Löschen").click();
	await page.getByRole("button", { name: "Speichern", exact: true }).click();
	await expect.poll(async () => (await stored()).length).toBe(0);
});
