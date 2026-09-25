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

**Randnotiz:** Einen Weg, die Pausenstaffel zu pflegen, gab es zuerst nicht — die Tabelle `pause_rules` hatte
keinen Schreiber mehr (der Datenimport ist mit D1 entfallen), also waren die Regeln in einer frischen Installation
leer und „Pause" dort immer `0:00`. Seit der letzten Runde gibt es dafür `GET`/`PUT /api/pause-rules` (Recht
`settings.edit`) und einen Editor im Reiter **Einstellungen**: Regeln mit „ab Minuten / bis Minuten / Pause
Minuten" und einem Schalter je Regel; der Aufruf ersetzt die ganze Tabelle, fehlende Regeln werden entfernt.

**Nachweis:** Der Stundennachweis zeigt neben „Pause" die Spalte **„davon bezahlt"** (`day_aggregates.paid_break_min`,
Migration 14) samt Summe — so sieht man im PDF und in der Excel-Datei, welcher Teil der Pause bezahlt wurde.

## D6 — Zeiten ändert nur die Verwaltung, der Mitarbeiter notiert den Tag (24.09.2026)

Wer eine Zeit ändern kann, kann Arbeitszeit erfinden. Bis hierher durfte ein `employee` **eigene** Stempel innerhalb
des Bearbeitungsfensters (`edit_window_days`, Vorgabe 7 Tage) ändern und ergänzen; im Monat öffnete der Stift genau
diesen Dialog. Zwei Dinge daran waren falsch:

1. **Der Monatsdialog war nicht auf den Mitarbeiter bezogen.** `DayCorrectionsDialog` fragte die Stempel **ohne**
   `userId` ab (`api.entries(date, date)`), der Server setzte damit das eigene Konto ein — und `createEntry` schrieb
   mit `userId: session.user.id`. Im Monat eines Mitarbeiters (`/month?userId=…`) zeigte und änderte die Verwaltung
   also ihre **eigenen** Stempel; „Stempel hinzufügen" legte einen Stempel im eigenen Konto an.
2. **Die Zeit ist nicht die Sache des Mitarbeiters.** Eine vergessene Stempelung ist eine **Mitteilung**, keine
   Korrektur: der Mitarbeiter weiß, dass er sie vergessen hat, die Verwaltung bucht sie.

**Entscheidung:** Zeiten gehören der Verwaltung, der Mitarbeiter **notiert**.

