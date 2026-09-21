# Erste Schritte und Erststart-Test

Diese Anleitung führt einmal durch die Installation bis zum ersten Stempel. Sie ist bewusst knapp und nennt an
jeder Stelle, woran man erkennt, dass der Schritt geklappt hat. Der vollständige Abnahmetest steht in
`docs/testplan.md`.

## 1. Voraussetzungen

- ioBroker-Instanz mit js-controller (die CI prüft gegen den echten Controller), Node ≥ 22
- ein freier TCP-Port (Standard `8092`)
- für die **installierbare PWA** und den Service Worker: HTTPS über einen Reverse Proxy (nginx/caddy) — siehe
  README, Abschnitt „Reverse proxy and HTTPS". Für den reinen Funktionstest genügt `http://<host>:8092`
- optional: Tablet/Handy für das Kiosk-Terminal, NFC-Tag für T14/T15

## 2. Installieren

Der Adapter liegt auf **npm** — der normale Weg ist die Installation aus dem ioBroker-Admin bzw. von npm. **Die
Instanz `time-tracker.0` wird dabei automatisch angelegt.**

- **Admin:** Reiter *Adapter* → das Symbol **„Installieren aus eigener URL“** → `iobroker.time-tracker` → *Installieren*.
- **Kommandozeile:** `iobroker install iobroker.time-tracker` (legt die Instanz ebenfalls an — wer sie getrennt
  anlegen will: `iobroker add time-tracker`).

**Erfolgskontrolle:** im Log steht `web interface found at …/www`, `API listening on http://127.0.0.1:8092/api`
und `API routes: …`; der Zustand `time-tracker.0.info.connection` ist `true`.

> **Nur für Entwickler:** eine Installation **aus GitHub oder aus dem geklonten Ordner** funktioniert nicht ohne
> Bauen: `build/` und `www/` sind **nicht** im Repository (die Web-App wird vorgebaut), ohne sie meldet ioBroker
> `cannot find start file!`. Wer das braucht, baut einmal — sonst einfach npm nehmen:
>
> ```bash
> npm ci
> npm run install:pwa    # Abhängigkeiten der Web-App
> npm run build:pwa      # Web-App → www/
> npm run build          # Adapter   → build/
> iobroker install .     # Ordner installieren (Instanz wird automatisch angelegt)
> ```
>
> Für die Entwicklung ist der **Dev-Server** des Projekts bequemer: `npm run dev-server`.

## 3. Instanz einstellen

In den Instanz-Einstellungen (Reiter *General*, *Security*, *Migration and backup*):

1. **Session secret** und **Badge link secret (HMAC)** setzen (beide werden verschlüsselt gespeichert; ohne
   HMAC-Secret sind signierte Badge-Links abgeschaltet). Bleibt das **Session secret** leer, erzeugt der Adapter
   beim ersten Start eines und legt es als Datei `session-secret` neben der Datenbank ab — damit überleben Sitzungen
   und CSRF-Tokens einen Neustart. Ein Eintrag im Feld hat immer Vorrang und erlaubt dir die bewusste Rotation.
2. Port/Bind prüfen (`127.0.0.1` = nur lokal, `0.0.0.0` = LAN — bewusst opt-in).
3. Zeitzone (`Europe/Berlin`), Standardsprache und Feiertagsland kontrollieren.
4. **Startpasswort des Erst-Administrators** setzen — oder leer lassen: dann wird ein Zufallspasswort **einmalig
   ins Log** geschrieben (`info.lastError` bleibt leer, wenn nichts schiefging).
5. Optional: **Enable kiosk terminal** und die Aufbewahrung der Backups.
6. Bei Betrieb hinter einem Proxy: **Trust the reverse proxy** einschalten (sonst werden `X-Forwarded-*`
   ignoriert).

## 4. Erster Login

Web-App öffnen (`http://<host>:8092/`), mit dem Admin-Login und dem Startpasswort anmelden. Der Server verlangt
sofort einen **Passwortwechsel** — die PWA zeigt dafür einen eigenen Bildschirm. Danach:

