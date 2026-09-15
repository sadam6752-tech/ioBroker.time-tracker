/**
 * Erststart-Prüfung gegen eine laufende Instanz — die Schritte aus `docs/erste-schritte.md` als Skript.
 *
 * Geprüft werden Anmeldung, Pflicht-Passwortwechsel, Anlegen eines Mitarbeiters samt Badge-PIN, Stempeln,
 * Tages-/Monatsauswertung, der Monatsbericht als XLS und PDF sowie eine Sicherung. Nicht enthalten sind die
 * Schritte, die eine Einstellung in der Instanz voraussetzen: Kiosk-Terminal (`kioskEnabled`), Ausweis-Links
 * (HMAC-Secret) und der Altdaten-Import (echte Daten). Diese prüft der Testplan von Hand.
 *
 * Achtung: es entstehen **echte** Daten (Mitarbeiter `pruefung`, PIN, Stempel). Daher nur gegen eine Testinstanz
 * laufen lassen.
 *
 * Verwendung:
 *   node tools/first-run-check.mjs --login admin --password 'geheim'
 *   npm run first-run -- --base http://192.168.1.10:8082 --login admin --password 'geheim'
 *
 * Das Passwort kann auch über die Umgebungsvariable `ZT_PASSWORD` kommen. Ein Bearer-Token braucht kein
 * CSRF-Token (Vorgabe 4.10), das Skript sendet daher nur `x-session-token`.
 */

const DEFAULT_BASE = "http://127.0.0.1:8082";
const EMPLOYEE_LOGIN = "pruefung";
const EMPLOYEE_NAME = "Prüfung (Automatik)";
const EMPLOYEE_PIN = "4712";
/** Start- und Zielpasswort des Prüf-Mitarbeiters; muss die Passwort-Richtlinie erfüllen. */
const EMPLOYEE_PASSWORD = "Erststart-2026-pruefung!";
const TIMEOUT_MS = 30000;

/** Ergebnisse der einzelnen Schritte für die Schlussbilanz. */
const results = [];

/**
 * Liest die Kommandozeilenargumente.
 *
 * @param {string[]} argv - Argumente ohne `node` und Skriptnamen
 * @returns {{base: string, login: string, password: string}} Einstellungen
 */
function parseArgs(argv) {
	const options = { base: DEFAULT_BASE, login: "admin", password: process.env.ZT_PASSWORD ?? "" };

	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key === "--help" || key === "-h") {
			console.log("node tools/first-run-check.mjs [--base URL] [--login NAME] [--password PW]");
			process.exit(0);
		}
		if (key === "--base" && value) {
			options.base = value.replace(/\/+$/, "");
		} else if (key === "--login" && value) {
			options.login = value;
		} else if (key === "--password" && value) {
			options.password = value;
		} else {
			throw new Error(`unbekanntes Argument: ${key}`);
		}
		index++;
	}

	if (!options.password) {
		throw new Error("--password (oder ZT_PASSWORD) ist erforderlich");
	}
	return options;
}

/**
 * Ruft die API auf.
 *
 * @param {string} base - Wurzel der API (mit `/api`)
 * @param {string} method - HTTP-Methode
 * @param {string} path - Pfad ab der Wurzel
 * @param {{body?: unknown, token?: string}} options - Body und Sitzungstoken
 * @returns {Promise<{status: number, headers: Headers, body: unknown}>} Antwort
 */
async function call(base, method, path, options = {}) {
	const headers = {};
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	if (options.token) {
		headers["x-session-token"] = options.token;
	}

	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const text = await response.text();

	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, headers: response.headers, body };
}

/**
 * Meldet einen Schritt in der Schlussbilanz an.
 *
 * @param {string} name - Name des Schrittes
 * @param {boolean} ok - ob der Schritt erfüllt ist
 * @param {string} detail - Beobachtung für die Ausgabe
 */
