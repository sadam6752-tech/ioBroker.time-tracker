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
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm run build`            | TypeScript-Quellen kompilieren                                               |
| `npm run watch`            | kompilieren und auf Änderungen warten                                        |
| `npm run install:pwa`      | Abhängigkeiten der Web-App installieren (`src-pwa`, eigene `node_modules`)   |
| `npm run build:pwa`        | Web-App typgeprüft nach `www/` bauen                                         |
| `npm run dev:pwa`          | Vite-Dev-Server mit `/api`-Proxy auf die laufende Instanz                    |
| `npm run lint`             | ESLint (`@iobroker/eslint-config`) für Adapter und Web-App                   |
| `npm run check`            | TypeScript-Typprüfung (Adapter und Web-App)                                  |
| `npm run test:ts`          | Unit-Tests der Adapter-Quellen                                               |
| `npm run test:package`     | `package.json` / `io-package.json` prüfen                                    |
| `npm run test:integration` | Adapterstart gegen echten js-controller (packt `build/` und `www/`)          |
| `npm run e2e`              | Browser-Tests (Playwright) gegen `e2e/server.mjs`                            |
| `npm run coverage`         | Unit-Tests mit Coverage-Bericht                                              |
| `npm run translate`        | die 11 Übersetzungsdateien abgleichen                                        |
| `npm run check:i18n`       | prüfen, dass alle 11 Sprachen vollständig sind                               |
| `npm run check:adapter`    | lokale Vorprüfung der ioBroker-Regeln (`docs/adapter-check.md`)              |
| `npm run version:bump`     | Version anheben, Changelog und `common.news` pflegen                         |
| `npm run version:check`    | Version, Changelog und die Längengrenzen der Listen prüfen                   |
| `npm run push:approve`     | den aktuellen Commit für den Push freigeben (vorher den Auftraggeber fragen) |
| `npm run release`          | Release anlegen (Version, Changelog, Tag)                                    |
| `dev-server watch`         | Adapter lokal starten und debuggen                                           |

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
- **Kleinere Lücken:** die maschinell übersetzten Sprachdateien der Web-App warten auf eine Durchsicht durch
  Muttersprachler. Der frühere Wunsch „NFC-Komfort im Adminbereich" ist **erledigt** — statt einer Handy-NFC-App
  (die nur Android-Chrome kann) löst jetzt jeder ioBroker-State eine Aktion aus (siehe README, „Actions"): der
  Adapter abonniert die States der Tabelle, feuert nur bei Wertwechsel und stempelt, rundet oder setzt die
  Anwesenheit.

## Paketgrenzen (und was der ioBroker-Repochecker dazu sagt)

Der Adapter hat **zwei** `package.json`: die Wurzel für den Adapter selbst (Laufzeit-Abhängigkeiten wie
`better-sqlite3`, `pdfkit`, `exceljs`, `luxon`, `ws`) und `src-pwa/` für die Web-App (React, MUI, i18next, `qrcode`,
…). Die Web-App wird mit `npm run build:pwa` **vorgebaut** und liegt danach als fertiges Bundle in `www/`; zur
Laufzeit des Adapters wird davon nichts geladen.

Deshalb meldet `npx @iobroker/repochecker … --local` das `W5042` („Package … is used in source file(s) but not found
in dependencies of package.json") für die PWA-Pakete: bei dieser Aufteilung ist das **erwartet** — die Abhängigkeiten
stehen in `src-pwa/package.json` und sind für den Adapter reine Entwicklungs-Abhängigkeiten. `W5049` (`process.env`
in `e2e/server.mjs`) betrifft den **Testserver** der Browsertests, nicht den Adapter. `S1039` schlägt den
Compact-Mode vor — der Adapter bringt einen eigenen HTTP-Port und eine SQLite-Datei mit und läuft bewusst **nicht** im
Compact-Mode (`common.compact: false`).

**Lizenzangaben:** `common.licenseInformation` (`{ type: "free", license: "MIT" }`) ist gesetzt — und daneben darf
**kein** `common.license` stehen: der ioBroker-Pakettest (`npm run test:package`) lehnt beides zusammen ab
(„common.license should not exist together with common.licenseInformation"). Die Lizenzangabe im `package.json`
(`"license": "MIT"`) bleibt davon unberührt und muss dazu passen. Genau daran ist die 0.1.7-Pipeline gescheitert, und
deshalb gehört `npm run test:package` zur Prüfliste vor jedem Release.

## Objektstruktur (E3009)

Der ioBroker-Bot prüft die Objektliste eines laufenden Systems („Object Structure Check – `time-tracker.0.json`").
Er verlangt zu **jedem** State die übergeordneten Objekte: `users.<id>.todayWorkedMinutes` braucht den Kanal
`users.<id>` **und** den Kanal `users`. Fehlt einer davon, meldet der Check `E3009` („missing intermediate object")
für jedes betroffene Objekt — im PR #6697 waren das **126 Meldungen aus einem einzigen fehlenden Kanal** (`users`).

Deshalb legt `createUserChannel` (`src/lib/adapter/states.ts`) den Wurzelkanal `users` mit an, idempotent über
`setObjectNotExists`; die übrigen Kanäle (`info`, `company`, `events`, `commands`) entstehen in ihren jeweiligen
`create…States`-Funktionen.

## Nach der Umbenennung: zwei Regeln mehr

Der Wechsel auf `ioBroker.time-tracker` hat zwei Dinge sichtbar gemacht, die vorher nicht greifen konnten:

- **`common.news` gilt je npm-Paket** (Repochecker `E2004`): jede dort genannte Version muss unter **diesem** Namen
  auf npm liegen. Die 0.1.x-Versionen liegen nur unter dem früheren Paket `iobroker.zeiterfassung`, deshalb beginnt
  die News-Liste mit 0.2.0 — die Vorgeschichte erklärt `CHANGELOG_OLD.md`.
- **`bluefox` muss Miteigentümer des npm-Pakets sein** (Repochecker `E2001`):
  `npm owner add bluefox iobroker.time-tracker` bzw. auf npmjs.com einladen — ohne ihn wird kein Adapter in `latest`
  aufgenommen. `npm run version:check` erinnert als **Warnung** daran (die Einladung muss bluefox selbst annehmen,
  deshalb blockiert der Punkt den Push nicht).

`npm run version:check` prüft die News-Versionen gegen npm (Fehler) und die Eigentümerliste des Pakets (Warnung);
offline werden beide Punkte übersprungen, damit die Prüfung weiterläuft.
