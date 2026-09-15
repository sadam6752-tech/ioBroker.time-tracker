import { defineConfig, devices } from "@playwright/test";

/** Port the end-to-end server listens on (the same default as `e2e/server.mjs`). */
const port = Number(process.env.E2E_PORT ?? 8099);

/**
 * Configuration of the browser tests.
 *
 * The suite runs against `e2e/server.mjs`, which starts the **real** API on an in-memory database and serves the
 * built web app (`npm run build` and `npm run build:pwa` have to run first). The browser talks German and lives in
 * the instance time zone, so the assertions can use the same texts a real user sees.
 */
export default defineConfig({
	testDir: "./e2e",
	// one shared instance for the whole suite, so the tests must not run in parallel
	workers: 1,
	fullyParallel: false,
	timeout: 30_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		locale: "de-DE",
		timezoneId: "Europe/Berlin",
		// the built app registers a service worker that precaches the bundle and serves it from the cache; that
		// would hide a fresh build behind the caching of a previous run, so it stays out of the tests
		serviceWorkers: "block",
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "node e2e/server.mjs",
		url: `http://127.0.0.1:${port}/api/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		stdout: "pipe",
	},
});