function step(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Prüft die Antwort auf einen erwarteten Status und meldet das Ergebnis.
 *
 * @param {string} name - Name des Schrittes
 * @param {{status: number, body: unknown}} response - Antwort der API
 * @param {number[]} expected - zulässige Status
 * @returns {boolean} true, wenn der Status passte
 */
function expectStatus(name, response, expected) {
	const ok = expected.includes(response.status);
	const detail = response.body?.detail ?? JSON.stringify(response.body);
	step(name, ok, ok ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}`);
	return ok;
}

/**
 * Meldet sich an und liefert das Sitzungstoken.
 *
 * @param {string} base - Wurzel der API
 * @param {string} login - Benutzername
 * @param {string} password - Passwort
 * @returns {Promise<object>} die Anmeldung mit Status, Sitzungstoken und Benutzer
 */
async function signIn(base, login, password) {
	const response = await call(base, "POST", "/auth/login", { body: { login, password } });
	return {
		status: response.status,
		token: response.body?.token ?? "",
		user: response.body?.user ?? {},
	};
}

/**
 * Führt die Erststart-Prüfung aus.
 *
 * @returns {Promise<void>} wirft, wenn ein Schritt hart fehlschlägt
 */
async function main() {
	const options = parseArgs(process.argv.slice(2));
	const base = `${options.base}/api`;
	console.log(`Erststart-Prüfung gegen ${options.base}\n`);

	const health = await call(base, "GET", "/health");
	if (!expectStatus("Instanz erreichbar", health, [200])) {
		throw new Error("die API antwortet nicht — läuft die Instanz?");
	}

	// 1. Anmeldung als Administrator
	const administrator = await signIn(base, options.login, options.password);
	if (!expectStatus(`Anmeldung als ${options.login}`, administrator, [200])) {
		throw new Error("Anmeldung fehlgeschlagen — Passwort aus dem Adapterlog verwenden");
	}
	const adminToken = administrator.token;
	const adminMustChange = administrator.user.mustChangePw === true;
	step(
		"Erst-Administrator hat noch das Startpasswort",
		true,
		adminMustChange ? "Pflichtwechsel offen (erwartet beim Erststart)" : "Passwort wurde bereits gewechselt",
	);

	// 2. Mitarbeiter anlegen (oder den aus einem früheren Lauf verwenden)
	const existing = await call(base, "GET", "/users", { token: adminToken });
	const known = Array.isArray(existing.body?.users)
		? existing.body.users.find(user => user.login === EMPLOYEE_LOGIN)
		: undefined;

	let employeeId = known?.id ?? 0;
	let employeeIsNew = false;
	if (!known) {
		const created = await call(base, "POST", "/users", {
			body: {
				login: EMPLOYEE_LOGIN,
				displayName: EMPLOYEE_NAME,
				password: "Erststart-2026-start!",
				roleKeys: ["employee"],
				mustChangePw: true,
			},
			token: adminToken,
		});
		if (!expectStatus("Mitarbeiter anlegen", created, [201])) {
			throw new Error(`POST /users fehlgeschlagen: ${JSON.stringify(created.body)}`);
		}
		employeeId = created.body.user.id;
		employeeIsNew = true;
	} else {
		step(
			"Mitarbeiter anlegen",
			true,
			`"${EMPLOYEE_LOGIN}" existiert bereits (id ${employeeId}), wird weiterverwendet`,
		);
	}

	// 3. Badge-PIN setzen
	const pin = await call(base, "POST", `/users/${employeeId}/pin`, {
		body: { pin: EMPLOYEE_PIN },
		token: adminToken,
	});
	expectStatus("Badge-PIN setzen", pin, [204]);

	// 4. Erste Anmeldung des Mitarbeiters und der Pflicht-Passwortwechsel
	let employee = await signIn(base, EMPLOYEE_LOGIN, employeeIsNew ? "Erststart-2026-start!" : EMPLOYEE_PASSWORD);
	if (employee.status !== 200) {
		throw new Error(
			`die Anmeldung von "${EMPLOYEE_LOGIN}" scheiterte mit HTTP ${employee.status} — Passwort aus einem früheren Lauf?`,
		);
	}
	if (employee.user.mustChangePw === true) {
		const changed = await call(base, "POST", "/auth/password", {
			body: { password: EMPLOYEE_PASSWORD },
			token: employee.token,
		});
		expectStatus("Pflicht-Passwortwechsel beim ersten Login", changed, [204]);
		// der Wechsel beendet alle Sitzungen — also mit dem neuen Passwort neu anmelden
		employee = await signIn(base, EMPLOYEE_LOGIN, EMPLOYEE_PASSWORD);
		expectStatus("Anmeldung mit dem neuen Passwort", employee, [200]);
	}
	step(
		"Kein Pflichtwechsel mehr offen",
		employee.user.mustChangePw !== true,
		`mustChangePw=${employee.user.mustChangePw === true}`,
	);
	const employeeToken = employee.token;
	// die Auswertungen und die Berichte brauchen das Jahr und den Monat als Query-Parameter
	const reportYear = new Date().getFullYear();
	const reportMonth = new Date().getMonth() + 1;

	// 5. Stempeln: hinein, hinaus, Schnellstempel — und die Auswertung dazu
	const beforePunch = await call(base, "GET", "/punch/status", { token: employeeToken });
	const first = await call(base, "POST", "/punch", { body: { note: "first-run-check #1" }, token: employeeToken });
	expectStatus("Stempeln (erster Stempel dieses Laufs)", first, [200, 201]);
	const opened = await call(base, "GET", "/punch/status", { token: employeeToken });
	step(
		"Tagesstatus wechselt mit dem Stempel",
		opened.body?.hasOpenEntry === !beforePunch.body?.hasOpenEntry,
		`vorher offen=${beforePunch.body?.hasOpenEntry}, Richtung ${beforePunch.body?.nextDirection}, nachher offen=${opened.body?.hasOpenEntry}`,
	);

	const second = await call(base, "POST", "/punch", { body: { note: "first-run-check #2" }, token: employeeToken });
	expectStatus("Stempeln (zweiter Stempel dieses Laufs)", second, [200, 201]);

	const quick = await call(base, "POST", "/punch/quick", {
		body: { note: "first-run-check #3" },
		token: employeeToken,
	});
	expectStatus("Schnellstempeln", quick, [200, 201]);

	const day = await call(base, "GET", "/aggregates/day", { token: employeeToken });
	expectStatus("Tagesauswertung", day, [200]);
	const month = await call(base, "GET", `/aggregates/month?year=${reportYear}&month=${reportMonth}`, {
		token: employeeToken,
	});
	step(
		"Monatsauswertung",
		month.status === 200,
		month.status === 200
			? `HTTP 200, Felder: ${Object.keys(month.body ?? {}).join(", ")}`
			: `HTTP ${month.status}: ${month.body?.detail}`,
	);

	// 6. Monatsbericht als XLS und PDF — geprüft über die Dateiköpfe
	const xls = await fetchBinary(base, `/reports/xls?year=${reportYear}&month=${reportMonth}`, employeeToken);
	step(
		"Monatsbericht als XLS",
		xls.status === 200 && xls.contentType.includes("spreadsheet") && xls.magic.startsWith("PK"),
		`HTTP ${xls.status}, ${xls.bytes} Bytes, ${xls.contentType}, Kopf "${xls.magic}"`,
	);
	const pdf = await fetchBinary(base, `/reports/pdf?year=${reportYear}&month=${reportMonth}`, employeeToken);
	step(
		"Monatsbericht als PDF",
		pdf.status === 200 && pdf.contentType.includes("pdf") && pdf.magic.startsWith("%PDF"),
		`HTTP ${pdf.status}, ${pdf.bytes} Bytes, ${pdf.contentType}, Kopf "${pdf.magic}"`,
	);

	// 7. Sicherung erstellen und wiederfinden
	const created = await call(base, "POST", "/backup", { token: adminToken });
	const backupName = created.body?.backup?.name ?? "";
	step(
		"Sicherung erstellen",
		(created.status === 200 || created.status === 201) && backupName !== "",
		`HTTP ${created.status}, ${backupName || JSON.stringify(created.body)}`,
	);
	const list = await call(base, "GET", "/backup", { token: adminToken });
	const found = Array.isArray(list.body?.backups) && list.body.backups.some(entry => entry.name === backupName);
	step(
		"Sicherung in der Liste",
		found,
		`${list.body?.backups?.length ?? 0} Sicherungen, Aufbewahrung ${list.body?.retentionDays} Tage`,
	);

	// 8. Ausweis-Link: braucht das HMAC-Secret der Instanz
	const tag = await call(base, "POST", "/rfid/tags", {
		body: { userId: employeeId, label: "Erststart-Prüfung" },
		token: adminToken,
	});
	if (tag.status === 201 && typeof tag.body?.url === "string") {
		step("Ausweis-Link ausstellen", true, `HTTP 201, ${tag.body.url.replace(/\?.*/, "?tag=…")}`);
		const scanned = await call(base, "POST", "/rfid/scan", { body: { token: tag.body.token } });
		step("Ausweis scannen", scanned.status === 200, `HTTP ${scanned.status}`);
	} else if (tag.status === 403 && tag.body?.code === "not_configured") {
		step(
			"Ausweis-Link ausstellen",
			true,
			"übersprungen: kein HMAC-Secret gesetzt (Instanz-Einstellungen, Schritt 3 der Erststart-Anleitung)",
		);
	} else {
		step("Ausweis-Link ausstellen", false, `HTTP ${tag.status}: ${JSON.stringify(tag.body)}`);
	}

	// Schlussbilanz
	const failed = results.filter(entry => !entry.ok);
	console.log(`\nErgebnis: ${results.length - failed.length}/${results.length} Schritte erfüllt`);
	if (failed.length > 0) {
		console.log(`Nicht erfüllt: ${failed.map(entry => entry.name).join(", ")}`);
		throw new Error(`${failed.length} Schritt(e) fehlgeschlagen`);
	}
	console.log(
		"OK: Erststart-Strecke ohne Fehler. Kiosk-Terminal, Ausweis-Link mit Secret und Altdaten-Import prüft der Testplan von Hand.",
	);
}

/**
 * Lädt einen Export und liest die ersten Bytes, damit sich der Dateityp belegen lässt.
 *
 * @param {string} base - Wurzel der API
 * @param {string} path - Pfad ab der Wurzel
 * @param {string} token - Sitzungstoken
 * @returns {Promise<{status: number, contentType: string, magic: string, bytes: number}>} Kopf und Anfang
 */
async function fetchBinary(base, path, token) {
	const response = await fetch(`${base}${path}`, {
		headers: { "x-session-token": token },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const buffer = Buffer.from(await response.arrayBuffer());
	return {
		status: response.status,
		contentType: response.headers.get("content-type") ?? "",
		magic: buffer.subarray(0, 4).toString("latin1"),
		bytes: buffer.length,
	};
}

main().catch(error => {
	console.error(`FEHLGESCHLAGEN: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
