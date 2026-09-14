# adapter/ – ioBroker-Adapter `zeiterfassung`

Hier entsteht der Adapter (TypeScript, `@iobroker/adapter-core`, Fastify, SQLite via `better-sqlite3`).

**Geplant in Phase 1:** Das Verzeichnis wird mit `npx @iobroker/create-adapter@latest` erzeugt (TypeScript und
jsonConfig auswählen), damit `io-package.json`, `admin/` (jsonConfig), `src/lib/adapter-config.d.ts` und die
Teststruktur den ioBroker-Konventionen entsprechen. `build/` wird generiert und niemals direkt bearbeitet.
Deshalb liegen hier (noch) keine generierten Adapter-Dateien. Das **veröffentlichte** Adapter-README wird
in Phase 1 erstellt und folgt der ioBroker-Konvention (Beschreibung, Installation, Konfiguration, States,
Changelog, Lizenz, Herkunft).

Verbindliche Vorgaben für die Umsetzung:

- **Lizenz:** MIT – `package.json` (`license`, `author`, `contributors`, `files` inkl. `LICENSE`) und
  `io-package.json` (`common.licenseInformation`, `common.authors`).
- **API und States:** Endpunkte und State-Namen wie in der internen Spezifikation festgelegt
  (liegt außerhalb dieses Repositories und wird nicht veröffentlicht).
- **Domänenlogik und Datenmodell:** ebenfalls dort festgelegt, inklusive des Mappings der Altdaten.
- **Clean Room:** kein Code/keine Bezeichner aus dem Legacy-Baum (siehe [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).
- Die PWA wird als statischer Build nach `www/` übernommen (generiert, siehe `.gitignore`).
- **Metadaten (Pflicht im offiziellen Repository):** `common.title`/`titleLang` (ohne die Wörter „ioBroker"
  und „Adapter"), `desc` in allen 11 Sprachen, `type` (Kategorie aus der offiziellen Liste), `connectionType`,
  `dataSource`, `mode: daemon`, `tier`, `loglevel`, `adminUI.config: json`, `licenseInformation`, `authors`,
  `news` (maximal 7 Einträge mit `NEXT`-Platzhalter).
- **States:** aussagekräftige `common.role` je State (die generische Rolle `state` ist unzulässig),
  `common.name` mindestens in `en` + `de`.
- **Tests:** `@iobroker/testing` (`tests.packageFiles` und `tests.integration`); eigene Logik zusätzlich mit Vitest.
- **Timer und Fehler:** Adapter-Timer (`this.setTimeout`/`this.setInterval`) statt globaler Timer; `try`/`catch`
  in jedem Handler, damit keine unbehandelte Rejection den Adapter beendet.

