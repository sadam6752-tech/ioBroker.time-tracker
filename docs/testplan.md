# Abnahme- und Testplan (erste reale Tests)

Dieses Dokument ist die Arbeitsanleitung für die **ersten Tests auf einer echten ioBroker-Installation**.
Es beschreibt Voraussetzungen, Testdaten, die Testfälle T1–T17 mit Erwartung und die Abnahmekriterien.
Für die Installation bis zum ersten Stempel gibt es `docs/erste-schritte.md`; die Schritte dort entsprechen der
Vorbereitung unten.
Die öffentliche `README.md` bleibt englisch (Vorgabe des Adapter-Checkers) — dieses Betriebsdokument ist
bewusst deutsch, wie `docs/adapter-check.md`.

## 1. Ziel

Nachweisen, dass der Adapter im produktiven Betrieb das tut, was die Spezifikation (Abschnitte 3, 4, 9)
verlangt: stempeln (online, offline, Terminal), rechnen (Soll, Pausen, Saldo, Ferien, Feiertage),
berichten (Excel, PDF), Rechte serverseitig durchsetzen, sichern und wiederherstellen.

## 2. Testumgebung

| Punkt          | Anforderung                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ioBroker       | js-controller ≥ 6.0.11, admin ≥ 7.6.20                                                                                                                                                                    |
| Node.js        | ≥ 22 (lokal geprüft mit 22.22)                                                                                                                                                                            |
| Ports          | Adapter-Port frei (Standard `8092`), `127.0.0.1` genügt für den Test                                                                                                                                      |
| HTTPS          | für die Installation der PWA (Service Worker) **erforderlich**; im Test ein Reverse-Proxy (nginx/caddy) mit einem selbst ausgestellten Zertifikat oder ein Gerät im gleichen Netz mit gültigem Zertifikat |
| Browser        | Chrome/Edge (Android) oder Safari (iOS) für die Installation; Desktop-Browser für die API-Sicht                                                                                                           |
| Terminal-Gerät | Tablet/Handy im Kiosk-Modus (Bildschirm bleibt an) **oder** ein Browser-Tab                                                                                                                               |
| Zeit           | eine Stunde für den Durchlauf; T3 (offline) braucht Ruhe, um den Abgleich zu beobachten                                                                                                                   |

Zwei Konten sind Pflicht: **Administrator** (alles) und **Mitarbeiter** (nur eigene Daten) — nur so werden
Rechtefehler sichtbar.

## 3. Installation für den Test

```bash
cd <repo>
npm ci
npm run install:pwa
npm run build:pwa      # erzeugt www/ (Web-App)
npm run build          # erzeugt build/ (Adapter)
npm run dev-server     # startet den Adapter in einem Wegwerf-js-controller
```

Alternativ in eine vorhandene Installation (nach Veröffentlichung auf npm):

```bash
iobroker url https://github.com/sadam6752-tech/ioBroker.time-tracker
```

Nach dem Start: Instanz öffnen, **Port** und **Bind-Adresse** prüfen, `report_font_path` nur setzen, wenn
PDF-Berichte in `ru`, `uk` oder `zh-cn` gebraucht werden (sonst antwortet der Bericht mit `422
report_font_missing` — das ist erwartetes Verhalten, kein Fehler).

