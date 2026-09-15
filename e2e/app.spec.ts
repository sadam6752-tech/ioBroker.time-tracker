/**
 * Browser tests of the web app.
 *
 * They run against `e2e/server.mjs`, which starts the real API on an in-memory database and serves the built web
 * app — no ioBroker needed. The service worker is blocked on purpose (see `playwright.config.ts`).
 */
import { expect, test, type Page } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/**
 * Signs the administrator in and waits for the punch screen.
 *
 * @param page - page under test
 */
async function signIn(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	// the punch screen is there when its button is. Whether the day is started already depends on the other
	// tests of this file (they share one database), so the state itself must not be asserted here
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
}

test("refuses a wrong password and lets the administrator in", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill("Falsch-2026-gemischt");
	await page.getByRole("button", { name: "Anmelden" }).click();

	// the message comes from the problem document of the API
	await expect(page.getByText(/nicht korrekt/)).toBeVisible();

	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
});

test("survives a reload on the cookie alone and can still punch", async ({ page }) => {
	await signIn(page);

	// the session token lives in an httpOnly cookie; only the CSRF token and the user are stored in the page
	const stored = await page.evaluate(() => window.localStorage.getItem("zeiterfassung.session") ?? "");
	expect(stored).not.toContain('"token"');

	await page.reload();
	// no login screen: the cookie is enough. The CSRF token is fetched again with `GET /auth/me`
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();

	// punching flips the label of that very button
	const before = await page.getByRole("button", { name: /Einstempeln|Ausstempeln/ }).innerText();
	await page.getByRole("button", { name: /Einstempeln|Ausstempeln/ }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).not.toHaveText(before);
});

test("shows the figures of all employees in the statistics", async ({ page }) => {
	await signIn(page);
	await page.getByRole("button", { name: "Statistik" }).click();

	await expect(page.getByText("Alle Mitarbeiter")).toBeVisible();
	await expect(page.getByText("Anna Muster")).toBeVisible();
});

test("asks the kiosk screen for its device token", async ({ page }) => {
	// the kiosk screen has no user session: it is opened with the device token of a terminal
	await page.goto("/terminal");
	await expect(page.getByLabel("Geräte-Token")).toBeVisible();
	await expect(page.getByRole("button", { name: "Verbinden" })).toBeDisabled();
});

test("reports a badge link that cannot be redeemed", async ({ page }) => {
	// the badge link carries a signed token; a forged one is refused by the server
	await page.goto("/?tag=gefaelscht.1.9999999999.abc");
	await expect(page.getByRole("heading", { name: "Ausweis" })).toBeVisible();
	await expect(page.getByText(/konnte nicht verwendet werden/)).toBeVisible();

	// the token is taken out of the address bar, so a reload does not try again
	await expect(page).toHaveURL(/^[^?]*$/);
});