1. **Verwaltung → Benutzer**: Mitarbeiter anlegen (Login, Name, Passwort, Rolle), jedem eine **Badge-PIN**
   (4–8 Ziffern) setzen, wenn er am Kiosk per PIN stempeln soll.
   Mit **Foto** hinterlegt man ein Bild des Mitarbeiters (PNG/JPEG/WEBP/GIF bis 256 KB). Es erscheint auf den
   Kacheln des Anwesenheits-Bildschirms und am Kiosk; ohne Bild zeigt die Oberfläche den Platzhalter.
2. **Verwaltung → Terminals**: Terminal anlegen (PIN-Pflicht an), **Geräte-Token kopieren** und die angezeigte
   Adresse `…/terminal?token=…` am Tablet öffnen — das war der Kiosk-Schritt aus T4. Ohne **PIN-Pflicht** stempelt
   das Gerät ohne PIN: Ausweis scannen oder den Namen auswählen genügt. Eine falsche PIN wird trotzdem abgelehnt.
3. **Verwaltung → Einstellungen**: `report_font_path` auf eine Unicode-`.ttf`/`.otf` setzen, wenn Ausweise in
   **ru**, **uk** oder **zh-cn** gedruckt werden sollen (sonst lehnt der Export mit `report_font_missing` ab).
4. **Verwaltung → Zeitkorrektur**: die Stempel eines Mitarbeiters ansehen und geradeziehen — Mitarbeiter und Monat
   wählen, dann eine Zeit ändern (Stift-Symbol), einen Stempel löschen (Papierkorb) oder fehlende **nachtragen**
   („Stempel oder Tag nachtragen“: Datum, Kommen, Gehen; „Gehen“ leer lassen, wenn nur ein Stempel fehlt). Die
   **Begründung** oben im Reiter landet im Protokoll (Audit-Log), und nachgetragene Stempel sind mit der Herkunft
   „durch die Verwaltung nachgetragen“ gekennzeichnet — so bleibt jede Korrektur nachvollziehbar.

## 5. Erste Stempel und Prüfungen

- In der Web-App stempeln (Kommen/Gehen), Monatsansicht öffnen, Bericht als XLS und PDF laden.
- Laststichprobe (T17) gegen die laufende Instanz:

  ```bash
  npm run load-smoke -- --login <Benutzer> --password '<Passwort>' --count 5
  ```

  Erwartet: `OK: kein Fehler, alle Stempel vorhanden, Antwortzeiten im Sekundenbereich.` (Code 0).
- Erststart-Strecke automatisch durchprüfen (Anmeldung, Pflicht-Passwortwechsel, Mitarbeiter samt Badge-PIN,
  Stempeln, Tages- und Monatsauswertung, XLS- und PDF-Bericht, Sicherung):

  ```bash
  npm run first-run -- --login admin --password '<Startpasswort>'
  ```

  Erwartet: `Ergebnis: <alle>/<alle> Schritte erfüllt` und `OK: Erststart-Strecke ohne Fehler.` (Code 0). Das Skript
  legt den Mitarbeiter `pruefung` samt Stempeln und PIN an — für saubere Daten danach in der Verwaltung löschen.
  Was es bewusst auslässt (weil es eine Einstellung braucht), sagt es am Ende selbst: Kiosk-Terminal und
  Ausweis-Link prüft der Testplan von Hand.
- **Anwesenheit aus ioBroker steuern:** jeder Mitarbeiter hat den schreibbaren State
  `time-tracker.0.users.<id>.present` (Rolle `switch`). `true` stempelt ein (bezahlte Arbeitszeit läuft), `false`
  stempelt aus — gedacht für einen Fingerabdruck-Reader, eine RFID-Brücke, ein Dashboard oder ein Skript. Der
  Schreibvorgang ist idempotent (ein zweites `true` erzeugt keinen zweiten Stempel) und erscheint als normaler
  Stempel mit der Notiz `state.present`. `users.<id>.hasOpenEntry` bleibt die reine Anzeige dazu.
