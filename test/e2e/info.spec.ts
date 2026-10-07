/**
 * Browser test of the page "Info": the version of the app and of the adapter is for the administrator only.
 */
import { expect, test, type Page } from "@playwright/test";

/** Credentials of the accounts the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };
const ben = { login: "ben", password: "E2e-2026-klar!" };

/**
 * Fills in the login form.
 *
 * @param page - page under test
 * @param user - account to sign in with
 * @param user.login - login name of the account
 * @param user.password - password of the account
 */
async function signInAs(page: Page, user: { login: string; password: string }): Promise<void> {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(user.login);
	await page.getByLabel("Passwort").fill(user.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
}

test("shows the versions of the app and of the adapter to the administrator", async ({ page }) => {
	await signInAs(page, admin);
	await expect(page.getByText("Dieses Konto dient der Verwaltung")).toBeVisible();

	await page.getByTitle("Menü").click();
	// the version stands at the end of the menu, small, next to the entry that opens the page
	await expect(page.locator("#menu-version")).toContainText("Adapter 0.0.1-e2e");
	await page.getByRole("menuitem", { name: "Info" }).click();

	await expect(page.getByRole("heading", { name: "Info" })).toBeVisible();
	await expect(page.locator("#info-adapter-version")).toHaveText("0.0.1-e2e");
	// the app comes from the package of the build, so it differs from the server of the test: the page says so
	await expect(page.locator("#info-app-version")).toHaveText(/^\d+\.\d+\.\d+/);
	await expect(page.getByText("verschiedene Versionen")).toBeVisible();
	await expect(page.getByRole("button", { name: "Neu laden" })).toBeVisible();
});

test("does not show the version or the page to an employee", async ({ page, request }) => {
	await signInAs(page, ben);
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();

	await page.getByTitle("Menü").click();
	await expect(page.getByRole("menuitem", { name: "Profil" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Info" })).toHaveCount(0);
	await expect(page.locator("#menu-version")).toHaveCount(0);

	// the page itself refuses as well, and the server answers 403 to the account of an employee
	await page.keyboard.press("Escape");
	await page.goto("/info");
	await expect(page.getByText("dürfen die Verwaltung nicht öffnen")).toBeVisible();
	const login = await request.post("/api/auth/login", { data: ben });
	const session = (await login.json()) as { token: string };
	const refused = await request.get("/api/system/info", { headers: { "x-session-token": session.token } });
	expect(refused.status()).toBe(403);
});
