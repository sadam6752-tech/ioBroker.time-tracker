/**
 * Browser test of the branding: the administration stores a logo, a background and a colour, and the app shows them.
 *
 * The pictures are set through the API (that is what the settings dialog does as well). The test then walks the
 * sign in screen — which reads the branding without a session — and the signed in shell.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Credentials of the administrator the end-to-end server seeds. */
const admin = { login: "admin", password: "E2e-2026-klar!" };

/** A 1×1 pixel PNG as a data URL. */
const png =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** Session of the test. */
interface AdminSession {
	/** Session token */
	token: string;
	/** CSRF token of the same session */
	csrfToken: string;
}

/**
 * Signs in through the API, like the web app does.
 *
 * @param request - API client of the test
 * @returns the tokens of the session
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
	await page.getByLabel("Benutzername").fill(admin.login);
	await page.getByLabel("Passwort").fill(admin.password);
	await page.getByRole("button", { name: "Anmelden" }).click();
	await expect(page.getByRole("button", { name: /Einstempeln|Ausstempeln/ })).toBeVisible();
}

test("shows the logo, the background and the accent colour of the installation", async ({ page, request }) => {
	// without a configuration nothing is painted: the app looks the way it always did
	await page.goto("/");
	await expect(page.locator("img[src*='/api/branding/logo']")).toHaveCount(0);

	const session = await signInApi(request);
	const saved = await request.put("/api/settings", {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { brand_logo: png, brand_background: png, brand_color: "#1a2b3c" },
	});
	expect(saved.status()).toBe(200);

	// the sign in screen shows the logo as well — it is read without a session
	await page.goto("/");
	const logo = page.locator("img[src*='/api/branding/logo']");
	await expect(logo).toBeVisible();
	await signIn(page);

	// the signed in shell carries the logo in its header and paints the picture plus the colour
	await expect(page.locator("header img[src*='/api/branding/logo']")).toBeVisible();

	const painted = await page.evaluate(() =>
		[...document.querySelectorAll("div")].some(node =>
			getComputedStyle(node).backgroundImage.includes("branding/background"),
		),
	);
	expect(painted, "the background picture should be painted").toBe(true);

	const colored = await page.evaluate(() =>
		[...document.querySelectorAll("div")].some(
			node => getComputedStyle(node).backgroundColor === "rgb(26, 43, 60)",
		),
	);
	expect(colored, "the accent colour should be painted").toBe(true);
});
