/**
 * Prüft die Versionierung des Repositories — die Regel aus `CONTRIBUTING.md`.
 *
 * Der Adapter führt seine Version an zwei Stellen: `package.json` und `io-package.json` (`common.version`).
 * Veröffentlicht wird über einen Tag `vX.Y.Z`, den das Release-Werkzeug setzt; dabei wandert der Block
 * „WORK IN PROGRESS" aus `CHANGELOG.md` in die neue Version und der `common.news`-Eintrag entsteht.
 *
 * Damit vor einem Push nichts Inkonsistentes im Repository liegt, prüft dieses Skript:
 *
 * 1. beide Versionsfelder gleich sind,
 * 2. `CHANGELOG.md` entweder die aktuelle Version im neuesten Abschnitt nennt oder einen Abschnitt
 *    `WORK IN PROGRESS` hat (jede Änderung bekommt dort ihren Eintrag),
 * 3. zu einer festen Version ein `common.news`-Eintrag existiert — der Adapterchecker verlangt ihn (Regel E510).
 *
 * Verwendung:
 *   node tools/check-version.mjs                 # prüft das Repository im aktuellen Verzeichnis
 *   node tools/check-version.mjs --repo <pfad>   # prüft ein anderes Verzeichnis
 *   npm run version:check
 *
 * Rückgabewert: 0 = alles in Ordnung, 1 = mindestens ein Befund.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Liest eine JSON-Datei.
 *
 * @param {string} file Pfad der Datei
 * @param {string[]} problems Liste, die einen Lesefehler aufnimmt
 * @returns {object|null} Inhalt oder `null`, wenn die Datei fehlt oder unlesbar ist
 */
function readJson(file, problems) {
	if (!existsSync(file)) {
		problems.push(`${file} fehlt`);
		return null;
	}
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		problems.push(`${file} ist kein gültiges JSON: ${error.message}`);
		return null;
	}
}

/**
 * Liest den neuesten Abschnitt einer Changelog-Datei.
 *
 * Überschriften haben die Form `### **WORK IN PROGRESS**` oder `### 1.2.3 (2026-09-16)`. Der Kopfkommentar der
 * Datei zählt nicht mit, sonst würde die Vorlage als Eintrag gelesen.
 *
 * @param {string} text Inhalt der Datei
 * @returns {{raw: string, version: string, workInProgress: boolean}|null} Abschnitt oder `null`
 */
function newestSection(text) {
	const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
	for (const line of withoutComments.split(/\r?\n/)) {
		const match = /^###\s+(.+?)\s*$/.exec(line);
		if (!match) {
			continue;
		}
		const raw = match[1].replace(/\*\*/g, "").trim();
		return {
			raw,
			// `1.2.3 (2026-09-16)` und `1.2.3` ergeben beide `1.2.3`
			version: raw.split(/[\s(]/)[0],
			workInProgress: /^work in progress$/i.test(raw),
		};
	}
	return null;
}

/**
 * Sammelt die Befunde der Versionsprüfung.
 *
 * @param {string} directory Wurzel des Repositories
 * @returns {string[]} Befunde; leer, wenn alles stimmt
 */
export function checkVersioning(directory) {
	const problems = [];
	const pkg = readJson(join(directory, "package.json"), problems);
	const io = readJson(join(directory, "io-package.json"), problems);
	if (!pkg || !io) {
		return problems;
	}

	const version = pkg.version;
	const ioVersion = io.common?.version;
	if (!version || !ioVersion) {
		problems.push("package.json oder io-package.json hat keine Version");
		return problems;
	}
	if (version !== ioVersion) {
		problems.push(`die Versionen unterscheiden sich: package.json ${version}, io-package.json ${ioVersion}`);
	}

	const changelogFile = join(directory, "CHANGELOG.md");
	if (!existsSync(changelogFile)) {
		problems.push("CHANGELOG.md fehlt");
		return problems;
	}

	const section = newestSection(readFileSync(changelogFile, "utf8"));
	if (!section) {
		problems.push("CHANGELOG.md hat keinen Abschnitt für eine Version");
		return problems;
	}
	if (!section.workInProgress && section.version !== version) {
		problems.push(
			`CHANGELOG.md nennt im neuesten Abschnitt "${section.raw}", erwartet wird "WORK IN PROGRESS" oder ${version}`,
		);
	}
	if (!section.workInProgress && !io.common.news?.[version]) {
		problems.push(`io-package.json hat keinen common.news-Eintrag für ${version}`);
	}

	return problems;
}

// Aufruf über die Kommandozeile (der Pre-Push-Hook nutzt denselben Weg)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const index = args.indexOf("--repo");
	const repo = resolve(index >= 0 ? (args[index + 1] ?? ".") : ".");
	const problems = checkVersioning(repo);

	if (problems.length === 0) {
		console.log(`Version in Ordnung (${repo})`);
		process.exit(0);
	}

	console.error(`Versionsprüfung fehlgeschlagen (${repo}):`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	console.error("");
	console.error("Regel: jede Änderung bekommt vor dem Push einen Eintrag unter");
	console.error("'### **WORK IN PROGRESS**' in CHANGELOG.md; die Version wird nur mit");
	console.error("'npm run release <patch|minor|major>' hochgezogen.");
	process.exit(1);
}
