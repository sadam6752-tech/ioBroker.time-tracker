# adapter/ – ioBroker-Adapter `zeiterfassung`

Hier entsteht der Adapter (TypeScript, `@iobroker/adapter-core`, Fastify, SQLite via `better-sqlite3`).

**Geplant in Phase 1:** Das Verzeichnis wird mit `npm create iobroker.adapter@latest` erzeugt, damit
`io-package.json`, `admin/` (JSONConfig) und die Teststruktur den ioBroker-Konventionen entsprechen.
Deshalb liegen hier (noch) keine generierten Adapter-Dateien.

Verbindliche Vorgaben:

- **Lizenz:** MIT – `package.json` (`license`, `author`, `contributors`, `files` inkl. `LICENSE`) und
  `io-package.json` (`common.licenseInformation`, `common.authors`) gemäß Projektprompt 12.6.
- **Struktur/Endpunkte:** Projektprompt Abschnitt 4 (API) und Abschnitt 5 (ioBroker-States).
- **Domänenlogik:** Projektprompt Abschnitt 3; Datenmodell Abschnitt 2 und Legacy-Mapping 2.9.
- **Clean Room:** kein Code/keine Bezeichner aus dem Legacy-Baum (Projektprompt 12.5, `CONTRIBUTING.md`).
- Die PWA wird als statischer Build nach `www/` übernommen (generiert, siehe `.gitignore`).
