/**
 * Browser test of the employee management: the administration creates an account and picks its role.
 *
 * The role field is a MUI `select`. A native `<option>` inside it looks right in the markup but silently ignores
 * the click, so the test picks a role and checks that the chosen name really ends up in the field — and that the
 * new account is listed with it.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/** Session of the test. */
interface AdminSession {
	/** Session token */
	token: string;
}

/**
 * Signs in through the API, like the web app does.
 *
 * @param request - API client of the test
 * @returns the token of the session
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

test("creates an employee with the chosen role", async ({ page, request }) => {
	await signIn(page);
	await page.goto("/admin");

	await page.getByRole("button", { name: "Mitarbeiter anlegen" }).click();
	await page.getByLabel("Benutzername").fill("testkraft");
	await page.getByLabel("Name", { exact: true }).fill("Testkraft Muster");
	await page.getByLabel("Passwort").fill("Zeit-2026-klar");

	// The click on a role has to be taken over into the field. The preset role is skipped on purpose — only a
	// different one proves that the click really selects (with a native `<option>` the field keeps the preset).
	const field = page.getByRole("combobox", { name: /Rollen/ });
	const preset = (await field.textContent())?.trim() ?? "";
	await field.click();

	const options = page.getByRole("option");
	let index = -1;
	for (let i = 0; i < (await options.count()); i++) {
		const text = ((await options.nth(i).textContent()) ?? "").trim();
		if (text && text !== preset) {
			index = i;
			break;
		}
	}
	expect(index, "there has to be a role that differs from the preset one").toBeGreaterThanOrEqual(0);

	const option = options.nth(index);
	const roleName = ((await option.textContent()) ?? "").trim();
	await option.click();
	await expect(field).toContainText(roleName);

	await page.getByRole("button", { name: "Speichern" }).click();

	// the new account is listed
	await expect(page.getByText("Testkraft Muster")).toBeVisible();

	// and the API stored exactly that one role (the preset would have been `employee`)
	const session = await signInApi(request);
	const list = await request.get("/api/users", { headers: { "x-session-token": session.token } });
	const stored = ((await list.json()) as { users: { login: string; roles: string[] }[] }).users.find(
		user => user.login === "testkraft",
	);
	expect(stored?.roles ?? []).toHaveLength(1);
	expect(stored?.roles ?? []).not.toEqual(["employee"]);
});

test("creates a terminal for a group of employees", async ({ page }) => {
	await signIn(page);
	await page.goto("/admin");
	await page.getByRole("tab", { name: "Terminals" }).click();

	// the dialog offers the employees of the installation: pick the first one
	await page.getByRole("button", { name: "Terminal anlegen" }).click();
	await page.getByRole("dialog").getByLabel("Name").fill("Werkstatt");
	await page.getByRole("dialog").getByLabel("Anna Muster").click();
	await page.getByRole("dialog").getByRole("button", { name: "Terminal anlegen" }).click();

	// the new terminal is listed, and its line names the employees instead of “all employees”
	const row = page.getByRole("listitem").filter({ hasText: "Werkstatt" });
	await expect(row).toBeVisible();
	await expect(row).toContainText("Anna Muster");

	// the assignment can be changed afterwards: clearing it means “all employees” again
	await row.getByRole("button", { name: "Mitarbeiter" }).click();
	await page.getByRole("dialog").getByLabel("Anna Muster").click();
	await page.getByRole("dialog").getByRole("button", { name: "Speichern" }).click();
	await expect(page.getByRole("listitem").filter({ hasText: "Werkstatt" })).toContainText("alle Mitarbeiter");
});
