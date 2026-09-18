/**
 * Server for the end-to-end tests.
 *
 * It runs the **real** server stack — the API, the static web app and the live stream — on an in-memory database,
 * so Playwright talks to the same code that the adapter ships, only without ioBroker around it. The build output
 * is required (`npm run build`), because the JavaScript is imported from `build/`.
 *
 * Environment:
 *   E2E_PORT      port to listen on (default 8099)
 *   E2E_PASSWORD  password of the seeded administrator (default `E2e-2026-klar!`)
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const { openAndMigrate } = require(join(repo, "build/lib/db/database.js"));
const { seed } = require(join(repo, "build/lib/db/seed.js"));
const { createUsersRepository } = require(join(repo, "build/lib/db/repositories/users.js"));
const { createEntriesRepository } = require(join(repo, "build/lib/db/repositories/entries.js"));
const { createAbsencesRepository } = require(join(repo, "build/lib/db/repositories/absences.js"));
const { createHolidaysRepository } = require(join(repo, "build/lib/db/repositories/holidays.js"));
const { createRulesRepository } = require(join(repo, "build/lib/db/repositories/rules.js"));
const { createPayoutsRepository } = require(join(repo, "build/lib/db/repositories/payouts.js"));
const { createTerminalsRepository } = require(join(repo, "build/lib/db/repositories/terminals.js"));
const { createRfidRepository } = require(join(repo, "build/lib/db/repositories/rfid.js"));
const { createTriggersRepository } = require(join(repo, "build/lib/db/repositories/triggers.js"));
const { createAutomationsRepository } = require(join(repo, "build/lib/db/repositories/automations.js"));
const { createSettingsRepository } = require(join(repo, "build/lib/db/repositories/settings.js"));
const { createAuthService } = require(join(repo, "build/lib/services/auth.js"));
const { createAggregationService } = require(join(repo, "build/lib/services/aggregation.js"));
const { createSyncService } = require(join(repo, "build/lib/services/sync.js"));
const { createBackupService } = require(join(repo, "build/lib/services/backup.js"));
const { createApi, MAX_BACKUP_UPLOAD_BYTES } = require(join(repo, "build/lib/web/api.js"));
const { createStaticHandler } = require(join(repo, "build/lib/web/static.js"));
const { startWebServer } = require(join(repo, "build/lib/web/server.js"));

const port = Number(process.env.E2E_PORT ?? 8099);
const adminPassword = process.env.E2E_PASSWORD ?? "E2e-2026-klar!";
const version = "0.0.1-e2e";
const now = () => Math.floor(Date.now() / 1000);

/**
 * Data directory of this run.
 *
 * A queued restore needs a database *file* to swap — an in-memory database cannot be restored at all, and the
 * suite hands an uploaded backup back in. The directory is thrown away with the process.
 */
const dataDir = require("node:fs").mkdtempSync(join(require("node:os").tmpdir(), "zeiterfassung-e2e-data-"));
const db = openAndMigrate(join(dataDir, "zeiterfassung.sqlite"));
seed(db, { holidayYears: [2026] });

const users = createUsersRepository(db);
const entries = createEntriesRepository(db);
const absences = createAbsencesRepository(db);
const holidays = createHolidaysRepository(db);
const rules = createRulesRepository(db);
const payouts = createPayoutsRepository(db);
const terminals = createTerminalsRepository(db);
const rfid = createRfidRepository(db);
const triggers = createTriggersRepository(db);
const automations = createAutomationsRepository(db);
const settings = createSettingsRepository(db);
const auth = createAuthService({ db, users, settings, secret: "e2e-session-secret", defaultTtlMinutes: 720 });
const aggregation = createAggregationService({ db, users, entries, absences, holidays, rules, settings });
const sync = createSyncService({ db, entries, users, aggregation });
// backups land in the data directory of this run: the suite takes one, downloads it and hands it back in
const backup = createBackupService({
	db,
	dir: join(dataDir, "backups"),
	now,
});

// one administrator (the account the specs sign in with) and one employee to punch for
const admin = users.create({ login: "admin", displayName: "E2E Admin", roleKeys: ["admin"] });
const anna = users.create({ login: "anna", displayName: "Anna Muster", roleKeys: ["employee"] });
auth.setPassword({ userId: admin.id, password: adminPassword, mustChangePw: false, actorId: admin.id, now: now() });
auth.setPassword({ userId: anna.id, password: adminPassword, mustChangePw: false, actorId: admin.id, now: now() });
// an account that still carries its start password: the web app has to ask for a new one before anything else
const fresh = users.create({ login: "start", displayName: "Neue Kraft", roleKeys: ["employee"] });
auth.setPassword({ userId: fresh.id, password: adminPassword, mustChangePw: true, actorId: admin.id, now: now() });
users.setPin({
	userId: anna.id,
	pinHash: require(join(repo, "build/lib/services/auth.js")).hashPassword("1234"),
	actorId: admin.id,
	now: now(),
});

const api = createApi({
	db,
	auth,
	users,
	entries,
	absences,
	holidays,
	rules,
	payouts,
	terminals,
	rfid,
	triggers,
	automations,
	aggregation,
	sync,
	backup,
	settings,
	kioskEnabled: true,
	// the suite signs in once per case, which is more often than the shipped limit of 20 attempts per minute
	loginRateLimit: 200,
	// a terminal session lives seconds in the tests, so the specs also cover a screen that has to renew itself
	terminalSessionMinutes: 0.1,
	hmacSecret: "e2e-hmac-secret",
	version,
	now,
});

const webDir = join(repo, "www");
const staticFiles = createStaticHandler({ root: webDir });

const server = await startWebServer({
	router: api.router,
	port,
	bind: "127.0.0.1",
	staticFiles,
	// the browser may upload a backup in the test as well
	maxBodyBytes: MAX_BACKUP_UPLOAD_BYTES,
	stream: {
		auth,
		events: api.events,
		version,
		timers: { setInterval, clearInterval },
	},
	log: { info: console.log, warn: console.warn, error: console.error },
});

console.log(`E2E server ready on ${server.url} (admin: admin / ${adminPassword})`);
