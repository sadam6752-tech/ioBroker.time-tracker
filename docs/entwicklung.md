# Entwicklung

Repository, Skripte, Tests und Release. Die verbindlichen Regeln stehen in [`CONTRIBUTING.md`](../CONTRIBUTING.md);
das [README](../README.md) beschreibt den Adapter für Anwender.

## Aufbau

```
src/          Adapter-Quellen (TypeScript)
src-pwa/      Progressive Web App (Vite + React + MUI) — wird nach www/ gebaut
src-shared/   Typen und Prüfungen, die Adapter und Web-App teilen
admin/        jsonConfig der Instanz und Übersetzungen (11 Sprachen)
test/         Paket- und Integrationstests (@iobroker/testing)
e2e/          Browser-Tests (Playwright, eigener Server ohne ioBroker)
docs/         Bedienungs-, Technik- und Übersetzer-Dokumentation
```

## Skripte

| Skript                     | Beschreibung                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm run build`            | TypeScript-Quellen kompilieren                                              |
| `npm run watch`            | kompilieren und auf Änderungen warten                                       |
| `npm run install:pwa`      | Abhängigkeiten der Web-App installieren (`src-pwa`, eigene `node_modules`)  |
| `npm run build:pwa`        | Web-App typgeprüft nach `www/` bauen                                        |
| `npm run dev:pwa`          | Vite-Dev-Server mit `/api`-Proxy auf die laufende Instanz                   |
| `npm run lint`             | ESLint (`@iobroker/eslint-config`) für Adapter und Web-App                   |
| `npm run check`            | TypeScript-Typprüfung (Adapter und Web-App)                                 |
| `npm run test:ts`          | Unit-Tests der Adapter-Quellen                                              |
| `npm run test:package`     | `package.json` / `io-package.json` prüfen                                   |
| `npm run test:integration` | Adapterstart gegen echten js-controller (packt `build/` und `www/`)         |
| `npm run e2e`              | Browser-Tests (Playwright) gegen `e2e/server.mjs`                           |
| `npm run coverage`         | Unit-Tests mit Coverage-Bericht                                             |
| `npm run translate`        | die 11 Übersetzungsdateien abgleichen                                       |
| `npm run check:i18n`       | prüfen, dass alle 11 Sprachen vollständig sind                              |
| `npm run check:adapter`    | lokale Vorprüfung der ioBroker-Regeln (`docs/adapter-check.md`)             |
| `npm run version:bump`     | Version anheben, Changelog und `common.news` pflegen                        |
| `npm run release`          | Release anlegen (Version, Changelog, Tag)                                   |
| `dev-server watch`         | Adapter lokal starten und debuggen                                          |

## Bauen

Für ein Release werden **beide** Ausgaben gebraucht — `build/` (Adapter) und `www/` (Web-App):

```bash
npm run install:pwa
npm run build:pwa
npm run build
```

`node tools/make-pwa-icons.mjs` erzeugt die App-Icons neu (im Repository enthalten, keine Bildbibliothek nötig).

## Offen

- **Abnahmelauf auf echter Hardware:** Freigabe der Layouts und der PDF-Darstellung für `ru`, `uk`, `zh-cn` und
  Polnisch (dafür braucht es eine Unicode-Schrift über `report_font_path`). Der **Import der Altdaten** des
  Vorgängersystems gehört nicht zum Umfang — die Begründung steht in [`entscheidungen.md`](entscheidungen.md).
- **Veröffentlichung:** Das Paket liegt auf npm (die CI veröffentlicht es über npm trusted publishing mit
  Herkunftsnachweis); offen ist der Eintrag in `ioBroker.repositories`.
- **Kleinere Lücken:** der NFC-Komfort im Adminbereich (Ausweis-Link mit dem Handy lesen und schreiben) und die
  maschinell übersetzten Sprachdateien der Web-App, die auf eine Durchsicht durch Muttersprachler warten.