| Sprache                                  | Geprüfte Schrift (17.09.2026, echter Bericht mit eingebetteter Schrift)                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ru`, `uk`                               | `arial.ttf` (Arial deckt Kyrillisch ab)                                                          |
| `zh-cn`                                  | `malgun.ttf` (Malgun Gothic deckt die chinesischen Zeichen ab)                                   |
| `pl`                                     | `arial.ttf` — die polnischen Buchstaben (ś, ć, ł, ż, ę) liegen außerhalb der eingebauten Schrift |
| `de`, `en`, `fr`, `it`, `es`, `nl`, `pt` | keine nötig; mit gesetzter Schrift wird sie ebenfalls eingebettet                                |

Eine **fehlende** Datei oder eine Schrift ohne die nötigen Zeichen führt zu derselben Fehlermeldung wie eine
gar nicht gesetzte Einstellung — der Bericht wird also nie mit leeren Kästchen ausgeliefert.

## 4. Testdaten

1. Anmeldung im Admin-Formular: das Konto `admin` (bzw. der eingestellte Login) mit dem Startpasswort aus der
   Instanzeinstellung — ist sie leer, steht ein zufälliges Startpasswort **einmalig im Adapter-Log** —
   **Passwort sofort ändern**
   (der Adapter verlangt das beim ersten Login).
2. In der Web-App unter **Verwaltung → Mitarbeiter** anlegen:
    - `anna` (Rolle _Mitarbeiter_), Passwort nach Policy (≥ 8 Zeichen, Groß-/Kleinbuchstaben, Ziffern)
    - `chef` (Rolle _Manager_, falls Abnahme fremder Monate geprüft werden soll)
    - für `anna` einen **Badge-PIN** (4–8 Ziffern) setzen → für T4
3. Arbeitsprofil von `anna` in der Web-App prüfen (**Verwaltung → Mitarbeiter → _Arbeitsprofil_**): Beschäftigungsgrad,
   Wochenstunden, Arbeitstage, Überstundenmodell, Ferientage, Überträge und **bezahlte Pausenminuten pro Tag**
   (z. B. `15` = eine Viertelstunde der Pause ist bezahlt, `0` = die Pause wird nicht bezahlt); dazu in
   **Verwaltung → Einstellungen** die **Pausenregel** wählen (Vorgabe: gestempelte Pause, sonst Staffel).
4. Ein **Terminal** anlegen — in der Web-App unter **Verwaltung → Terminals** (oder per `POST /api/terminals`),
   PIN-Pflicht eingeschaltet lassen.
   Danach die Kiosk-Ansicht auf dem Gerät öffnen: die Verwaltung zeigt dafür die fertige Adresse
   `http://<Adapter-Host>:<Port>/terminal?token=<Gerätetoken>` an (den Token zeigt sie **einmalig**; das Gerät
   merkt ihn sich für den nächsten Start).
5. Feiertage für das Testjahr erzeugen (Einstellung _Feiertagsland_), Abwesenheitsart _Ferien_ prüfen.

## 5. Testfälle

