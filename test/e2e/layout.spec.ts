/**
 * Layout test of the list rows.
 *
 * Every row of a list keeps its actions beside the text. MUI's `secondaryAction` only reserves the width of one
 * small icon, so rows with text buttons (the employees and the terminals of the administration, for example) once
 * laid those buttons over the name on a phone. This suite measures the same geometry a user sees: on a narrow
 * screen no row may have a text box and an action box that share an area.
 */
import { expect, test, type Page } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/**
 * Signs the administrator in.
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

/**
 * Collects the rows whose text and actions share an area.
 *
 * The action of a row is either MUI's own container (`secondaryAction`) or the stack the row renders beside the
 * text, so the check works before and after a row was rebuilt.
 *
 * @param page - page under test
 * @returns the text of every affected row
 */
async function overlappingRows(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll("li")].flatMap(row => {
			const text = row.querySelector(".MuiListItemText-root");
			const side = row.querySelector('[class*="MuiListItemSecondaryAction-root"]');
			const action = side ?? [...row.querySelectorAll(".MuiStack-root")].find(stack => !text?.contains(stack));
			if (!text || !action) {
				return [];
			}
			const left = text.getBoundingClientRect();
			const right = action.getBoundingClientRect();
			if (left.width === 0 || right.width === 0) {
				return [];
			}
			// one pixel of tolerance: sub pixel rounding is not an overlap
			const overlaps =
				left.left < right.right - 1 &&
				right.left < left.right - 1 &&
				left.top < right.bottom - 1 &&
				right.top < left.bottom - 1;
			return overlaps ? [(row.textContent ?? "").trim().slice(0, 60)] : [];
		}),
	);
}

test("keeps the actions of a row beside the text on a phone", async ({ page }) => {
	// a phone in portrait: the actions have to wrap below the text instead of covering it
	await page.setViewportSize({ width: 360, height: 780 });
	await signIn(page);

	for (const route of ["/month", "/reports", "/absences", "/admin"]) {
		await page.goto(route);
		await expect.poll(() => overlappingRows(page), { message: route }).toEqual([]);
	}

	// and through every tab of the administration (it shows the widest buttons)
	const tabs = page.getByRole("tab");
	const count = await tabs.count();
	for (let index = 0; index < count; index++) {
		await tabs.nth(index).click();
		await expect.poll(() => overlappingRows(page)).toEqual([]);
	}
});
