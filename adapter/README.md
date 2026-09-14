# adapter/ – ioBroker-Adapter `zeiterfassung`

Hier entsteht der Adapter (TypeScript, `@iobroker/adapter-core`, Fastify, SQLite via `better-sqlite3`).

**Geplant in Phase 1:** Das Verzeichnis wird mit `npm create iobroker.adapter@latest` erzeugt, damit
`io-package.json`, `admin/` (JSONConfig) und die Teststruktur den ioBroker-Konventionen entsprechen.
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

