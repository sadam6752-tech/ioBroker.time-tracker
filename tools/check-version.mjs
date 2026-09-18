/**
 * Prüft die Versionierung des Repositories — den Release-Ablauf in `CONTRIBUTING.md`.
 *
 * Der Adapter führt seine Version an zwei Stellen: `package.json` und `io-package.json` (`common.version`).
 * Veröffentlicht wird über einen Tag `vX.Y.Z`, den das Release-Werkzeug setzt; dabei wandert der Abschnitt
 * „WORK IN PROGRESS" aus dem Changelog des `README.md` in die neue Version und der `common.news`-Eintrag entsteht.
 *
 * Damit vor einem Push nichts Inkonsistentes im Repository liegt, prüft dieses Skript:
 *
 * 1. beide Versionsfelder gleich sind,
 * 2. der Changelog im `README.md` (`## Changelog`) die aktuelle Version im neuesten Abschnitt nennt oder einen
 *    Abschnitt `WORK IN PROGRESS` hat (jede Änderung bekommt dort ihren Eintrag),
 * 3. zu einer festen Version ein `common.news`-Eintrag existiert — der Adapterchecker verlangt ihn (Regel E510),
 * 4. die beiden Listen nicht wachsen: `common.news` darf höchstens sieben Einträge haben (der ioBroker-Repo-Builder
 *    schneidet bei sieben ab, Repochecker-Befund E1032) und der README-Changelog höchstens fünf Versionen,
 * 5. die neuesten Einträge vorn stehen und ältere Versionen in `CHANGELOG_OLD.md` dokumentiert sind.
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

/** Der ioBroker-Repo-Builder schneidet `common.news` bei sieben Einträgen ab. */
const NEWS_LIMIT = 7;

/** Der README behält die letzten fünf Versionen; alles Ältere steht in `CHANGELOG_OLD.md`. */
const README_LIMIT = 5;

/**
 * Vergleicht zwei Versionen der Form `X.Y.Z`.
 *
 * @param {string} a erste Version
 * @param {string} b zweite Version
 * @returns {number} negativ, `0` oder positiv wie bei einem Sortiervergleich
 */
function compareVersions(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) {
			return (left[index] ?? 0) - (right[index] ?? 0);
		}
	}
	return 0;
}

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
 * Liest den neuesten Abschnitt des Changelogs aus dem README.
 *
 * Der Changelog steht unter `## Changelog`; sein neuester Abschnitt ist entweder `### **WORK IN PROGRESS**` oder
 * `### 1.2.3 (2026-09-16)`. Kopfkommentare und andere Rubriken (etwa `### Branding`) zählen nicht mit, deshalb
 * endet die Suche an der nächsten Überschrift der zweiten Ebene.
 *
 * @param {string} text Inhalt des README
 * @returns {{raw: string, version: string, workInProgress: boolean}|null} Abschnitt oder `null`
 */
function changelogSection(text) {
	const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
	const start = lines.findIndex(line => /^##\s+changelog\s*$/i.test(line));
	if (start < 0) {
		return null;
	}

	for (let index = start + 1; index < lines.length; index++) {
		if (/^##\s+\S/.test(lines[index])) {
			// das nächste Kapitel: hier endet der Changelog
			return null;
		}
		const match = /^###\s+(.+?)\s*$/.exec(lines[index]);
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

	const readmeFile = join(directory, "README.md");
	if (!existsSync(readmeFile)) {
		problems.push("README.md fehlt");
		return problems;
	}

	const section = changelogSection(readFileSync(readmeFile, "utf8"));
	if (!section) {
		problems.push("README.md hat keinen Changelog-Abschnitt mit einer Version (`## Changelog`)");
		return problems;
	}
	if (!section.workInProgress && section.version !== version) {
		problems.push(
			`der Changelog nennt im neuesten Abschnitt "${section.raw}", erwartet wird "WORK IN PROGRESS" oder ${version}`,
		);
	}
	if (!section.workInProgress && !io.common.news?.[version]) {
		problems.push(`io-package.json hat keinen common.news-Eintrag für ${version}`);
	}

	// Die beiden Listen dürfen nicht wachsen — sonst schneidet der Repo-Builder ab und der README verliert seine
	// Regel „die letzten fünf Versionen".
	const newsVersions = Object.keys(io.common.news ?? {});
	if (newsVersions.length > NEWS_LIMIT) {
		problems.push(
			`io-package.json hat ${newsVersions.length} common.news-Einträge, erlaubt sind ${NEWS_LIMIT} ` +
				"(der ioBroker-Repo-Builder schneidet den Rest ab)",
		);
	}

	const readmeText = readFileSync(readmeFile, "utf8");
	const readmeVersions = [...readmeText.matchAll(/^###\s+(\d+\.\d+\.\d+)\s*\(/gm)].map(match => match[1]);
	if (readmeVersions.length > README_LIMIT) {
		problems.push(
			`der README-Changelog nennt ${readmeVersions.length} Versionen, erlaubt sind ${README_LIMIT} ` +
				"— ältere gehören nach CHANGELOG_OLD.md",
		);
	}

	const sorted = [...readmeVersions].sort(compareVersions).reverse();
	if (readmeVersions.join(",") !== sorted.join(",")) {
		problems.push("der README-Changelog ist nicht absteigend nach Version sortiert");
	}

	// Was aus der News-Liste herausfällt, muss in README oder CHANGELOG_OLD.md dokumentiert sein.
	const oldFile = join(directory, "CHANGELOG_OLD.md");
	if (existsSync(oldFile)) {
		const oldText = readFileSync(oldFile, "utf8");
		const undocumented = newsVersions.filter(
			entry => !readmeVersions.includes(entry) && !oldText.includes(`### ${entry}`),
		);
		if (undocumented.length > 0) {
			problems.push(
				`diese Versionen stehen weder im README noch in CHANGELOG_OLD.md: ${undocumented.join(", ")}`,
			);
		}
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
	console.error("'### **WORK IN PROGRESS**' im README-Abschnitt '## Changelog'; die Version wird nur mit");
	console.error("'npm run release <patch|minor|major>' und nach Freigabe hochgezogen.");
	process.exit(1);
}
