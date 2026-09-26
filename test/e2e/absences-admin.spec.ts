/**
 * Browser test of the absence tab of the administration.
 *
 * The tab decides about the requests of the employees, lets the administration enter dates for somebody and shows who
 * is away. What the administration enters is approved right away, so the row carries the state “genehmigt”.
 */
import { expect, test } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

test("shows the absence tab and enters an absence for an employee", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByText("Dieses Konto dient der Verwaltung")).toBeVisible();

	await page.goto("/admin");
	await page.getByRole("tab", { name: "Abwesenheiten" }).click();

	// the sections of the tab are there
	const requests = page.getByTestId("absence-requests");
	await expect(requests).toBeVisible();
	await expect(page.getByText("Offene Anträge")).toBeVisible();
	await expect(page.getByTestId("absence-away")).toBeVisible();
	const list = page.getByTestId("absence-all");
	await expect(list).toBeVisible();

	// the administration enters a vacation for an employee: it counts as approved straight away
	await page.getByTestId("absence-add").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("Abwesenheit erfassen")).toBeVisible();
	await dialog.getByLabel("Von").fill("2026-12-21");
	await dialog.getByLabel("Bis").fill("2026-12-24");
	await dialog.getByLabel("Notiz (optional)").fill("Weihnachtsferien");
	await dialog.getByTestId("absence-create-save").click();
	await expect(dialog).toBeHidden();

	const row = list.locator("li").filter({ hasText: "genehmigt" }).first();
	await expect(row).toBeVisible();

	// “Ändern” opens the form with the stored values — and “Abbrechen” closes it again: the dialog is open
	// while a new absence is entered **or** while an existing one is changed, so both flags have to be cleared
	// (it used to close only the “new” one and the edit dialog stayed on the screen)
	const ownRow = list.locator("li").filter({ hasText: "21.12.2026" }).first();
	await ownRow.getByRole("button", { name: "Ändern" }).click();
	const editDialog = page.getByRole("dialog");
	await expect(editDialog.getByText("Abwesenheit ändern")).toBeVisible();
	await expect(editDialog.getByLabel("Von")).toHaveValue("2026-12-21");
	await editDialog.getByRole("button", { name: "Abbrechen" }).click();
	await expect(editDialog).toBeHidden();

	// the request section stays empty, because nothing waits for a decision
	await expect(page.getByText("Keine offenen Anträge — alles entschieden.")).toBeVisible();

	// the calendar shows the month; the year is selectable and the month can be walked through
	const calendar = page.getByTestId("absence-calendar");
	await expect(calendar).toBeVisible();
	await expect(calendar.locator("td").first()).toBeVisible();
	await expect(page.getByLabel("Jahr")).toBeVisible();
	await page.getByTestId("calendar-next").click();
	await expect(calendar).toBeVisible();
	await expect(page.getByTestId("calendar-previous")).toBeVisible();
});
