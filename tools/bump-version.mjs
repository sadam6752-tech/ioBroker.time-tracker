/**
 * Hebt die Version des Adapters an — die Regel aus `CONTRIBUTING.md`, Abschnitt 8.
 *
 * Ein Push enthält immer einen Versionssprung, damit im Repository und in der ioBroker-Übersicht sichtbar ist,
 * welche Fassung wo liegt. Das Skript macht in einem Zug:
 *
 * 1. `package.json` und `io-package.json` (`common.version`) auf die neue Version setzen,
 * 2. den Abschnitt `### **WORK IN PROGRESS**` im README auf `### <neue Version> (<Datum>)` umbenennen und darüber
 *    einen frischen Platzhalter anlegen (die Einträge wandern also mit),
 * 3. `common.news` um einen Eintrag für die neue Version ergänzen — die Texte sind zunächst englisch, die
 *    Übersetzungen kommen über `npm run translate` oder von Hand.
 *
 * Verwendung (die Argumente nach `--` gehören dem Skript, davor npm):
 *   npm run version:bump -- patch                    # 0.0.2 -> 0.0.3
 *   npm run version:bump -- minor --news "Kurzer Text für die News"
 *   npm run version:bump -- major --dry              # nur zeigen, was passieren würde
 *   node tools/bump-version.mjs patch --repo <pfad>
 *
 * Ohne `--news` wird der erste Eintrag des „WORK IN PROGRESS"-Blocks als News-Text genommen.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

/** Sprachen, die `common.news` enthalten muss (Adapterchecker E510). */
const LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

/**
 * Argumente der Kommandozeile.
 *
 * @returns {{bump: string, news: string|null, dry: boolean, repo: string}} ausgewertete Argumente
 */
function readArguments() {
	const args = process.argv.slice(2);
	const bump = args[0] ?? "";
	const newsIndex = args.indexOf("--news");
	const repoIndex = args.indexOf("--repo");
	return {
		bump,
		news: newsIndex >= 0 ? (args[newsIndex + 1] ?? null) : null,
		dry: args.includes("--dry") || args.includes("--dryRun"),
		repo: resolve(repoIndex >= 0 ? (args[repoIndex + 1] ?? ".") : "."),
	};
}

/**
 * Rechnet die neue Version aus.
 *
 * @param {string} version aktuelle Version
 * @param {string} bump `major`, `minor` oder `patch`
 * @returns {string} neue Version
 */
function nextVersion(version, bump) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`die aktuelle Version "${version}" ist keine x.y.z-Version`);
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (bump === "major") {
		return `${major + 1}.0.0`;
	}
	if (bump === "minor") {
		return `${major}.${minor + 1}.0`;
	}
	if (bump === "patch") {
		return `${major}.${minor}.${patch + 1}`;
	}
	throw new Error(`unbekannter Sprung "${bump}" — erlaubt sind major, minor und patch`);
}

/**
 * Ersetzt das erste Versionsfeld einer Datei.
 *
 * @param {string} file Pfad der Datei
 * @param {string} version neue Version
 * @returns {string} Meldung für die Ausgabe
 */
function writeVersion(file, version) {
	const text = readFileSync(file, "utf8");
	if (!/"version":\s*"[^"]+"/.test(text)) {
		throw new Error(`${file} hat kein Versionsfeld`);
	}
	writeFileSync(file, text.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`), "utf8");
	return `version in ${file}`;
}

/**
 * Benennt den WIP-Abschnitt im README um und legt einen neuen Platzhalter an.
 *
 * @param {string} file Pfad des README
 * @param {string} version neue Version
 * @param {string} date Datum im Format `YYYY-MM-DD`
 * @returns {string} Meldung für die Ausgabe
 */
function writeChangelog(file, version, date) {
	const text = readFileSync(file, "utf8");
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);

	const start = lines.findIndex(line => /^##\s+changelog\s*$/i.test(line));
	if (start < 0) {
		throw new Error("README.md hat keinen Abschnitt '## Changelog'");
	}
	const wip = lines.findIndex((line, index) => index > start && /^###\s+\*\*WORK IN PROGRESS\*\*\s*$/i.test(line));
	if (wip < 0) {
		throw new Error("README.md hat keinen Abschnitt '### **WORK IN PROGRESS**'");
	}

	// die Einträge bleiben stehen und wandern mit der Überschrift in die neue Version;
	// der leere Platzhalter oben ist der einzige, den die nächste Version braucht
	lines[wip] = `### ${version} (${date})`;
	lines.splice(start + 1, 0, "", "### **WORK IN PROGRESS**");

	writeFileSync(file, lines.join(eol), "utf8");
	return `Changelog im ${file}`;
}