| Nr  | Titel                           | Schritte                                                                                                                                                                                                                                                                                                                                      | Erwartung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Anmeldung und Rechte            | als `admin` anmelden, dann als `anna`; `GET /api/users` einmal mit jedem Token aufrufen (Browser-Konsole oder curl)                                                                                                                                                                                                                           | `admin`: 200 mit Liste; `anna`: **403** `permission_denied` — die API entscheidet, nicht die Oberfläche                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T2  | Kommen/Gehen online             | `anna` anmelden, „Kommen" stempeln, kurz warten, „Gehen"                                                                                                                                                                                                                                                                                      | Bestätigung mit Uhrzeit; Tageswerte (Arbeitszeit/Soll/Saldo) aktualisieren sich ohne Neuladen; Ereignis kommt sofort an                                                                                                                                                                                                                                                                                                                                                                                                            |
| T3  | Offline-Stempeln + Abgleich     | im Browser offline gehen, zweimal stempeln (Kommen, Gehen), wieder online gehen                                                                                                                                                                                                                                                               | Warteschlange zeigt 2 Stempel, Abgleich lädt hoch, **keine Duplikate** (gleiche UUID), Konfliktliste bleibt leer                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T4  | Kiosk-Terminal                  | Terminal öffnen, Badge-PIN von `anna` eingeben, stempeln                                                                                                                                                                                                                                                                                      | Stempel mit Quelle `terminal`, in der Monatsansicht sichtbar; Konto ohne Stempelrecht wird mit 403 abgewiesen                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T5  | RFID-Tag                        | Tag anlegen, `POST /rfid/scan` mit gültigem Token/TTL (curl)                                                                                                                                                                                                                                                                                  | 201 + Stempel; abgelaufener TTL → 401/403                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T6  | Monatsansicht                   | Monat mit Feiertag, Abwesenheit und offenem Stempel öffnen                                                                                                                                                                                                                                                                                    | Tagessummen stimmen mit der Liste überein, Feiertag/Abwesenheit ausgezeichnet, offener Stempel markiert, Saldo plausibel; die Kopfzeile zeigt **Pause** (bei bezahlten Pausen zusätzlich „davon bezahlt“ in Klammern) und jede Tageszeile ihre eigene Pause                                                                                                                                                                                                                                                                        |
| T7  | Berichte                        | Excel und PDF für Monat **und** Jahr erzeugen; dabei Tage mit **gestempeltem Loch** und Tage **ohne** Stempel vergleichen; danach als Administrator im Reiter _Berichte_ einen **Mitarbeiter auswählen** und dessen Excel/PDF laden sowie über den Monatsnamen dessen Monatsansicht öffnen                                                    | beide laden, Dateiname mit Zeitraum, Zahlen identisch zur Monatsansicht; die Spalte **Pause** zeigt die gestempelte Pause (Lücke zwischen den Paaren) bzw. an Tagen ohne Stempel die Pausenstaffel, und **nie beides zusammen**; die Spalte **„davon bezahlt"** zeigt die bezahlten Minuten (Summe am Fuß); die Datei des Mitarbeiters trägt **dessen** Login im Namen und seine Monatsansicht zeigt dessen Tage; ohne Unicode-Schrift in `ru`/`uk`/`zh-cn` → **422 `report_font_missing`** mit Hinweis auf `report_font_path`     |
| T8  | Abwesenheiten                   | Antrag für `anna` stellen (z. B. Ferien, halber Tag), Status ändern                                                                                                                                                                                                                                                                           | Antrag in Liste und Monatsansicht, Faktor wirkt auf Soll/Ist, Statuswechsel im Audit                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T9  | Monatsabschluss                 | Kommando `commands.closeMonth` in ioBroker setzen                                                                                                                                                                                                                                                                                             | Abschluss-States ändern sich, Ereignis im Live-Stream, zweiter Abschluss läuft ohne Fehler (idempotent)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T10 | Sicherung und Wiederherstellung | „Sicherung jetzt erstellen"; danach die Zeile **herunterladen** (Knopf in der Liste) und die Datei außerhalb des Adapters ablegen; dann **eine Liste auswählen und wiederherstellen** und die Instanz neu starten; zusätzlich die abgelegte Datei über **Sicherung hochladen** einspielen und eine einzelne Sicherung **löschen** (Rückfrage) | Sicherung mit Zeitstempel, Rotation hält die eingestellte Anzahl; der Download liefert die Datei als Anhang; eine hochgeladene Datei wird geprüft und erscheint als „wird beim nächsten Start eingespielt"; eine fremde Datei wird mit „Diese Datei ist keine Sicherung dieses Adapters" abgelehnt und lässt eine wartende Wiederherstellung unberührt; nach dem Neustart meldet das Log `restored the database from …` und die Daten der Sicherung sind da (die vorherige Datei liegt als `<Datenbank>.before-restore-…` daneben) |
| T11 | Live-Ereignisse                 | PWA in zwei Browsern öffnen (`admin` + `anna`), in einem stempeln                                                                                                                                                                                                                                                                             | der andere Browser aktualisiert sofort; ein Mitarbeiter sieht **keine** fremden Ereignisse                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T12 | Korrektur und Audit             | Eintrag in der Monatsansicht ändern/löschen (Recht vorausgesetzt)                                                                                                                                                                                                                                                                             | Änderung erscheint im Audit mit Feldänderungen und Begründung                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T13 | Sicherheit                      | (a) 20× falsches Passwort; (b) Anfrage ohne CSRF-Token; (c) `../../etc/passwd` im Pfad; (d) Anfrage ohne Token                                                                                                                                                                                                                                | (a) **423** Sperre, läuft nach Ablauf aus; (b) 403; (c) 400/404; (d) 401                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T14 | ioBroker-States und Befehle     | States unter `time-tracker.0.*` prüfen, `commands.punch` setzen                                                                                                                                                                                                                                                                              | Werte plausibel, `info.connection` true, Button-States `read: false`, gelöschter Benutzer hinterlässt keine States                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T15 | Sprachen                        | Oberfläche auf `de`, dann `ru`, dann `zh-cn`; Berichte in derselben Sprache                                                                                                                                                                                                                                                                   | keine abgeschnittenen Texte, Datum/Zahlen lokal formatiert, Bericht in der Sprache des Nutzers                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T16 | PWA-Installation                | Adapter-URL über **HTTPS** öffnen, „Zum Startbildschirm hinzufügen", App starten, neu bauen und neu laden                                                                                                                                                                                                                                     | App läuft im eigenen Fenster, Icon ist das Logo, Update ohne hängenden Alt-Cache                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T17 | Last (Stichprobe)               | `npm run load-smoke -- --login <Benutzer> --password '<Passwort>'` (Standard: 5 Stempel parallel; `--count 10 --base http://…` möglich, Passwort alternativ in `ZT_PASSWORD`)                                                                                                                                                                 | keine Fehler, alle 5 Stempel vorhanden, Antwortzeiten im Sekundenbereich — das Skript prüft beides selbst und endet nur dann mit Code 0                                                                                                                                                                                                                                                                                                                                                                                            |
| T18 | Notiz und Korrektur im Monat    | als `anna` anmelden und im Monat den Stift bei einem Tag in der Vergangenheit öffnen (nur das Feld „Notiz für die Verwaltung", keine Zeitfelder), eine Notiz speichern; als `admin` den Monat dieses Mitarbeiters öffnen, denselben Tag aufklappen (Stempel des Mitarbeiters und seine Notiz), einen Stempel ergänzen und „Als erledigt markieren" drücken; danach prüfen, ob das Administrator-Konto selbst stempeln kann | die Notiz erscheint als Symbol am Tag (offen = gelb, erledigt = grau) und Speichern schickt `PUT /day-notes`; die Verwaltung sieht **die Stempel des Mitarbeiters** (nicht die eigenen) und „Stempel hinzufügen" landet in seinem Konto (`source: admin`); `POST /entries` mit dem Token des Mitarbeiters antwortet `403 permission_denied`; das Administrator-Konto hat keinen Stempel-Knopf, die Startseite erklärt, wofür es da ist |
| T19 | Administrator-Schutz           | in der Verwaltung den Schalter der **eigenen** Zeile drücken, danach „Rollen" öffnen und den Haken „Administrator" entfernen; anschließend `PATCH /api/users/<eigene id>` mit `{"isActive": false}` und mit `{"roleKeys": []}` (Konsole oder curl, mit CSRF-Token) | der Schalter öffnet nur den Hinweis „Eigenes Konto", das Konto bleibt aktiv; der Rollen-Dialog zeigt den Hinweis zum letzten aktiven Administrator und lässt „Speichern" gesperrt; die API antwortet beide Male **409** `last_administrator`, die Rollen bleiben `["admin"]` |
| T20 | Abwesenheiten im PDF und in der Artenliste | einen Monat mit mindestens zwei Abwesenheiten als PDF herunterladen (Berichte → Monat als PDF) und in der Verwaltung eine Abwesenheitsart ansehen, die „Zieht vom Urlaub ab" **und** „Für alle sichtbar" trägt | die Abwesenheiten stehen **linksbündig** in je einer Zeile unter der Tagestabelle (nichts eingerückt, nichts umgebrochen); in der Artenliste steht „Für alle sichtbar" in einer eigenen Zeile unter den Fakten |
| T21 | Kalender in ioBroker           | `commands.rotateCalendarToken` auf `true` schreiben, dann `calendar.feedUrl` **im Browser** öffnen (die URL muss `/api/calendar.ics?token=…` enthalten), `calendar.feedFile` im `ical`-Adapter als **lokale Datei** eintragen (oder den Link an `ical.0.iCalReadTrigger` geben) und das Skript aus dem README (Abschnitt *Calendar for ioBroker*) im Skripte-Tab starten; danach eine Abwesenheit in der App anlegen | der Browser zeigt den `VCALENDAR`-Text (keine Anmeldung); der `ical`-Adapter und das Skript zeigen die Abwesenheit als „Name: Art (Code)", `calendar.updatedAt` und `calendar.absences` ändern sich sofort nach dem Anlegen; ein zweiter Aufruf des Befehls erzeugt einen **neuen** Token, der alte Link antwortet **401** |

## 6. Abnahmekriterien

- **T1–T13 sind grün.** T14–T17 mindestens je einmal erfolgreich.
- Die Wiederherstellung aus der Sicherung (T10) ist nachgewiesen: Datei kopieren, Adapter neu starten, Daten sind da.
- Jede Abweichung ist protokolliert (Nummer, Beobachtung, Bewertung) und entweder behoben oder bewusst als
  offener Punkt übernommen.

## 7. Protokoll (beim Test ausfüllen)

Die Abnahme lief auf **0.7.2** (Tag `v0.7.2`, Commit `3661f71`); T18 stammt aus der 0.7.1-Runde und wurde mit dieser
Version nachgeholt, T19 und T20 sind mit 0.7.2 dazugekommen; T21 wurde mit 0.7.3/0.7.4 abgenommen, T22 ist der
Umbau in 0.7.5 (Quellordner der Web-App und Intervall-Überlappung), T23 das Gültigkeitsfenster der Regeln in 0.7.6.

| Nr  | Datum | Tester | Ergebnis (ok / Abweichung) | Beobachtung |
| --- | ----- | ------ | -------------------------- | ----------- |
| T1  |       |        |                            |             |
| T2  |       |        |                            |             |
| T3  |       |        |                            |             |
| T4  |       |        |                            |             |
| T5  |       |        |                            |             |
| T6  |       |        |                            |             |
| T7  |       |        |                            |             |
| T8  |       |        |                            |             |
| T9  |       |        |                            |             |
| T10 |       |        |                            |             |
| T11 |       |        |                            |             |
| T12 |       |        |                            |             |
| T13 |       |        |                            |             |
| T14 |       |        |                            |             |
| T15 |       |        |                            |             |
| T16 |       |        |                            |             |
| T17 |       |        |                            |             |
| T18 | 24.09.2026 | Alex | ok | alles wie erwartet: Notiz am Tag (Symbol), Korrektur im fremden Monat landete beim Mitarbeiter, `POST /entries` des Mitarbeiters 403, Administrator-Konto ohne Stempel-Knopf |
| T19 | 24.09.2026 | Alex | ok | Schalter der eigenen Zeile öffnete nur den Hinweis, Rollen-Dialog sperrte „Speichern", API antwortete 409 `last_administrator`, Rollen unverändert |
| T20 | 24.09.2026 | Alex | ok | PDF-Abwesenheiten linksbündig in eigenen Zeilen unter der Tagestabelle, „Für alle sichtbar" in eigener Zeile unter den Fakten |
| T21 | 24.09.2026 | Alex | ok (eine Abweichung, behoben in 0.7.4) | `calendar.feedUrl` lieferte die Datei, der Download über den Dateiserver funktioniert, das Skript aus §10a loggt die Abwesenheiten; im ersten Durchlauf führte der Link zur Anmeldung — ihm fehlte das Präfix `/api`, behoben in 0.7.4 (Datei liegt im Instanzordner `files/time-tracker.0/`, sichtbar als eigener Eintrag im Dateimanager) |
| T22 | 24.09.2026 | Alex | ok | Umbau für 0.7.5: Die Quellen der Web-App liegen in `src-www/` (vorher `src-pwa/`, der Repochecker meldete dafür fünf `W5042` für react, MUI und i18next), der regelmäßige Abgleich und die stündliche Sicherungsprüfung überspringen einen Durchlauf, statt sich zu überlappen, und `onStateChange` schreibt keine Debug-Zeile mehr zu jedem fremden Zustand; `npm run check`, `lint`, `build`, `build:pwa`, `test:ts`, `test:package`, `check:adapter`, `check:i18n` und `version:check` sind grün, die Web-App wird unverändert aus `www/` ausgeliefert |
| T23 | 24.09.2026 | Alex | ok | Gültigkeitsfenster der Regeln: Im Dialog stehen „Gültig ab"/„Gültig bis" (leer = ab sofort bzw. unbegrenzt); eine Regel außerhalb des Fensters feuert nicht und nennt den Grund im Debug-Log, die Grenztage gehören dazu; ein unmögliches Datum und „bis vor von" werden mit 400 abgelehnt; das Fenster überlebt ein Speichern ohne Datumsänderung; „Letzte Ausführungen" zeigt nur noch die letzten fünf Läufe |
| T24 | 25.09.2026 | Alex | ok | Kalender-Weg korrigiert: `calendar.feedUrl` liefert die vollständige ICS-Datei (Browser zeigt `VCALENDAR`, keine Anmeldung) und der `ical`-Adapter liest `calendar.feedFile` als lokale Datei; der Dateiserver-Link ist aus README, T21 und den Zustandsbeschreibungen entfernt, weil `…/files/time-tracker/calendar.ics` nur ein leeres ZIP liefert (siehe D11) |
| T25 | 26.09.2026 | Alex | offen (mit 0.7.8 vorgelegt) | Regelübersicht: jede Zeile nennt ihre **neueste** Ausführung („Letzte Ausführung: … · Mitarbeiter", sonst „noch nie ausgeführt"), die Liste unter der Karte ist entfallen und neben „Regeln speichern" steht der Hinweis, dass die Tabelle als Ganzes gespeichert wird; eine Regel an allen sieben Tagen zeigt „einmal pro Tag" nur noch **einmal** (siehe D12) |
| T26 | 26.09.2026 | Alex | offen (mit 0.7.8 vorgelegt) | Storno-Weg: `anna` zieht einen offenen Antrag zurück, beantragt für eine genehmigte Abwesenheit das Storno (Grund optional) und sieht „Stornierung beantragt"; `admin` lehnt unter *Storno-Anträge* ab (die Tage bleiben gebucht) und nimmt den nächsten Antrag an (die Abwesenheit ist weg, das Löschen trägt `cancelRequested: true`); „Ändern"/„Löschen" in *Alle Abwesenheiten* ändern die Daten bzw. entfernen die Zeile (siehe D13) |

## 8. Bewusst nicht im Umfang dieser Runde

| Lücke                               | Auswirkung beim Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adminbereich-Ausbau                 | **Erledigt**: Rollenwechsel pro Zeile, Einstellungen, Tags, Feiertage, Statistik und Ausweise sind vorhanden — und seit dieser Runde die **Aktionen** (ein ioBroker-State löst Stempeln oder Anwesenheit aus) samt `sendTo`-Nachrichten (`punch`, `present`, `status`, `report`, `backup`). Der frühere Wunsch „NFC-Bedienung mit dem Handy“ ist **bewusst gestrichen**: sie kann nur Android-Chrome und stand in keinem Verhältnis zum Nutzen; ein Fingerabdruck-Leser, ein Taster oder ein Türkontakt wird jetzt über die Aktionen-Tabelle angebunden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9 Sprachen maschinell übersetzt     | Kernbegriffe (Stempeln, PIN) sind von Hand korrigiert; Fachjargon beim Test notieren.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Keine E2E-Tests (Playwright)        | `npm run e2e`, `test/e2e/server.mjs` startet die echte API + gebaute PWA): **26 Tests, alle grün** (Login, Sitzung über Cookie, Statistik, Kiosk- und Anwesenheits-Token, Ausweis-Link, Branding, Zeitkorrektur, Anwesenheits-Kacheln, Benutzer und Terminal, **Aktionen-Tabelle**, dazu seit der letzten Runde: **erzwungener Passwortwechsel beim Startpasswort**, **Monatsansicht**, **PDF-Nachweis als Download**, **Abwesenheits-Antrag**, **Sicherung herunterladen, hochladen und löschen**, **Arbeitsprofil mit „Pausen sind bezahlt“** und eine **Layout-Messung** (auf 360 px Breite darf keine Zeile ihre Aktionen über den Text legen)). Der E2E-Server läuft auf einer Wegwerf-Datenbankdatei (nicht im Arbeitsspeicher), damit sich eine Sicherung auch einspielen lässt. Der frühere Render-Fehler nach dem Login (React #130) ist behoben — die Symbole kommen über den Alias in `vite.config.ts` als echtes ES-Modul an — es gibt **keine** zurückgestellten Fälle mehr. T1–T13 bleiben Handarbeit, weil sie Rechte, Offline-Betrieb und echte Geräte prüfen. |
| PDF-Schriften (`ru`, `uk`, `zh-cn`) | Braucht eine Unicode-Schriftdatei über `report_font_path`; ohne sie kommt eine klare Fehlermeldung.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 9. Rückfall-Szenario

- Der Adapter schreibt **nur** in sein Datenverzeichnis (SQLite-Datei) und in seine eigenen ioBroker-Objekte.
  Eine bestehende Altanwendung bleibt unberührt und kann weiterlaufen.
- Rückfall: `iobroker stop time-tracker`, Datenbankdatei sichern, Altanwendung weiter betreiben.
- Vor jedem Testlauf eine Sicherung anlegen (T10) und die Datei **außerhalb** des Adapterverzeichnisses kopieren.

## 10. Ergebnis und nächste Schritte (nach dem Test)

- Offene Abweichungen als Liste in `PROJECT_PROMPT.md` (Abschnitt 13) ergänzen.
- Erst danach Version taggen (`npm run release -- patch|minor`) — der Deploy-Job veröffentlicht dann über
  npm (trusted publishing vorausgesetzt) und legt das GitHub-Release an.

## 10a. Prüfschnipsel für T21 (nur zum Nachsehen, nicht Teil des Adapters)

`calendar.absences` ist JSON; dieses Skript im **Skripte-Tab** schreibt die heute laufenden Abwesenheiten ins Log und
meldet sich bei jeder Aktualisierung des Adapters erneut:

```js
const id = "time-tracker.0.calendar.absences";

/** Schreibt die heute laufenden Abwesenheiten ins Log. */
function pruefeKalender() {
	const state = getState(id);
	if (!state || !state.val) {
		log("time-tracker: noch keine Abwesenheiten", "warn");
		return;
	}
	const heute = formatDate(new Date(), "YYYY-MM-DD");
	const laufend = JSON.parse(state.val).filter(
		a => a.approval === "approved" && a.from <= heute && a.to >= heute,
	);
	log(
		laufend.length === 0
			? "time-tracker: heute ist niemand abwesend"
			: `time-tracker: ${laufend.map(a => `${a.name} - ${a.type} (${a.code}) bis ${a.to}`).join(", ")}`,
	);
}

pruefeKalender();
on(id, pruefeKalender);
```

## 11. Entwicklungshinweise (Web-Oberfläche)

**Browser-Tests** (`npm run e2e`, Ordner `test/e2e/`): Sie starten `test/e2e/server.mjs` — das ist die echte API auf einer
In-Memory-Datenbank mit den gebauten Web-Dateien aus `www/`. Kein ioBroker nötig, keine Netzverbindung. Vor dem
Lauf **muss** `npm run build:pwa` gelaufen sein; die Tests blockieren den Service Worker, sonst würde Workbox die
alten Dateien aus dem Precache ausliefern.

> **Wichtig:** Erst den Exit-Code des Builds prüfen, dann das Testergebnis lesen. Ein abgebrochener Build (z. B.
> unbenutzter Import) hinterlässt `www/` unverändert — die Tests laufen dann still gegen den **alten** Stand.

> **Ein Lauf gilt für genau einen Server.** `playwright.config.ts` übernimmt einen laufenden E2E-Server
> (`reuseExistingServer`), und dieser Server hält seine Datenbank **im Speicher**: ein zweiter Lauf trifft den
> Zustand des ersten. Dann verwirft der Doppelscan-Schutz Stempel innerhalb von 30 Sekunden, und die Prüfung des
> Startpassworts scheitert, weil es bereits geändert wurde. Vor einem erneuten Lauf den Server auf Port `8099`
> beenden oder frisch starten; ein hart abgebrochener Lauf hinterlässt sonst einen Zombie-Server, an dem die
> nächste Runde mit `ERR_CONNECTION_REFUSED` scheitert (auch die Prüfung „Aktionen liegen nicht auf dem Text“
> in `test/e2e/layout.spec.ts` sieht dann einen anderen Datenbestand als erwartet).

**Web-App gegen den laufenden Adapter entwickeln** (schnelle Rückmeldung, React im Entwicklungsmodus mit lesbaren
Fehlern):

```bash
npm --prefix src-www run dev     # Port 5173, holt /api/… über den Proxy von 127.0.0.1:8092
```

Zwei Fallstricke, die dabei Zeit gekostet haben:

- Der Proxy in `src-www/vite.config.ts` muss als **berechneter** Schlüssel `[API_PREFIX]` stehen. Mit `API_PREFIX:`
  wird der wörtliche Text verglichen, der Proxy greift nie und jede API-Anfrage landet im App-Gerüst (Login läuft
  dann ins Leere, `GET /api/auth/me` liefert die HTML-Datei zurück).
- `@mui/icons-material` 5.x liefert jedes Symbol zweimal: als CommonJS (`Menu.js`) und als ES-Modul
  (`esm/Menu.js`). Ohne den Alias in `vite.config.ts` kann der Default-Import als Modulobjekt `{ default: … }`
  ankommen — React bricht dann mit „Element type is invalid … got: object“ (React #130) ab, und zwar erst nach
  dem Anmelden, weil die Symbole nur in der Shell und in den Masken vorkommen.

Nach einer Änderung an `vite.config.ts` den Zwischenspeicher `src-www/node_modules/.vite` löschen, sonst antwortet
der Dev-Server mit `504 Outdated Optimize Dep`.

### Echte ioBroker-Instanz lokal (dev-server)

`npm run dev-server setup` (einmalig) und danach `npm run dev-server watch` legen unter `.dev-server/default` eine
vollständige ioBroker-Installation mit dem Adapter an. Die Web-App läuft dann unter `http://127.0.0.1:8092`, die
Admin-Oberfläche unter `http://127.0.0.1:8081`. Ohne Startpasswort in den Instanz-Einstellungen wird eines erzeugt
und **einmalig** ins Log geschrieben:

```text
warn: time-tracker.0 administrator "admin" created with the start password "Zf-…" - change it at the first login
```

> **Windows 11 ohne `wmic`:** `dev-server watch` bricht dort mit `spawn wmic.exe ENOENT` ab — das Werkzeug liest die
> Plattengröße über `wmic`, und dieser Fehler ist in der Version 0.8.0 unbehandelt (`wmic` wurde von Microsoft
> entfernt). Controller und Adapter sind zu diesem Zeitpunkt schon installiert; es genügt, den Controller direkt zu
> starten:
>
> ```powershell
> cd .dev-server\default
> node node_modules\iobroker.js-controller\controller.js                     # läuft im Vordergrund
> node node_modules\iobroker.js-controller\iobroker.js start time-tracker.0  # zweite Konsole
> node node_modules\iobroker.js-controller\iobroker.js start admin.0          # optional: Admin-Oberfläche
> ```
>
> Beenden mit `iobroker.js stop time-tracker.0` beziehungsweise Strg+C im Controller-Fenster. Auf diesem Weg gibt es
> keinen Hot-Reload: nach Änderungen `npm run build` (Adapter) beziehungsweise `npm run build:pwa` (Web-App)
> ausführen und die Instanz einmal neu starten.

Damit Änderungen an der Web-App ohne Neuinstallation ankommen, kann der ausgelieferte `www`-Ordner auf den des
Repositories zeigen (der Adapter liest die Dateien bei jeder Anfrage von der Platte):

```powershell
cd .dev-server\default\node_modules\iobroker.time-tracker
cmd /c rmdir www                     # entfernt nur die Verknüpfung, nicht das Ziel
New-Item -ItemType Junction -Path www -Target <Repository>\www
```

> **Nur `www` verknüpfen, und Junctions immer mit `cmd /c rmdir` entfernen.** Zwei Erfahrungen aus dem Aufbau:
>
> - Für den Adaptercode (`build/`) ist eine Junction **nicht** geeignet: der js-controller findet den Adapter dann
>   nicht mehr und beendet ihn mit `CANNOT_FIND_ADAPTER_DIR`.
> - `Remove-Item -Recurse` auf eine Junction löscht in PowerShell auch den **Inhalt des Ziels**. Mit
>   `cmd /c rmdir <Pfad>` verschwindet nur die Verknüpfung.
>
> Nach Adapteränderungen daher neu bauen und die Dateien kopieren:
>
> ```powershell
> npm run build
> Copy-Item build .dev-server\default\node_modules\iobroker.time-tracker\build -Recurse -Force
> ```

`.dev-server/` und `iobroker.*.tgz` sind bereits in `.gitignore` abgedeckt.

> **Beim Testen auf den Port achten:** `npm run test:integration` startet eine eigene ioBroker-Instanz und bindet
> denselben Port wie der Adapter (Standard `8092`). Läuft die eigene Instanz dabei, kann die Testinstanz ihre API
> nicht öffnen und die Prüfung scheitert mit „starts the HTTP API on the configured port“ — die eigene Instanz also
> vorher stoppen (`iobroker.js stop time-tracker.0`).
