/**
 * Browser test of the automation rules.
 *
 * The card shows one row per rule and the form lives in a dialog — the save button of the card belongs to the rules
 * and must not carry the caption of the break rules.
 */
import { expect, test } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

test("shows the automation rules as rows and edits one in a dialog", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByText("Dieses Konto dient der Verwaltung")).toBeVisible();

	await page.goto("/admin");
	await page.getByRole("tab", { name: "Einstellungen" }).click();

	// the card of the automation rules — the break rules have a “Regel hinzufügen” of their own
	const card = page.getByTestId("automation-rules");
	await expect(card.getByText("Regeln (Automatik)")).toBeVisible();

	// the save button of this card is its own; the caption of the break rules is nowhere on this screen
	await expect(card.getByRole("button", { name: "Regeln speichern" })).toBeVisible();

	// a new rule opens in the dialog, and saving it turns it into one row of the list
	await card.getByRole("button", { name: "Regel hinzufügen" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Neue Regel")).toBeVisible();
	await dialog.getByRole("button", { name: "Speichern" }).click();
	await expect(dialog).toBeHidden();

	// the row carries the rule and the actions of a row
	const row = card.locator("li").filter({ hasText: "Automatisch ausstempeln" }).first();
	await expect(row).toBeVisible();
	await expect(row.getByRole("button", { name: "Aktiv" })).toBeVisible();
	await expect(row.getByRole("button", { name: "Bearbeiten" })).toBeVisible();

	// editing opens the dialog with the stored rule again
	await row.getByRole("button", { name: "Bearbeiten" }).click();
	const editDialog = page.getByRole("dialog");
	await expect(editDialog.getByText("Regel bearbeiten")).toBeVisible();
	await editDialog.getByRole("button", { name: "Abbrechen" }).click();
	await expect(editDialog).toBeHidden();

	// the list is saved as a whole, so the new rule is kept
	await card.getByRole("button", { name: "Regeln speichern" }).click();
	await expect(card.getByText("nicht akzeptiert")).toHaveCount(0);
});
