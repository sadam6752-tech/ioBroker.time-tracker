# Zeiterfassung – PWA + ioBroker-Adapter

Monorepo für die Neuentwicklung einer Zeiterfassung: **ioBroker-Adapter `zeiterfassung`**
(HTTP/WebSocket-API, Geschäftslogik, SQLite) und **PWA** (React + MUI, installierbar, offlinefähig)
mit RFID/NFC-Stempeln, Berichten/Exporten und ioBroker-Integration.

- **Status:** Phase 0 (Vorbereitung) – Gerüst, Lizenz, Metadaten, Clean-Room-Regeln
- **Spezifikation (verbindlich):** [`../PROJECT_PROMPT.md`](../PROJECT_PROMPT.md) – insbesondere
  Abschnitt 2.9 (Legacy-Mapping), Abschnitt 3 (Domänenlogik) sowie Abschnitt 12 (Lizenz/Clean-Room)
- **Lizenz:** MIT (siehe [`LICENSE`](LICENSE))

## Struktur

```
app/
├── adapter/          ioBroker-Adapter (TypeScript) – wird in Phase 1 erzeugt
├── pwa/              PWA (Vite + React + MUI) – Phase 5
├── shared/           gemeinsame Typen und Validierung (zod) für Adapter und PWA
├── docs/
│   ├── provenance.md         Herkunft und Nachweis der unabhängigen Umsetzung
│   └── cleanroom-report.txt  generierter Prüfbericht (nicht versioniert)
├── tools/
│   └── cleanroom-check.ps1   Clean-Room-Prüfung (Abschnitt 12.5)
├── CONTRIBUTING.md
├── LICENSE
└── package.json
```

## Voraussetzungen

- Node.js **>= 20** (getestet mit 22.x), npm
- `pwsh` (PowerShell 7) für das Clean-Room-Werkzeug – läuft unter Windows und auf Linux-CI-Runnern
- Für die Migration: eine laufende Referenzinstallation (SMALL-Time) und die Bestandsdaten

## Erste Schritte

```bash
# Clean-Room-Abgleich der eigenen Quellen gegen den Legacy-Baum (Abschnitt 12.5)
pwsh -NoProfile -File tools/cleanroom-check.ps1 -LegacyPath ../SmallTime-master -SourcePaths adapter,pwa,shared

# als CI-Variante mit Exit-Code 1 bei Treffern
npm run cleanroom
```

Der Bericht landet in `docs/cleanroom-report.txt`; das Ergebnis wird zusätzlich in
[`docs/provenance.md`](docs/provenance.md) dokumentiert.

## Arbeitsweise (Kurzfassung)

Verbindlich ist **Abschnitt 12.5 des Projektprompts** – Details in [`CONTRIBUTING.md`](CONTRIBUTING.md):

1. Spezifikation zuerst, dann Tests (Golden-Files aus beobachteten Ausgaben), dann Implementierung.
2. **Kein** Code, keine Kommentare, keine Bezeichner aus dem Legacy-Projekt übernehmen.
3. Zulässig: Dateiformate und Feldindizes der Altdaten, Berechnungsregeln und Verhalten.
4. Vor jedem Merge: Clean-Room-Prüfung (Review-Kriterium + Skript).

## Nächste Schritte

- **Phase 0/1:** Adapter-Gerüst mit `npm create iobroker.adapter@latest` in `adapter/` erzeugen,
  Root-Workspaces ergänzen, CI (Lint, Typecheck, Test, Build) einrichten.
- **Phase 2:** SQLite-Schema und Migrationen aus Abschnitt 2 des Projektprompts.
- **Phase 9/10:** Legacy-Import mit Dry-Run und Golden-Abgleich gegen `Timetable/<Jahr>`.

## Herkunft / Danksagung

Dieses Projekt ist eine unabhängige Neuimplementierung. Verhalten, Berechnungsregeln und Datenformate
wurden anhand einer laufenden SMALL-Time-Installation (SmallTime v0.9.205, © IT-Master, AGPL-3.0)
ermittelt, um bestehende Daten weiterverwenden zu können. Es wurde **kein Quellcode** übernommen;
die Lizenz dieses Projekts ist MIT. Nachweis: [`docs/provenance.md`](docs/provenance.md).
