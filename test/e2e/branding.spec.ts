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

	const veiled = await page.evaluate(() => {
		const node = [...document.querySelectorAll("div")].find(entry =>
			getComputedStyle(entry).backgroundImage.includes("branding/background"),
		);
		return node ? getComputedStyle(node).backgroundImage : "";
	});
	expect(veiled, "the background picture should be painted").toContain("branding/background");
	// the veil in front of the picture carries the colour, so both settings are visible together
	expect(veiled, "the colour should tint the picture").toContain("26, 43, 60");

	const colored = await page.evaluate(() =>
		[...document.querySelectorAll("div")].some(
			node => getComputedStyle(node).backgroundColor === "rgb(26, 43, 60)",
		),
	);
	expect(colored, "the accent colour should be painted").toBe(true);

	// the settings offer a row of suggested colours: one click stores the colour and paints it
	await page.goto("/admin");
	await page.getByRole("tab", { name: "Einstellungen" }).click();
	// a darker shade from the second block
	await page.getByLabel("#b7cbe2").click();
	await page.getByRole("button", { name: "Speichern", exact: true }).click();

	const stored = await request.get("/api/branding");
	expect((await stored.json()).color).toBe("#b7cbe2");
	await expect
		.poll(async () =>
			page.evaluate(() =>
				[...document.querySelectorAll("div")].some(
					node => getComputedStyle(node).backgroundColor === "rgb(183, 203, 226)",
				),
			),
		)
		.toBe(true);
});

test("takes an uploaded background picture away again", async ({ page, request }) => {
	const session = await signInApi(request);
	const saved = await request.put("/api/settings", {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { brand_logo: png, brand_background: png, brand_color: "#1a2b3c" },
	});
	expect(saved.status()).toBe(200);

	await page.goto("/");
	await signIn(page);
	await page.goto("/admin");
	await page.getByRole("tab", { name: "Einstellungen" }).click();

	// every picture field offers to take its picture away — the logo field and the background field
	await expect(page.getByRole("button", { name: "Bild entfernen" })).toHaveCount(2);

	// "Standard" puts colour and background picture back in one click; the logo is a separate choice and stays
	await page.getByRole("button", { name: "Standard", exact: true }).click();
	await page.getByRole("button", { name: "Speichern", exact: true }).click();

	const branding = async (): Promise<Record<string, unknown>> =>
		(await (await request.get("/api/branding")).json()) as Record<string, unknown>;
	// the save and the repaint of the shell need a moment: give both checks room, the runner of the pipeline is slower
	await expect.poll(branding, { timeout: 20_000 }).toMatchObject({ backgroundUrl: null, color: null });
	expect((await branding()).logoUrl, "the logo should stay").not.toBeNull();

	await expect
		.poll(
			async () =>
				page.evaluate(() =>
					[...document.querySelectorAll("div")].some(node =>
						getComputedStyle(node).backgroundImage.includes("branding/background"),
					),
				),
			{ timeout: 20_000 },
		)
		.toBe(false);
});

// the suite shares one instance: put the branding back so the file can run again (and in any order)
test.afterAll(async ({ request }) => {
	const session = await signInApi(request);
	const cleared = await request.put("/api/settings", {
		headers: { "x-session-token": session.token, "x-csrf-token": session.csrfToken },
		data: { brand_logo: "", brand_background: "", brand_color: "" },
	});
	expect(cleared.status()).toBe(200);
});
