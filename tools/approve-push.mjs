/**
 * Markiert den aktuellen Commit als für den Push freigegeben.
 *
 * Der Pre-Push-Hook bricht einen Push ab, wenn für den Commit keine Freigabe vorliegt — vorausgesetzt, die
 * Freigabepflicht ist in der Arbeitskopie eingeschaltet:
 *
 *   git config zt.requirePushApproval true      # einschalten (lokale Einstellung, nicht versioniert)
 *   git config zt.requirePushApproval false     # dauerhaft ausschalten
 *
 * Vorher zeigt das Skript, welche Commits gepusht würden, damit die Freigabe informiert erfolgt. Die Freigabe gilt
 * nur für genau diesen Commit: der nächste Commit braucht wieder ein OK (siehe `CONTRIBUTING.md`, Abschnitt 8).
 *
 * Verwendung:
 *   npm run push:approve
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * Ruft ein Git-Kommando auf und liefert seine Ausgabe.
 *
 * @param {string[]} args Argumente für `git`
 * @returns {string} Ausgabe ohne abschließende Leerzeilen
 */
function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const head = git(["rev-parse", "HEAD"]);

// zeigen, was ohne Freigabe auf den Server ginge (ein fehlender Upstream ist kein Fehler)
let pending = "";
try {
	pending = git(["log", "--oneline", "@{u}..HEAD"]);
} catch {
	pending = "(kein Upstream gesetzt oder noch keine Commits)";
}

const marker = join(git(["rev-parse", "--git-dir"]), "ZT_PUSH_APPROVED");
writeFileSync(marker, `${head}\n`, "utf8");

console.log("Commits, die gepusht würden:");
console.log(pending === "" ? "(keine)" : pending);
console.log("");
console.log(`Freigegeben: ${head}`);
console.log(`Marker: ${marker}`);
console.log("Hinweis: der nächste Commit braucht wieder eine Freigabe (npm run push:approve).");
process.exit(0);