- **Befehle aus ioBroker (Skript, Blockly, Dashboard):** unter `time-tracker.0.commands.*` liegen sechs schreibbare
  States — damit steuerst du den Adapter ohne Web-Oberfläche. Was du schreibst, steht danach im Adapter-Log (und im
  Audit-Log als *System*):

  ```js
  setState("time-tracker.0.commands.punchUserId", 3);          // Ziel-Mitarbeiter (0 = der einzige)
  setState("time-tracker.0.commands.punch", true);             // ein- oder ausstempeln
  setState("time-tracker.0.commands.quickPunch", true);        // mit Schnellrundung
  setState("time-tracker.0.commands.recalc", "2026-08");       // Monat, oder "2026" fürs Jahr
  setState("time-tracker.0.commands.closeMonth", "2026-08");   // Monatsabschluss braucht JJJJ-MM
  setState("time-tracker.0.commands.backup", true);            // Sicherung jetzt schreiben
  ```

  **Die beiden Stempel-Buttons reagieren nur auf `true`** (jeder andere Wert wird ignoriert), und der Adapter setzt
  sie sofort wieder auf `false` — also **nie** `false` schreiben, um auszustempeln: `punch` nimmt automatisch die
  passende Richtung.

  **Welcher Mitarbeiter?** Die Stempelbefehle nehmen den Mitarbeiter, der in `commands.punchUserId` steht (der
  Adapter spiegelt die aktuelle Wahl dort hinein, `0` = „der einzige Mitarbeiter“). Gibt es mehrere Mitarbeiter und
  keine Wahl, verweigert der Befehl und sagt es im Log. Die Mitarbeiter-Id siehst du in der Instanz unter
  `users.<id>` (die Zahl hinter `users.`).

  Ohne Ziel-Mitarbeiter geht es auch **pro Mitarbeiter**: `time-tracker.0.users.<id>.present` (siehe oben) oder eine
  Nachricht per `sendTo("time-tracker.0", "punch", { user: "anna" }, antwort => …)`.

  Fehler (falscher Zeitraum, unbekannter oder deaktivierter Mitarbeiter) erscheinen als **Warnung im Log** — die
  Instanz läuft weiter.
- **Dublettenschutz (wichtig für Lesegeräte):** zwei Stempel innerhalb von **30 Sekunden** gelten als Doppelscan —
  der zweite wird nicht gezählt. Ein Fingerabdruck- oder RFID-Leser, der mehrfach auslöst, ist dadurch harmlos; für
  „sofort wieder ausstempeln“ muss der Abstand größer als 30 Sekunden sein. Das gilt für alle Wege (Web-App, Kiosk,
  Badge, ioBroker-Objekt).
- Offline-Probe: WLAN trennen, stempeln, wieder verbinden — der Stempel wird nachgereicht (`Sync`-Ansicht).
- Verwaltung → **Backups**: „create now" drücken; der Zustand `time-tracker.0.info.lastBackup` springt an.
- Sicherung und Rücksicherung einmal durchspielen: Instanz stoppen, Sicherungsdatei **außerhalb** des
  Adapterverzeichnisses kopieren, Instanz starten.

## 6. Keine Datenübernahme

Der Adapter liest **keine** Daten eines anderen Zeiterfassungssystems ein. Mitarbeiter, Stempel und Abwesenheiten
werden in der Oberfläche angelegt:

- **Mitarbeiter:** Verwaltung → Benutzer (Login, Name, Passwort, Rolle, optional Foto, Badge-PIN)
- **Vergangene Zeiten:** Verwaltung → **Zeitkorrektur** — dort lassen sich Stempel ändern, löschen und nachtragen,
  auch ganze vergangene Tage (Datum, Kommen, Gehen). Die **Begründung** (Feld über der Liste bzw. im Dialog) landet
  im Protokoll des Adapters (Audit-Log); über das Symbol neben jedem Stempel ist der **Verlauf** (wer, wann, warum)
  jederzeit einsehbar.

## 7. Wenn etwas klemmt

| Symptom | Erste Anlaufstelle |
| --- | --- |
| Web-App nicht erreichbar | Log `API listening on …`, Zustand `info.connection` |
| PWA lässt sich nicht installieren | HTTPS nötig (Reverse Proxy), Service-Worker-Scope im Log prüfen |
| Bericht fehlt/leer in `ru`/`uk`/`zh-cn` | `report_font_path` setzen (Verwaltung → Einstellungen) |
| Kiosk nimmt keine PIN | Zustand `info.lastError`, Kontosperre nach 5 Fehlversuchen (15 Minuten) |
| Alles unklar | `npm run test:ts`, `npm run test:package`, `npm run test:integration` lokal ausführen |

Die Abnahmekriterien und das Protokollblatt stehen in `docs/testplan.md` (T1–T17); der jeweilige Stand der
Restarbeiten in `PROJECT_PROMPT.md`.
