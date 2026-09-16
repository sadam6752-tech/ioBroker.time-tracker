# Entscheidungen und Abweichungen

Dieses Dokument hält Entscheidungen fest, die vom ursprünglichen Umfang abweichen, damit sie später nachvollziehbar
bleiben. Wie `docs/adapter-check.md` und `docs/testplan.md` ist es bewusst **deutsch** — die `README.md` bleibt
englisch (Vorgabe des Adapter-Checkers).

## D1 — Kein Import der Altdaten des Vorgängersystems (16.09.2026)

**Entscheidung:** Der Adapter liest die Bestandsdaten des Vorgängersystems **nicht** ein. Es gibt keinen Importer,
keinen Probelauf und keine Import-Berichte.

**Was mit Commit `184414c` entfernt wurde** (65 Dateien, 41 Zeilen ergänzt, 3861 entfernt):

| Teil | Umfang |
| --- | --- |
| Parser (`src/lib/legacy/parsers.ts`) | `Data/users.txt`, `Data/group.txt`, `<Login>/userdaten.txt` (18 indexbasierte Zeilen), `<Login>/absenz.txt`, `Timetable/<Jahr>` (12 Zeilen Soll/Saldo in Stunden), `Timetable/<Jahr>.<Monat>` (Stempelzeitpunkte), `Timetable/A<Jahr>` (Abwesenheiten), `Timetable/auszahlungen`, `Timetable/total.txt`, `include/Settings/pausen.txt`, `include/Settings/settings.txt` |
| Erkennung (`scan.ts`) | eine Installation anhand ihres Verzeichnisaufbaus erkennen (interne Spezifikation 2.9.10, Schritt 1) |
| Import (`import.ts`) | Zuordnung und Normalisierung, Probelauf und echter Lauf, Idempotenz, Dubletten, Bericht |
| Oberfläche | Admin-Reiter, Adapter-Befehl (`sendTo`), REST-Routen, `native`-Felder (Verzeichnis, Probelauf, Wiederholen) |
| Testdaten | `fixtures/smalltime/**` und `tools/make-legacy-fixture.mjs` |
| Herkunft | `docs/provenance.md`, `tools/cleanroom-check.ps1` (siehe D3) |

**Folgen**

- Die Migrationen räumen die Zwischenstände wieder ab: `users.legacy_sha1`, `work_profiles.legacy_source` und
  `rfid_tags.legacy_code` samt Index `idx_rfid_legacy` werden entfernt, wenn sie vorhanden sind
  (`src/lib/db/migrations.ts`).
- **Kein Anwender ist betroffen:** der Rückbau lief am 16.09.2026 um 08:18, die erste Veröffentlichung `0.0.4`
  erschien um 16:32 auf npm — **keine** veröffentlichte Version enthielt den Importer.
- `time_entries.source` und `EntrySource` kennen den Wert `import` weiterhin, er wird nur nicht mehr erzeugt.
- Der Abnahmepunkt „Altdaten dry-run-fähig importierbar" der internen Spezifikation ist damit **bewusst offen**; der
  Abnahmelauf in `docs/testplan.md` prüft nur noch das Verhalten des Adapters selbst.

**Begründung:** _— vom Maintainer nachzutragen (ein bis zwei Sätze: Umfang, Clean-Room-Risiko der Feldzuordnung,
kein Bedarf bei einem Neustart ohne Bestandsübernahme) —_

**Falls der Import zurückkommen soll:** Der vollständige Stand liegt in der Git-Historie
(`git show 184414c^:src/lib/legacy/import.ts`). Nötig wären: Testdaten unter `fixtures/smalltime/**` (aus einer
echten Installation, **nicht** aus fremdem Programmcode abgeleitet), die vier Datenbankspalten über eine neue
Migration, Admin-Reiter, Adapter-Befehl und REST-Routen.

## D2 — `common.compact: false`

Der Adapter bindet einen eigenen HTTP-Port und hält eine SQLite-Datei im WAL-Modus über die gesamte Laufzeit, läuft
also bewusst als eigener Prozess. Begründung, Umgang mit dem Hinweis `W5049` und die daraus folgende Regel „kein
`process.env`/`process.exit` im Quellcode" stehen in [`adapter-check.md`](adapter-check.md).

## D3 — Herkunftsnachweis außerhalb des Repositories (16.09.2026)

Bis zum 16.09.2026 lagen `docs/provenance.md` (Quelle und Datum des Referenzsystems, Vorgehen beim Nachweis) und
`tools/cleanroom-check.ps1` (Textabgleich gegen die Referenzinstallation) im Repository. Beide wurden mit Commit
`184414c` entfernt, weil mit dem Importer (D1) der einzige Teil wegfiel, der Formate und Bezeichner des
Vorgängersystems berührte.

**Was bleibt:** Der Abschnitt [„Provenance"](../README.md#provenance) der `README.md` nennt die Herkunft, und die
Clean-Room-Regeln stehen verbindlich in [`CONTRIBUTING.md`](../CONTRIBUTING.md) (Abschnitt 1). Der Nachweis selbst
wird **außerhalb** dieses Repositories geführt.

**Wenn der automatische Abgleich zurückkommen soll:** Das Skript liegt in der Historie
(`git show 184414c^:tools/cleanroom-check.ps1`); es erwartet die Referenzinstallation als Pfad-Parameter
(`-LegacyPath`) und meldet Treffer als Liste.
