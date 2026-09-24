/**
 * Browser tests of the day notes and of the correction the administration does in the month of an employee.
 *
 * The punches are written through the API (that is what the dialog does as well), and the test then walks the real
 * screens: the month of the employee with her note, and the month the administration opened for that employee.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Credentials the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };
const anna = { login: "anna", password: "E2e-2026-klar!" };

/** Session of a test. */
interface Session {
	/** Session token */
	token: string;
	/** CSRF token of the same session */
	csrfToken: string;
}

/** The day these tests work on: the 15th of the previous month, so no other spec touches it. */
const target = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15);
const year = target.getFullYear();
const monthIndex = target.getMonth();
const month = String(monthIndex + 1).padStart(2, "0");
const day = `${year}-${month}-15`;
/** Position of that day in the list of its month (the rows start with the first day). */
const rowIndex = 14;
/** Label the month view shows for the target month. */
const monthLabel = new Intl.DateTimeFormat("de", { month: "long", year: "numeric", timeZone: "UTC" }).format(target);

/**
 * Signs in through the API, like a browser does.
 *
 * @param request - API client of the test
 * @param user - credentials to use
 * @param user.login - login name of the account
 * @param user.password - password of the account
 * @returns the tokens of the session
 */
async function signInApi(request: APIRequestContext, user: { login: string; password: string }): Promise<Session> {
	const login = await request.post("/api/auth/login", { data: user });
	expect(login.status()).toBe(200);
	return (await login.json()) as Session;
}

/**
 * Signs in on the page.
 *
 * @param page - page under test
 * @param user - credentials to use
 * @param user.login - login name of the account
 * @param user.password - password of the account
 */
async function signInOnPage(page: Page, user: { login: string; password: string }): Promise<void> {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(user.login);
	await page.getByLabel("Passwort").fill(user.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
}

test("an employee comments a day and the administration handles the note", async ({ page }) => {
	await signInOnPage(page, anna);
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
	await page.getByRole("button", { name: "Monat" }).click();
	await expect(page.getByRole("heading", { name: "Monat" })).toBeVisible();

	// a day in the past, so the note does not land on today (the other specs punch today)
	await page.getByRole("button", { name: "Voriger Monat" }).click();
	await expect(page.getByText(monthLabel, { exact: true })).toBeVisible();

	// the own day only offers the note: the times of a day belong to the administration
	const row = page.getByRole("listitem").nth(rowIndex);
	await row.getByRole("button", { name: "Korrigieren" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: /Notiz zum Tag/ })).toBeVisible();
	await expect(dialog.getByLabel("Zeit")).toHaveCount(0);
	await dialog.getByLabel("Notiz für die Verwaltung").fill("Habe vergessen auszustempeln");
	await dialog.getByRole("button", { name: "Speichern" }).click();
	await expect(dialog).toBeHidden();

	// the day carries the note from now on, so the employee sees that it was left
	await expect(page.getByRole("listitem").nth(rowIndex).getByTestId("StickyNote2Icon")).toBeVisible();
});

test("the administration corrects the day of an employee and sees her note", async ({ page, request }) => {
	const session = await signInApi(request, admin);
	const list = await request.get("/api/users", { headers: { "x-session-token": session.token } });
	const users = ((await list.json()) as { users: { id: number; login: string }[] }).users;
	const annaId = users.find(user => user.login === "anna")!.id;

	// a punch of the employee and the note she left: the administration has to see both in her day
	const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
	const headers = {
		"x-session-token": session.token,
		"x-csrf-token": session.csrfToken,
		"content-type": "application/json",
	};
	const created = await request.post(`/api/entries?userId=${annaId}`, {
		headers,
		data: { tsUtc: dayStart + 9 * 3600, direction: "in", note: "Nachtrag Test", reason: "Testkorrektur" },
	});
	expect(created.status()).toBe(201);
	const noted = await request.put(`/api/day-notes?date=${day}&userId=${annaId}`, {
		headers,
		data: { note: "Habe vergessen auszustempeln" },
	});
	expect(noted.status()).toBe(200);

	await signInOnPage(page, admin);
	await expect(page.getByText("Dieses Konto dient der Verwaltung")).toBeVisible();
	await page.goto(`/month?year=${year}&month=${monthIndex + 1}&userId=${annaId}&name=Anna%20Muster`);
	await expect(page.getByRole("heading", { name: /Monat · Anna Muster/ })).toBeVisible();

	// the day of the employee opens with her punch and her note — the administrator has no punch of his own
	const row = page.getByRole("listitem").nth(rowIndex);
	await row.getByRole("button", { name: "Korrigieren" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: /Stempel korrigieren/ })).toBeVisible();
	await expect(dialog.getByLabel("Zeit")).toHaveCount(1);
	await expect(dialog.getByText("Habe vergessen auszustempeln")).toBeVisible();

	// marking the note as handled is what the administration does after booking the day
	await dialog.getByRole("button", { name: "Als erledigt markieren" }).click();
	await expect(dialog.getByRole("button", { name: "Wieder öffnen" })).toBeVisible();
	await dialog.getByRole("button", { name: "Abbrechen" }).click();
	await expect(page.getByRole("listitem").nth(rowIndex).getByTestId("StickyNote2Icon")).toBeVisible();
});
