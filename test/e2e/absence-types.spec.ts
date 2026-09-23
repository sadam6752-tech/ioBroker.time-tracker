/**
 * Browser test of the absence types.
 *
 * The administration keeps the types in a card: one row per type, the form in a dialog, and the row of the type that
 * uses up the vacation allowance carries the hint.
 */
import { expect, test } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

test("shows the absence types and adds one in a dialog", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();

	await page.goto("/admin");
	await page.getByRole("tab", { name: "Einstellungen" }).click();

	const card = page.getByTestId("absence-types");
	await expect(page.getByText("Abwesenheitsarten", { exact: true })).toBeVisible();

	// the type that uses up the vacation is marked, the others are not
	await expect(card.getByText("F – Ferien (Urlaub)")).toBeVisible();
	const sickRow = card.locator("li").filter({ hasText: "K – Krankheit" }).first();
	await expect(sickRow).toBeVisible();
	await expect(sickRow.getByText("(Urlaub)")).toHaveCount(0);

	// a new type opens in the dialog and lands in the list
	await page.getByRole("button", { name: "Art hinzufügen" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("Neue Art")).toBeVisible();
	await dialog.getByLabel("Kürzel").fill("T");
	await dialog.getByLabel("Bezeichnung").fill("Testart");
	await dialog.getByTestId("absence-type-save").click();
	await expect(dialog).toBeHidden();
	await expect(card.getByText("T – Testart")).toBeVisible();

	// editing opens the dialog with the stored type again
	const testRow = card.locator("li").filter({ hasText: "T – Testart" }).first();
	await testRow.getByRole("button", { name: "Bearbeiten" }).click();
	const editDialog = page.getByRole("dialog");
	await expect(editDialog.getByText("Art bearbeiten")).toBeVisible();
	await expect(editDialog.getByLabel("Kürzel")).toHaveValue("T");
	await editDialog.getByRole("button", { name: "Abbrechen" }).click();
	await expect(editDialog).toBeHidden();

	// a type that nothing uses can be removed again
	await testRow.getByRole("button", { name: "Löschen" }).click();
	const confirm = page.getByRole("dialog");
	await expect(confirm.getByText("Art löschen")).toBeVisible();
	await expect(confirm.getByText("T – Testart", { exact: false })).toBeVisible();
	await confirm.getByTestId("absence-type-remove-save").click();
	await expect(confirm).toBeHidden();
	await expect(card.getByText("T – Testart")).toHaveCount(0);
});