| Rolle | Stift im Monat | Inhalt des Dialogs |
| --- | --- | --- |
| `admin`, `manager` (`time.edit_other`) | eigener Monat und Monat eines Mitarbeiters | Stempel des Tages: ergänzen, Zeit ändern, löschen (`time.delete`), **Begründung** fürs Protokoll — bezogen auf den Mitarbeiter, dessen Monat offen ist |
| `employee` | nur eigener Monat | **Notiz zum Tag** („An-/Ausstempeln vergessen"), sonst nichts |

Serverseitig dahinter: `POST /api/entries` (Nachtrag von Hand) und jedes Setzen von `tsUtc` in
`PATCH /api/entries/:id` verlangen `time.edit_other`; ein eigener Stempel lässt sich also nur noch **kommentieren**
(`note`). `DELETE` bleibt `time.delete`. Gestempelt wird weiter über `time.punch` (`/punch`, `/punch/quick`, die
Offline-Warteschlange `/entries/sync`).

**Die Notiz** braucht einen eigenen Ort, weil genau der Tag **ohne** Stempel der Fall ist, für den sie gedacht ist:
Tabelle `day_notes` (Migration 25, ein Eintrag je Mitarbeiter und Tag) mit `GET`/`PUT /api/day-notes` (eigene Tage mit
`time.edit_own`, fremde mit `time.edit_other`; leerer Text löscht) und `POST /api/day-notes/handled` — die Verwaltung
hakt die Notiz als **erledigt** ab, sie bleibt sichtbar. Der Monat markiert einen Tag mit Notiz (Symbol neben dem
Saldo): offen = gelb, erledigt = grau.

**Das Administrator-Konto stempelt nicht:** Es wird bei der Installation angelegt und gehört niemandem, es verwaltet
die Mitarbeiter. Die Rolle `admin` verliert deshalb `time.punch` (Seed und Migration 26); wer zusätzlich arbeitet,
bekommt das Recht über die Rolle `employee` zurück (Rechte sind die Vereinigung der Rollen). Der `manager` stempelt
und korrigiert weiter. Die Startseite erklärt dem Konto ohne Stempelrecht, wofür es da ist.

**Wirkung auf das Bearbeitungsfenster:** Hier war eine Prüfung übrig geblieben, die niemanden mehr erreichen konnte:
`requireInsideEditWindow` hätte eigene Stempel außerhalb von `edit_window_days` abgewiesen — eigene Zeiten ändern darf
nach dieser Entscheidung aber nur, wer `time.edit_other` hat, und für ihn stieg die Prüfung vorher aus. Sie ist
deshalb entfernt (samt Problem `edit_window_closed`). Die Einstellung bleibt und wirkt an genau einer Stelle: auf die
**Offline-Warteschlange** — ein gestempelter Eintrag, der älter als `edit_window_days` ankommt, wird als Konflikt
`too_old` gespeichert und zählt erst, wenn die Verwaltung ihn annimmt. `GET /entries/conflicts` nimmt dafür `?userId=`
entgegen, damit die Verwaltung die Warteschlange eines Mitarbeiters sieht.

**Nachweis:** `src/lib/db/repositories/dayNotes.test.ts`, die Rechte in `src/lib/web/api.test.ts` (Mitarbeiter: 403
für Zeiten, 200 für die eigene Notiz), `too_old` in `src/lib/services/sync.test.ts` und der Ablauf in
`test/e2e/day-notes.spec.ts` (Notiz des Mitarbeiters, Korrektur und „erledigt" der Verwaltung).

## D7 — Es bleibt immer ein aktiver Administrator (24.09.2026)

Ein Administrator kann sich selbst die Verwaltung entziehen. Zwei Wege führten dorthin: das **Deaktivieren** des
eigenen Kontos (dagegen half schon eine Sonderregel — `PATCH /users/:id` und `DELETE /users/:id` lehnen es ab, weil die
laufende Sitzung sofort enden würde) und das **Entziehen der Rolle `admin`** über den Rollen-Dialog. Der zweite Weg war
ungeschützt: wer der letzte aktive Administrator ist und sich die Rolle nimmt, kann danach nichts mehr verwalten —
Mitarbeiter, Rollen, Terminals, Einstellungen und Sicherungen hängen allein an dieser Rolle. Zurück käme man nur über
einen Neustart der Instanz mit einem **freien** `adminLogin` (`ensureAdministrator` legt nur dann einen Administrator
an, wenn es keinen **aktiven** gibt, und scheitert mit `LoginExistsError`, wenn der konfigurierte Login vergeben ist).

**Entscheidung:** Eine Änderung, die die Installation ohne aktiven Administrator zurücklassen würde, wird abgelehnt —
Problem `last_administrator`, Status 409. Die Regel prüft **beide** Felder zusammen (`isActive` und `roleKeys`), weil
eine Anfrage beide setzen kann, und zählt nur **aktive** Konten: ein deaktivierter Administrator hilft niemandem.

| Situation                                                            | Ergebnis                                          |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| letzter aktiver Administrator wird deaktiviert                        | 409 `last_administrator`                          |
| letzter aktiver Administrator verliert die Rolle / `roleKeys: []`     | 409 `last_administrator`                          |
| es bleibt ein anderer aktiver Administrator                           | 200, die Änderung geht durch                      |
| eigenes Konto deaktivieren                                            | 400 `ValidationError` (eigene Regel, unverändert) |

`DELETE /users/:id` deaktiviert Konten ebenfalls, verlangt aber `user.deactivate` — das trägt nur die Rolle `admin`, der
Aufrufer ist also selbst ein aktiver Administrator und das Ziel nie der letzte. Die Regel steht deshalb nur im `PATCH`;
ein Kommentar an der Stelle hält das fest.

**Die Oberfläche warnt vorher:** Der Schalter des **eigenen** Kontos erklärt in einem Dialog, warum das eigene Konto
nicht deaktiviert werden kann, statt eine Anfrage zu schicken, die abgelehnt würde. Der Rollen-Dialog nennt beim letzten
aktiven Administrator, dass die Rolle nicht entzogen werden kann, und sperrt „Speichern", solange der Haken fehlt; bei
jedem anderen eigenen Konto warnt er nur, dass sofort alle Verwaltungsrechte wegfallen. Die Meldung des Servers
erscheint als `error.last_administrator` in allen elf Sprachen.

**Nachweis:** `src/lib/web/api.test.ts` („keeps the last active administrator in place": zweiter Administrator,
Ablehnung für den letzten, Erfolg sobald ein anderer die Rolle trägt), `test/e2e/users.spec.ts` (Warnung am eigenen
Konto, gesperrtes Speichern, unveränderter Zustand).

## D8 — Der Kalender geht als Feed und als Zustand an ioBroker (24.09.2026)

Der persönliche ICS-Link aus 0.5.0 (`POST /calendar/token` → `GET /calendar.ics?token=…`) ist für Mitarbeiter gedacht:
Er zeigt **eine** Person und wird in einer Kalender-App eingetragen. Für ioBroker fehlte beides: eine Sicht auf die
**ganze Firma** und ein Weg, der ohne Netz, Token und Kopieren auskommt.

**Entscheidung:** Der Kalender der Firma wird auf drei Wegen angeboten, alle ohne Sitzung:

| Weg   | Wie                                                                                             | Für wen                                                                          |
| ----- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Datei | `<iobroker-data>/files/time-tracker.<n>/calendar.ics`, bei jeder Änderung und alle 5 Minuten neu | den `ical`-Adapter als **lokale Datei** — kein URL, kein Token, kein Netz — und einen Browser über den Dateiserver einer `web`-Instanz |
| URL   | `GET /api/calendar.ics?token=<Instanz-Token>` (der Instanz-Token wird zuerst geprüft)            | eine Kalender-App oder ein Skript, das den Link an `ical.0.iCalReadTrigger` gibt  |
| Daten | `calendar.absences` (JSON) und `calendar.updatedAt`                                              | Skripte, Blockly, VIS                                                             |

Die Datei liegt bewusst in `files/` statt im Instanz-Ordner daneben: den kann nur der Adapter lesen, `files/` liefert
eine `web`-Instanz dagegen als Download aus (`http://<host>:8081/files/time-tracker.0/calendar.ics`). Der **Link**
muss unter dem Präfix `/api` liegen — ohne es bekommt ein Browser die Web-Oberfläche samt Anmeldung statt des
Kalenders (`companyFeedUrl` in `src/lib/services/calendar.ts` hält das fest, die Routine wird getestet).

*(Nachtrag 25.09.2026: der Dateiserver-Weg hat sich als nicht tragfähig erwiesen — siehe **D11**.)*

Der Instanz-Token entsteht **nicht** von selbst: `commands.rotateCalendarToken` (Boolean-State wie `commands.backup`)
legt ihn an und ersetzt ihn bei jedem weiteren Aufruf — ein alter Link ist damit sofort tot. Das ist Absicht: der Link
öffnet die Abwesenheiten **aller** Mitarbeiter, also bekommt ihn nur, wer danach fragt. `calendar.feedUrl` bleibt leer,
bis das passiert ist.

Der ICS-Bau (`absenceEvents`, `calendarDocument`) wandert dafür in einen Service (`src/lib/services/calendar.ts`), den
die Route **und** der Adapter benutzen — zwei Fassungen desselben Formats wären der nächste Fehler. Der Firmenkalender
stellt den Namen des Mitarbeiters voran (`Anna Muster: Ferien (F)`), damit ein Tag im Firmenkalender lesbar bleibt; die
`UID` bleibt `absence-<id>@time-tracker`, damit eine Kalender-App ein Ereignis **aktualisiert** statt es zu verdoppeln.

**Nachweis:** `src/lib/services/calendar.test.ts` (DTEND exklusiv, Maskierung, JSON-Sicht),
`src/lib/web/api.test.ts` (Firmen-Feed über den Instanz-Token, persönlicher Link bleibt persönlich, alter Token tot),
`src/lib/adapter/states.test.ts` (States und Befehl) und die Abnahme **T21** in `docs/testplan.md`.

## D9 — Die Quellen der Web-App heißen `src-www/` (24.09.2026)

Der Repository-Checker liest die Quellen des Repositories und prüft importierte Pakete gegen die Wurzel-
`package.json` (`W5042`). Er überspringt nur die Ordner einer **festen** Liste (`excludedSourceDirs` in
`lib/M5000_Code.js`): `/admin`, `/build`, `/docs`, `/test`, `/tools`, `/www`, `/widgets`, `/src-admin`,
`/src-www`, `/src-vis`, `/src-widgets` und weitere. `src-pwa/` stand **nicht** darauf, deshalb meldete der PR
zum LATEST-Repository fünf `W5042` (react, MUI, i18next, `@tanstack/react-query`, `react-i18next`) und
verlangte eine Entscheidung vor der Prüfung: Es zählen nur `dependencies` — `@types/*` und `@iobroker/types`
sind die einzige Ausnahme, die in `devDependencies` liegen darf.

**Entscheidung:** Die Quellen der Web-App liegen in **`src-www/`** (vorher `src-pwa/`). Der Ordner steht auf
der Liste des Checkers, passt namentlich zur Auslieferung aus `www/`, und die App-Abhängigkeiten bleiben in
`src-www/package.json`: sie gehören nicht in die Installation eines Adapters, denn zur Laufzeit wird aus den
Quellen nichts geladen — `npm run build:pwa` legt das fertige Bundle in `www/` ab. Der andere Weg (react, MUI
und i18next in die Wurzel-`package.json` aufnehmen) hätte jede ioBroker-Installation mit einem zweiten
Frontend-Stapel beliefert und wäre inhaltlich falsch gewesen. Fachlich ändert der Umbau nichts: der Adapter
liefert unverändert `www/` aus, alle Skripte und Workflows zeigen nur auf den neuen Pfad.

**Nachweis:** `npm run check`, `npm run lint`, `npm run build`, `npm run build:pwa`, `npm run test:ts`,
`npm run test:package`, `npm run check:adapter`, `npm run check:i18n` und `npm run version:check` sind grün;
die Abnahme steht als **T22** in `docs/testplan.md`.

## D10 — Eine Automatikregel darf ein Gültigkeitsfenster haben (24.09.2026)

Eine Regel lief bisher, bis sie jemand ausschaltete. Für eine dauerhafte Regel ist das richtig — für eine
Ferienvertretung, eine Saisonkraft oder einen Projektzeitraum nicht: dort soll die Regel von selbst beginnen und von
selbst aufhören, ohne dass jemand daran denken muss.

**Entscheidung:** Jede Regel trägt zwei optionale Datumsfelder `active_from` und `active_until` (Migration 27).
Beide sind **reine Datumsangaben** (`YYYY-MM-DD`), absichtlich ohne Uhrzeit: die Regelzeit selbst steht schon als
Minute des lokalen Tages in der Regel, und ein Fenster mit Uhrzeit hätte die Frage nach der Zeitzone aufgeworfen (die
Regel gilt *je Mitarbeiter* lokal). Verglichen wird deshalb das **lokale Kalenderdatum des Mitarbeiters**
(`local.date` in `runAutomationRules`) — genau der Tag, mit dem auch die Wochentage und der Merker in
`automation_runs` arbeiten. Damit ist nichts umzurechnen: „gültig bis 15.10." heißt für jeden Mitarbeiter der
15. Oktober an seinem Ort, und ein Tageswechsel um Mitternacht fällt nicht auseinander.

Beide Enden sind **einschließlich**; das leere Feld ist die offene Seite — „gültig ab leer" = ab sofort, „gültig bis
leer" = unbegrenzt. Ein Auswahlwert „ab sofort" wäre nicht speicherbar gewesen: er hätte beim Speichern in ein festes
Datum umgerechnet werden müssen und danach wie eine bewusst gesetzte Grenze ausgesehen. Die Oberfläche schreibt die
Bedeutung trotzdem hin: die Felder tragen „Leer = ab sofort" und „Leer = unbegrenzt", und die Regelliste zeigt bei
einer begrenzten Regel „gültig ab …", „gültig bis …" oder „gültig … – …".

Geprüft wird das Fenster in `evaluateAutomation` (reine Funktion, direkt nach dem Wochentags-Check) — damit steht die
Entscheidung samt Begründung im Debug-Log und ist ohne Adapter testbar. Ein abgelaufenes Fenster ist **kein** Fehler;
Speichern bleibt erlaubt, sonst ließen sich alte Regeln nicht mehr ändern. Das Fenster setzt den Merker in
`automation_runs` **nicht** zurück: eine Regel feuert weiterhin höchstens einmal pro Zeitraum (Tag bzw. ISO-Woche),
und liegt der Regelzeitpunkt des ersten Tages vor „gültig ab", fällt dieser Tag aus und wird nicht nachgeholt.

**Nachweis:** `src/lib/adapter/automation.test.ts` (Tag davor, genau „ab", genau „bis", Tag danach, beide Enden leer),
`src/lib/db/repositories/automations.test.ts` (Speichern und Lesen, „weglassen behält", „leer leert", 30.02. wird
abgelehnt, „bis vor von" wird abgelehnt), `src/lib/web/api.test.ts` (die Daten reisen mit der Regel, 400 bei
ungültigem Datum) und die Abnahme **T23** in `docs/testplan.md`. Die Liste unter der Tabelle zeigt außerdem nur noch
die **fünf** jüngsten Ausführungen (vorher zwanzig) — sie ist ein Blick auf das letzte Verhalten, kein Archiv.

## D11 — Der Dateiserver ist kein Weg zum Kalender (25.09.2026)

Beim Nachprüfen von T21 kam heraus, dass der in D8 und im README versprochene Download über eine `web`-Instanz **nicht**
funktioniert: `http://<host>:8081/files/time-tracker.0/calendar.ics` liefert die Datei nicht, und der naheliegende Weg
ohne Instanznummer (`…/files/time-tracker/calendar.ics`) liefert ein **leeres ZIP-Archiv** (22 Bytes, `PK\x05\x06`).
Die Anfrage landet damit im öffentlichen Web-Bereich und nicht im Instanzordner; ein Kalender ist das nicht.

**Entscheidung:** Der Datei-Weg wird **nicht** mehr als Download angeboten. `calendar.feedFile` bleibt, was es ist —
der **absolute Pfad** der geschriebenen Datei, den der `ical`-Adapter als lokale Datei liest (beim Test geprüft, in
Ordnung). Für Browser, Kalender-Apps und Skripte ist `calendar.feedUrl` der Weg: der Link des Adapters mit dem
Instanz-Token, der dieselbe, vollständige Datei liefert. README, Testplan und die Zeile der Zustandstabelle sagen das
jetzt so (letztere nennt `feedFile` ausdrücklich einen *Pfad*).

Zwei Punkte bleiben offen und wurden bewusst nicht mit erledigt:

- **Schreibvorgang:** Die Datei wird bei jeder Änderung und alle fünf Minuten mit `writeFileSync` neu geschrieben —
  erst leeren, dann schreiben. Ein Leser, der genau in diesem Moment liest, kann eine halbe Datei erwischen. Robust
  wäre ein atomares Schreiben (erst `calendar.ics.tmp`, dann `rename`); kein akutes Problem, weil der `ical`-Adapter
  in Minutenabständen liest.
- **Sichtbarkeit:** Alles unter `<iobroker-data>/files/…` ist über eine `web`-Instanz **ohne Anmeldung** erreichbar.
  Der Firmenkalender liegt damit in einem öffentlichen Ordner, obwohl der API-Weg ein Token verlangt. Wer das nicht
  möchte, kann die Datei in den Instanzordner (`<iobroker-data>/time-tracker.<n>/`) zurückholen — der `ical`-Adapter
  liest sie von dort genauso.

**Nachweis:** **T24** in `docs/testplan.md` (der Link liefert die vollständige ICS-Datei, der `ical`-Adapter liest
`calendar.feedFile`, README und Doku nennen keinen Dateiserver-Link mehr) und der geänderte Abschnitt *Calendar for
ioBroker* im README.
