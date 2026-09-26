/**
 * Browser test of the public holidays.
 *
 * The administration keeps the holidays of a year: a card with the form and the list of the shown year. The date comes
 * from the picker of the browser (`type="date"`), so “Feiertag hinzufügen” only waits for a day and a name — with a
 * plain text field it stayed locked until the date was typed as `YYYY-MM-DD`.
 */
import { expect, test } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

test("adds a public holiday and removes it again", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByText("Dieses Konto dient der Verwaltung")).toBeVisible();

	await page.goto("/admin");
	await page.getByRole("tab", { name: "Feiertage" }).click();

	// the year the tab shows is the current one, and it can be typed
	const year = new Date().getFullYear();
	const yearField = page.getByLabel("Jahr");
	await expect(yearField).toHaveValue(String(year));

	// the button stays locked until the day and the name are there
	const addButton = page.getByRole("button", { name: "Feiertag hinzufügen" });
	await expect(addButton).toBeDisabled();

	const dateField = page.getByLabel("Datum");
	await expect(dateField).toHaveAttribute("type", "date");
	await dateField.fill(`${year}-06-01`);
	await expect(addButton).toBeDisabled();
	await page.getByLabel("Bezeichnung").fill("Kindertag");
	await page.getByLabel("Region (optional)").fill("BE");
	await expect(addButton).toBeEnabled();
	await addButton.click();

	// the day stands in the list with the region that was given, and the form is empty again
	const row = page
		.locator("li")
		.filter({ hasText: `01.06.${year} · Kindertag` })
		.first();
	await expect(row).toBeVisible();
	await expect(row).toContainText("BE");
	await expect(dateField).toHaveValue("");
	await expect(addButton).toBeDisabled();

	// …and it can be taken out of the list again
	await row.getByRole("button", { name: "Löschen" }).click();
	await expect(page.getByText(`01.06.${year} · Kindertag`)).toHaveCount(0);

	// a holiday of another year moves the shown year along with it, and without a region it belongs to the country
	// of the instance
	await dateField.fill(`${year + 1}-01-02`);
	await page.getByLabel("Bezeichnung").fill("Testtag");
	await addButton.click();
	await expect(yearField).toHaveValue(String(year + 1));
	const nextYearRow = page
		.locator("li")
		.filter({ hasText: `02.01.${year + 1} · Testtag` })
		.first();
	await expect(nextYearRow).toBeVisible();
	await expect(nextYearRow).toContainText("DE");
	await nextYearRow.getByRole("button", { name: "Löschen" }).click();
	await expect(page.getByText(`02.01.${year + 1} · Testtag`)).toHaveCount(0);
});
