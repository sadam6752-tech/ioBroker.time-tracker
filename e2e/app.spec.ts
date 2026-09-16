/**
 * Browser tests of the web app.
 *
 * They run against `e2e/server.mjs`, which starts the real API on an in-memory database and serves the built web
 * app — no ioBroker needed. The service worker is blocked on purpose (see `playwright.config.ts`).
 */
import { expect, test, type Page } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/** Credentials of an account that still has to change its start password. */
const fresh = { login: "start", password: "E2e-2026-klar!", next: "Frisch-2026-klar!" };

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

test("asks for a new password when the start password was used", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(fresh.login);
	await page.getByLabel("Passwort").fill(fresh.password);
	await page.getByRole("button", { name: "Anmelden" }).click();

	// the start password opens the door exactly once: the app asks for a new one before it shows anything else
	await expect(page.getByRole("heading", { name: "Passwort ändern" })).toBeVisible();
	await page.getByLabel("Neues Passwort").fill(fresh.next);
	await page.getByRole("button", { name: "Passwort ändern" }).click();

	// the change ends the session: from now on the new password opens the door and the start password does not
	await expect(page.getByLabel("Benutzername")).toBeVisible();
	await page.getByLabel("Benutzername").fill(fresh.login);
	await page.getByLabel("Passwort").fill(fresh.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByText(/nicht korrekt/)).toBeVisible();

	await page.getByLabel("Passwort").fill(fresh.next);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
});

test("shows the days of the month with their columns", async ({ page }) => {
	await signIn(page);
	await page.getByRole("button", { name: "Monat" }).click();

	await expect(page.getByRole("heading", { name: "Monat" })).toBeVisible();
	await expect(page.getByText("Gearbeitet").first()).toBeVisible();
	await expect(page.getByText("Saldo").first()).toBeVisible();
});

test("hands the statement of the month to the browser as a PDF", async ({ page }) => {
	await signIn(page);
	await page.getByRole("button", { name: "Monat" }).click();
	await expect(page.getByRole("heading", { name: "Monat" })).toBeVisible();

	// the file needs the session token, so the app fetches it and hands it over as a blob
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "PDF" }).first().click();
	expect((await download).suggestedFilename()).toMatch(/\.pdf$/i);
});

test("requests an absence in the form and finds it in the year", async ({ page, request }) => {
	await signIn(page);
	await page.getByRole("button", { name: "Abwesenheiten" }).click();

	await expect(page.getByRole("heading", { name: "Abwesenheiten" })).toBeVisible();
	// the type is a select: the click on an option has to be taken over into the field
	const type = page.getByRole("combobox", { name: "Art" });
	await type.click();
	const option = page.getByRole("option").first();
	const chosen = ((await option.textContent()) ?? "").trim();
	await option.click();
	await expect(type).toContainText(chosen.slice(0, 1));

	await page.getByLabel("Von").fill("2026-10-05");
	await page.getByLabel("Bis").fill("2026-10-09");
	await page.locator('form button[type="submit"]').click();
	await expect(page.getByText("Abwesenheit beantragt.")).toBeVisible();

	// the row names the type: the payload carries the code of the type, not only its id (it used to read
	// "undefined" here because the record of the API only knew the id)
	const code = chosen.split(" ")[0];
	await expect(page.getByText(new RegExp(`^${code}: `))).toBeVisible();

	// the API stored it for the employee the administrator requested it for
	const login = await request.post("/api/auth/login", { data: admin });
	expect(login.status()).toBe(200);
	const session = (await login.json()) as { token: string };
	const list = await request.get("/api/absences?year=2026", { headers: { "x-session-token": session.token } });
	expect(list.status()).toBe(200);
	const stored = (await list.json()) as { absences: { dateFrom: string; dateTo: string }[] };
	expect(stored.absences.some(entry => entry.dateFrom === "2026-10-05" && entry.dateTo === "2026-10-09")).toBe(true);
});
