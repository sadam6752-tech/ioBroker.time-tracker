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

**Begründung:** Ein Importer hätte die Bedeutung jeder einzelnen Spalte der Bestandsdaten festlegen müssen; ohne
eine echte Datenkopie der Referenzinstallation wäre diese Zuordnung nur geraten — und die Regeln in
[`CONTRIBUTING.md`](../CONTRIBUTING.md), Abschnitt 1, verbieten es, sie aus fremdem Programmcode oder dessen
Oberfläche abzuleiten. Gebraucht wurde er nicht: der Adapter startet mit leeren Stammdaten, die Administration
legt Benutzer, Arbeitsprofile und Abwesenheiten selbst an. Der Rückbau entfernte 65 Dateien und 3861 Zeilen; der
frühere Stand bleibt über die Historie (`184414c`) erreichbar.

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

## D4 — Sicherungen aus dem Browser: Upload über den rohen Body, Limit pro Route (17.09.2026)

Die Verwaltung konnte eine Sicherung herunterladen und eine **gelistete** einspielen. **Löschen** und das
**Einspielen einer heruntergeladenen Datei** fehlten — beides braucht dieselbe Entscheidung am Transport: Die API
liest jeden Body gegen eine **routerweite** Grenze (2 MiB), und eine Route konnte bisher keine eigene setzen. Eine
Sicherung ist größer als diese Grenze.

**Entscheidung:** `RouteDefinition` bekommt ein optionales `maxBodyBytes`. Nur `POST /backup/restore` setzt es
(64 MiB), alle anderen Routen bleiben bei 2 MiB — die Tests halten beides fest (ein großer Body gegen eine andere
Route endet weiterhin in `413 payload_too_large`). Der Web-Server liest mit derselben Schranke
(`MAX_BACKUP_UPLOAD_BYTES`), weil der Transport einen Body zurückweist, bevor eine Route ihn überhaupt sieht.

Der Upload kommt als **roher Body** (`application/octet-stream`) an, nicht als Base64 in JSON: Der Browser schickt
die gewählte Datei direkt (`body: file`), der Server hält sie für diesen Content-Type als **Bytes** statt als Text.
Ein UTF-8-Dekodieren würde Binärdaten zerstören; dafür gibt es einen Test mit einer Bytefolge, die kein gültiges
UTF-8 ist (Größe **und** SHA-256 müssen ankommen). Name und Grund reisen als Query-Parameter; der Name ist nur eine
Beschriftung für Anzeige und Protokoll und wird vor dem Speichern auf `[A-Za-z0-9._-]` bereinigt.

**Sicherheitsnetz:** Die neue Datei ersetzt die wartende erst, **nachdem** sie geprüft wurde — sie wird zuerst als
`<…>.part` geschrieben, verifiziert und dann umbenannt. Eine abgelehnte Datei lässt eine bereits eingereihte
Wiederherstellung also unberührt, und eine halb geschriebene Datei kann nie beim nächsten Start zur Datenbank
werden.

**Löschen:** `DELETE /api/backup/:name` löscht ausschließlich Dateien, die in der Liste stehen (ein Name von außen
erreicht nie das Dateisystem), schreibt `backup.remove` ins Audit und fragt in der Oberfläche nach. Die automatische
Rotation bleibt unberührt und läuft weiter im Hintergrund.

## D5 — Pause aus dem Stempel oder aus der Pausenstaffel (17.09.2026)

Der Stundennachweis hat eine Spalte „Pause", und gerechnet wurde `Saldo = Summe(Paare) − Staffel − Soll`. Zwei
Dinge daran waren irreführend beziehungsweise falsch:

1. **Die Spalte zeigte die tatsächliche Pause nicht.** Wer Kommen/Gehen/… stempelt, erzeugt Paare; die Zeit
   zwischen zwei Paaren ist die Pause. Sie fehlte in der Summe der Paare (also im „brutto") — die Spalte „Pause"
   wurde aber allein aus der Pausenstaffel gefüllt. Ergebnis: Wer eine halbe Stunde stempelt, sah `Pause 0:00`.
2. **Eine gestempelte Pause wurde doppelt abgezogen**, sobald zusätzlich eine Staffelregel griff: die Lücke fehlte
   schon im brutto, die Regel zog noch einmal ab (07:00/13:30/14:00/17:00 ergab 9:00 statt 9:30).

**Entscheidung:** Die Rechnung geht jetzt von der **Anwesenheit** aus (erster Stempel bis letzter fertiger Stempel)
und zieht genau eine Pause ab:

| Modus (`pause_mode`) | Spalte „Pause" | Arbeitszeit |
| --- | --- | --- |
| `auto` (Vorgabe) | gestempelte Pause, sonst Staffel | Anwesenheit − Pause |
| `punched` | nur die gestempelte Pause (`0:00`, wenn nichts gestempelt wurde) | Anwesenheit − Pause |
| `staffel` | nur die Staffelregeln | Anwesenheit − Pause |

Die Staffel bleibt damit, wofür sie gedacht ist: die pauschale Pause für Tage, an denen niemand stempelt. Ein Tag
mit **offenem** Stempel hat noch keine endgültige Pause — dort greift die Staffel.

**Bezahlte Pause:** Neues Feld `work_profiles.pause_paid_minutes` (Migration 13) mit einem Zahlenfeld im
Arbeitsprofil je Mitarbeiter: **so viele Minuten der Pause pro Tag werden bezahlt** (`0` = gar nicht). Ein Wert von
`1440` bezahlt eine Pause in beliebiger Länge; eine Firma, die nur eine Viertelstunde bezahlt, trägt `15` ein. Die
bezahlten Minuten werden der Arbeitszeit zugeschlagen, die restliche Pause bleibt Abzug — die Spalte „Pause" zeigt
weiterhin die **ganze** Pause, damit der Nachweis nachvollziehbar bleibt. (Zuerst war das ein Ja/Nein-Schalter;
Migration 13 wandelt ihn um: „bezahlt" wird zu `1440`.)

**Randnotiz:** Einen Weg, die Pausenstaffel zu pflegen, gibt es noch nicht — die Tabelle `pause_rules` hat keinen
Schreiber mehr (der Datenimport ist mit D1 entfallen), also sind die Regeln in einer frischen Installation leer und
„Pause" war dort immer `0:00`. Ein Editor dafür bleibt offen.
