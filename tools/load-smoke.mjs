/**
 * Laststichprobe gegen eine laufende Instanz — Abnahmetest T17 aus `docs/testplan.md`.
 *
 * Meldet sich an, schickt die gewünschte Anzahl Stempel **parallel** über die API und prüft danach über
 * `GET /api/entries`, dass jeder davon angekommen ist. Die Antwortzeiten werden je Aufruf gemessen und als
 * Minimum/Median/Maximum ausgegeben; das Skript endet nur mit Code 0, wenn alle Stempel geschrieben und wieder
 * gefunden wurden.
 *
 * Achtung: es entstehen **echte** Stempel im gewählten Konto. Für den Test deshalb ein eigenes Testkonto
 * verwenden oder die Stempel danach in der Verwaltung löschen.
 *
 * Verwendung:
 *   node tools/load-smoke.mjs --login admin --password 'geheim'
 *   npm run load-smoke -- --base http://192.168.1.10:8092 --login anna --password 'geheim' --count 10
 *
 * Das Passwort kann auch über die Umgebungsvariable `ZT_PASSWORD` kommen, damit es nicht in der Shell-Historie
 * landet. Ein Bearer-Token braucht kein CSRF-Token (Vorgabe 4.10), das Skript sendet daher nur `x-session-token`.
 */

const DEFAULT_BASE = "http://127.0.0.1:8092";
const DEFAULT_COUNT = 5;
const TIMEOUT_MS = 30000;

/**
 * Liest die Kommandozeilenargumente.
 *
 * @param {string[]} argv - Argumente ohne `node` und Skriptnamen
 * @returns {{base: string, login: string, password: string, count: number}} Einstellungen
 */
function parseArgs(argv) {
	const options = { base: DEFAULT_BASE, login: "", password: process.env.ZT_PASSWORD ?? "", count: DEFAULT_COUNT };

	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key === "--help" || key === "-h") {
			console.log("node tools/load-smoke.mjs [--base URL] [--login NAME] [--password PW] [--count N]");
			process.exit(0);
		}
		if (key === "--base" && value) {
			options.base = value.replace(/\/+$/, "");
		} else if (key === "--login" && value) {
			options.login = value;
		} else if (key === "--password" && value) {
			options.password = value;
		} else if (key === "--count" && value) {
			options.count = Math.max(1, Math.min(100, Number(value) || DEFAULT_COUNT));
		} else {
			throw new Error(`unbekanntes Argument: ${key}`);
		}
		index++;
	}

	if (!options.login || !options.password) {
		throw new Error("--login und --password (oder ZT_PASSWORD) sind erforderlich");
	}
	return options;
}

/**
 * Ruft die API auf und misst die Dauer.
 *
 * @param {string} method - HTTP-Methode
 * @param {string} url - vollständige URL
 * @param {{body?: unknown, token?: string}} options - Body und Sitzungstoken
 * @returns {Promise<{status: number, body: unknown, milliseconds: number}>} Antwort und Dauer
 */
async function call(method, url, options = {}) {
	const headers = {};
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	if (options.token) {
		headers["x-session-token"] = options.token;
	}

	const started = performance.now();
	let response;
	try {
		response = await fetch(url, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`keine Verbindung zu ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = await response.text();
	const milliseconds = Math.round(performance.now() - started);

	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body, milliseconds };
}

/**
 * Bildet Minimum, Median und Maximum der Messwerte.
 *
 * @param {number[]} values - Messwerte in Millisekunden
 * @returns {{min: number, median: number, max: number}} Kennzahlen in Millisekunden
 */
function summarize(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return {
		min: sorted[0] ?? 0,
		median: sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle],
		max: sorted[sorted.length - 1] ?? 0,
	};
}

/**
 * Führt die Laststichprobe aus.
 *
 * @returns {Promise<void>} wirft bei jedem fehlenden oder abgelehnten Stempel
 */
async function main() {
	const options = parseArgs(process.argv.slice(2));
	const base = `${options.base}/api`;
	const runId = `load-smoke ${new Date().toISOString()}`;
	console.log(`Laststichprobe T17 gegen ${options.base} (${options.count} parallele Stempel)`);
	console.log("Hinweis: es entstehen echte Stempel im Konto — Testkonto verwenden oder danach löschen.");

	const health = await call("GET", `${base}/health`);
	if (health.status !== 200) {
		throw new Error(`die API ist nicht erreichbar (HTTP ${health.status} auf /api/health)`);
	}

	const login = await call("POST", `${base}/auth/login`, {
		body: { login: options.login, password: options.password },
	});
	if (login.status !== 200) {
		throw new Error(`Anmeldung fehlgeschlagen (HTTP ${login.status}): ${JSON.stringify(login.body)}`);
	}

	const token = login.body.token;
	const user = login.body.user ?? {};
	console.log(`Angemeldet als ${user.displayName ?? options.login} (id ${user.id ?? "?"})`);
	if (user.mustChangePw) {
		console.warn("Warnung: das Konto muss das Passwort noch wechseln — Schreibzugriffe können abgelehnt werden.");
	}

	// alle Stempel starten gleichzeitig: genau das ist die Stichprobe
	const punches = await Promise.all(
		Array.from({ length: options.count }, async (_unused, index) => {
			const started = performance.now();
			const response = await call("POST", `${base}/punch`, {
				body: { idempotencyKey: `${Date.now()}-${index}`, note: `${runId} #${index + 1}` },
				token,
			});
			return { index: index + 1, ...response, milliseconds: Math.round(performance.now() - started) };
		}),
	);

	const failed = punches.filter(punch => punch.status !== 201 && punch.status !== 200);
	for (const punch of punches) {
		const detail = failed.includes(punch) ? ` — ${JSON.stringify(punch.body)}` : "";
		console.log(`  Stempel ${punch.index}: HTTP ${punch.status} in ${punch.milliseconds} ms${detail}`);
	}
	if (failed.length > 0) {
		throw new Error(`${failed.length} von ${options.count} Stempeln wurden abgelehnt`);
	}

	// und jetzt nachsehen, ob sie wirklich in der Datenbank stehen
	const today = new Date().toISOString().slice(0, 10);
	const entries = await call("GET", `${base}/entries?from=${today}&to=${today}`, { token });
	if (entries.status !== 200) {
		throw new Error(
			`die Stempel ließen sich nicht prüfen (HTTP ${entries.status}): ${JSON.stringify(entries.body)}`,
		);
	}
	const list = Array.isArray(entries.body) ? entries.body : (entries.body.entries ?? []);
	const stored = list.filter(entry => typeof entry.note === "string" && entry.note.startsWith(runId));

	const durations = summarize(punches.map(punch => punch.milliseconds));
	console.log(
		`Ergebnis: ${stored.length}/${options.count} Stempel am ${today} gefunden · ` +
			`Antwortzeiten min ${durations.min} ms / median ${durations.median} ms / max ${durations.max} ms`,
	);
	if (stored.length !== options.count) {
		throw new Error(`es fehlen ${options.count - stored.length} Stempel in GET /api/entries`);
	}
	console.log("OK: kein Fehler, alle Stempel vorhanden, Antwortzeiten im Sekundenbereich.");
}

main().catch(error => {
	console.error(`FEHLGESCHLAGEN: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