/**
 * Liest den ersten Eintrag des WIP-Blocks (ohne Autoren-Präfix) als News-Text.
 *
 * @param {string} file Pfad des README
 * @returns {string} News-Text
 */
function newsFromChangelog(file) {
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	const start = lines.findIndex(line => /^##\s+changelog\s*$/i.test(line));
	const wip = lines.findIndex((line, index) => index > start && /^###\s+\*\*WORK IN PROGRESS\*\*\s*$/i.test(line));
	for (let index = wip + 1; wip >= 0 && index < lines.length; index++) {
		const bullet = /^-\s+(.+?)\s*$/.exec(lines[index]);
		if (bullet) {
			return bullet[1].replace(/^\([^)]+\)\s*/, "");
		}
		if (/^###\s/.test(lines[index])) {
			break;
		}
	}
	throw new Error("der Abschnitt 'WORK IN PROGRESS' enthält keinen Eintrag für die News");
}

/**
 * Ergänzt `common.news` um einen Eintrag für die neue Version.
 *
 * Die Datei wird geparst und neu geschrieben (Tabulatoren, wie im Repository üblich), nicht per Textersetzung:
 * so kann kein ungültiges JSON entstehen. Der neueste Eintrag steht vorn — genau wie es das iobroker-Plugin des
 * Release-Werkzeugs macht.
 *
 * @param {string} file Pfad von io-package.json
 * @param {string} version neue Version
 * @param {string} news Text (zunächst in allen Sprachen derselbe)
 * @returns {string} Meldung für die Ausgabe
 */
function writeNews(file, version, news) {
	const ioPackage = JSON.parse(readFileSync(file, "utf8"));
	ioPackage.common.news ??= {};
	if (ioPackage.common.news[version]) {
		return `News für ${version} steht schon in ${file}`;
	}

	ioPackage.common.news = {
		[version]: Object.fromEntries(LANGUAGES.map(language => [language, news])),
		...ioPackage.common.news,
	};
	writeFileSync(file, `${JSON.stringify(ioPackage, null, "\t")}\n`, "utf8");
	return `News für ${version} in ${file} (Übersetzungen noch offen: npm run translate)`;
}

// Ablauf
const { bump, news, dry, repo } = readArguments();
try {
	const packageFile = join(repo, "package.json");
	const ioPackageFile = join(repo, "io-package.json");
	const readmeFile = join(repo, "README.md");
	for (const file of [packageFile, ioPackageFile, readmeFile]) {
		if (!existsSync(file)) {
			throw new Error(`${file} fehlt`);
		}
	}

	const current = JSON.parse(readFileSync(packageFile, "utf8")).version;
	const version = nextVersion(current, bump);
	const date = new Date().toISOString().slice(0, 10);
	const text = news?.trim() ? news.trim() : newsFromChangelog(readmeFile);

	console.log(`${current} -> ${version}${dry ? " (Probelauf, nichts wird geschrieben)" : ""}`);
	console.log(`News: ${text}`);
	console.log("");

	if (!dry) {
		console.log(writeVersion(packageFile, version));
		console.log(writeVersion(ioPackageFile, version));
		console.log(writeChangelog(readmeFile, version, date));
		console.log(writeNews(ioPackageFile, version, text));
		console.log("");
		console.log("Danach: npm run version:check, npm run check:i18n und die Tests laufen lassen,");
		console.log("die News übersetzen (npm run translate) und die Freigabe für den Push holen.");
	}
	process.exit(0);
} catch (error) {
	console.error(`Versionssprung nicht möglich: ${error.message}`);
	process.exit(1);
}
