/**
 * Prüft, ob das Paket vollständig ist, bevor es gepackt oder veröffentlicht wird.
 *
 * Der Adapter liefert zwei Bauausgaben aus, die **nicht** im Repository liegen (`.gitignore`): `build/` aus den
 * TypeScript-Quellen und `www/` aus dem PWA-Projekt. Beide entstehen erst beim Bauen. Fehlt eine davon, ist das
 * Paket zwar installierbar, aber unbrauchbar: ohne `www/` antwortet die Web-Oberfläche mit `404 not_found` — genau
 * das passierte den Veröffentlichungen bis 0.0.6. Diese Prüfung lässt `npm pack`/`npm publish` scheitern, statt ein
 * unvollständiges Paket herauszugeben; über `prepack` läuft sie automatisch.
 *
 * Verwendung:
 *   node tools/check-package.mjs                 # prüft das Repository im aktuellen Verzeichnis
 *   node tools/check-package.mjs --repo <pfad>   # prüft ein anderes Verzeichnis
 *   npm run check:package
 *
 * Rückgabewert: 0 = vollständig, 1 = mindestens eine Datei fehlt oder ist leer.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Dateien, ohne die das Paket nicht benutzbar ist, samt Bauschritt. */
const REQUIRED = [
	{ file: "build/main.js", build: "npm run build" },
	{ file: "www/index.html", build: "npm run install:pwa && npm run build:pwa" },
	{ file: "io-package.json", build: "(gehört zum Repository)" },
	{ file: "admin/jsonConfig.json", build: "(gehört zum Repository)" },
];

/**
 * Sammelt fehlende oder leere Bauausgaben.
 *
 * @param {string} directory - Wurzel des Repositories
 * @returns {string[]} Befunde; leer, wenn das Paket vollständig ist
 */
export function checkPackage(directory) {
	const problems = [];
	for (const entry of REQUIRED) {
		const file = join(directory, entry.file);
		if (!existsSync(file)) {
			problems.push(`${entry.file} fehlt — bauen mit: ${entry.build}`);
			continue;
		}
		if (statSync(file).size === 0) {
			problems.push(`${entry.file} ist leer — bauen mit: ${entry.build}`);
		}
	}
	return problems;
}

// Aufruf über die Kommandozeile (läuft über `prepack` automatisch vor `npm pack` und `npm publish`)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const index = args.indexOf("--repo");
	const repo = resolve(index >= 0 ? (args[index + 1] ?? ".") : ".");
	const problems = checkPackage(repo);

	if (problems.length === 0) {
		console.log(`Paket vollständig (${repo})`);
		process.exit(0);
	}

	console.error(`Paket unvollständig (${repo}):`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	console.error("");
	console.error("Die Bauausgaben gehören nicht ins Repository (.gitignore) und entstehen beim Bauen:");
	console.error("  npm run build && npm run install:pwa && npm run build:pwa");
	process.exit(1);
}
