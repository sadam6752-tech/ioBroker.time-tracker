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

| Punkt | Anforderung |
| --- | --- |
| ioBroker | js-controller ≥ 6.0.11, admin ≥ 7.6.20 |
| Node.js | ≥ 22 (lokal geprüft mit 22.22) |
| Ports | Adapter-Port frei (Standard `8082`), `127.0.0.1` genügt für den Test |
| HTTPS | für die Installation der PWA (Service Worker) **erforderlich**; im Test ein Reverse-Proxy (nginx/caddy) mit einem selbst ausgestellten Zertifikat oder ein Gerät im gleichen Netz mit gültigem Zertifikat |
| Browser | Chrome/Edge (Android) oder Safari (iOS) für die Installation; Desktop-Browser für die API-Sicht |
| Terminal-Gerät | Tablet/Handy im Kiosk-Modus (Bildschirm bleibt an) **oder** ein Browser-Tab |
| Zeit | eine Stunde für den Durchlauf; T3 (offline) braucht Ruhe, um den Abgleich zu beobachten |

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
iobroker url https://github.com/sadam6752-tech/ioBroker.zeiterfassung
```

Nach dem Start: Instanz öffnen, **Port** und **Bind-Adresse** prüfen, `report_font_path` nur setzen, wenn
PDF-Berichte in `ru`, `uk` oder `zh-cn` gebraucht werden (sonst antwortet der Bericht mit `422
report_font_missing` — das ist erwartetes Verhalten, kein Fehler).

## 4. Testdaten

1. Anmeldung im Admin-Formular: das Konto `admin` (bzw. der eingestellte Login) mit dem Startpasswort aus der
   Instanzeinstellung — ist sie leer, steht ein zufälliges Startpasswort **einmalig im Adapter-Log** —
   **Passwort sofort ändern**
   (der Adapter verlangt das beim ersten Login).
2. In der Web-App unter **Verwaltung → Mitarbeiter** anlegen:
   - `anna` (Rolle *Mitarbeiter*), Passwort nach Policy (≥ 8 Zeichen, Groß-/Kleinbuchstaben, Ziffern)
   - `chef` (Rolle *Manager*, falls Abnahme fremder Monate geprüft werden soll)
   - für `anna` einen **Badge-PIN** (4–8 Ziffern) setzen → für T4
3. Arbeitsprofil von `anna` prüfen: Wochenstunden, Arbeitstage, Pausenstaffel, Überstundenmodell.
4. Ein **Terminal** anlegen — in der Web-App unter **Verwaltung → Terminals** (oder per `POST /api/terminals`),
   PIN-Pflicht eingeschaltet lassen.
   Danach die Kiosk-Ansicht auf dem Gerät öffnen: die Verwaltung zeigt dafür die fertige Adresse
   `http://<Adapter-Host>:<Port>/terminal?token=<Gerätetoken>` an (den Token zeigt sie **einmalig**; das Gerät
   merkt ihn sich für den nächsten Start).
5. Feiertage für das Testjahr erzeugen (Einstellung *Feiertagsland*), Abwesenheitsart *Ferien* prüfen.

## 5. Testfälle

| Nr | Titel | Schritte | Erwartung |
| --- | --- | --- | --- |
| T1 | Anmeldung und Rechte | als `admin` anmelden, dann als `anna`; `GET /api/users` einmal mit jedem Token aufrufen (Browser-Konsole oder curl) | `admin`: 200 mit Liste; `anna`: **403** `permission_denied` — die API entscheidet, nicht die Oberfläche |
| T2 | Kommen/Gehen online | `anna` anmelden, „Kommen" stempeln, kurz warten, „Gehen" | Bestätigung mit Uhrzeit; Tageswerte (Arbeitszeit/Soll/Saldo) aktualisieren sich ohne Neuladen; Ereignis kommt sofort an |
| T3 | Offline-Stempeln + Abgleich | im Browser offline gehen, zweimal stempeln (Kommen, Gehen), wieder online gehen | Warteschlange zeigt 2 Stempel, Abgleich lädt hoch, **keine Duplikate** (gleiche UUID), Konfliktliste bleibt leer |
| T4 | Kiosk-Terminal | Terminal öffnen, Badge-PIN von `anna` eingeben, stempeln | Stempel mit Quelle `terminal`, in der Monatsansicht sichtbar; Konto ohne Stempelrecht wird mit 403 abgewiesen |
| T5 | RFID-Tag | Tag anlegen, `POST /rfid/scan` mit gültigem Token/TTL (curl) | 201 + Stempel; abgelaufener TTL → 401/403 |
| T6 | Monatsansicht | Monat mit Feiertag, Abwesenheit und offenem Stempel öffnen | Tagessummen stimmen mit der Liste überein, Feiertag/Abwesenheit ausgezeichnet, offener Stempel markiert, Saldo plausibel |
| T7 | Berichte | Excel und PDF für Monat **und** Jahr erzeugen | beide laden, Dateiname mit Zeitraum, Zahlen identisch zur Monatsansicht; ohne Unicode-Schrift in `ru`/`uk`/`zh-cn` → **422 `report_font_missing`** mit Hinweis auf `report_font_path` |
| T8 | Abwesenheiten | Antrag für `anna` stellen (z. B. Ferien, halber Tag), Status ändern | Antrag in Liste und Monatsansicht, Faktor wirkt auf Soll/Ist, Statuswechsel im Audit |
| T9 | Monatsabschluss | Kommando `commands.closeMonth` in ioBroker setzen | Abschluss-States ändern sich, Ereignis im Live-Stream, zweiter Abschluss läuft ohne Fehler (idempotent) |
| T10 | Sicherung und Wiederherstellung | „Sicherung jetzt erstellen" (oder Kommando), Datei im Datenverzeichnis prüfen, Adapter neu starten | Sicherung mit Zeitstempel, Rotation hält die eingestellte Anzahl, Neustart ohne Datenverlust |
| T11 | Live-Ereignisse | PWA in zwei Browsern öffnen (`admin` + `anna`), in einem stempeln | der andere Browser aktualisiert sofort; ein Mitarbeiter sieht **keine** fremden Ereignisse |
| T12 | Korrektur und Audit | Eintrag in der Monatsansicht ändern/löschen (Recht vorausgesetzt) | Änderung erscheint im Audit mit Feldänderungen und Begründung |
| T13 | Sicherheit | (a) 20× falsches Passwort; (b) Anfrage ohne CSRF-Token; (c) `../../etc/passwd` im Pfad; (d) Anfrage ohne Token | (a) **423** Sperre, läuft nach Ablauf aus; (b) 403; (c) 400/404; (d) 401 |
| T14 | ioBroker-States und Befehle | States unter `zeiterfassung.0.*` prüfen, `commands.punch` setzen | Werte plausibel, `info.connection` true, Button-States `read: false`, gelöschter Benutzer hinterlässt keine States |
| T15 | Sprachen | Oberfläche auf `de`, dann `ru`, dann `zh-cn`; Berichte in derselben Sprache | keine abgeschnittenen Texte, Datum/Zahlen lokal formatiert, Bericht in der Sprache des Nutzers |
| T16 | PWA-Installation | Adapter-URL über **HTTPS** öffnen, „Zum Startbildschirm hinzufügen", App starten, neu bauen und neu laden | App läuft im eigenen Fenster, Icon ist das Logo, Update ohne hängenden Alt-Cache |
| T17 | Last (Stichprobe) | `npm run load-smoke -- --login <Benutzer> --password '<Passwort>'` (Standard: 5 Stempel parallel; `--count 10 --base http://…` möglich, Passwort alternativ in `ZT_PASSWORD`) | keine Fehler, alle 5 Stempel vorhanden, Antwortzeiten im Sekundenbereich — das Skript prüft beides selbst und endet nur dann mit Code 0 |


## 6. Abnahmekriterien

- **T1–T13 sind grün.** T14–T17 mindestens je einmal erfolgreich.
- Die Wiederherstellung aus der Sicherung (T10) ist nachgewiesen: Datei kopieren, Adapter neu starten, Daten sind da.
- Jede Abweichung ist protokolliert (Nummer, Beobachtung, Bewertung) und entweder behoben oder bewusst als
  offener Punkt übernommen.

## 7. Protokoll (beim Test ausfüllen)

| Nr | Datum | Tester | Ergebnis (ok / Abweichung) | Beobachtung |
| --- | --- | --- | --- | --- |
| T1 |  |  |  |  |
| T2 |  |  |  |  |
| T3 |  |  |  |  |
| T4 |  |  |  |  |
| T5 |  |  |  |  |
| T6 |  |  |  |  |
| T7 |  |  |  |  |
| T8 |  |  |  |  |
| T9 |  |  |  |  |
| T10 |  |  |  |  |
| T11 |  |  |  |  |
| T12 |  |  |  |  |
| T13 |  |  |  |  |
| T14 |  |  |  |  |
| T15 |  |  |  |  |
| T16 |  |  |  |  |
| T17 |  |  |  |  |

## 8. Bewusst nicht im Umfang dieser Runde

| Lücke | Auswirkung beim Test |
| --- | --- |
| Adminbereich-Ausbau | Nur noch die **NFC-Bedienung** fehlt in der PWA; Rollenwechsel pro Zeile, Einstellungen, Tags und Feiertage sind seit der letzten Runde vorhanden. Statistik und Ausweise sind über die API erreichbar. |
| 9 Sprachen maschinell übersetzt | Kernbegriffe (Stempeln, PIN) sind von Hand korrigiert; Fachjargon beim Test notieren. |
| Keine E2E-Tests (Playwright) | **Vorhanden** (`npm run e2e`, `e2e/server.mjs` startet die echte API + gebaute PWA): **12 Tests, alle grün** (Login, Sitzung über Cookie, Statistik, Kiosk- und Anwesenheits-Token, Ausweis-Link, Branding, Zeitkorrektur, Anwesenheits-Kacheln, Benutzer und Terminal). Der frühere Render-Fehler nach dem Login (React #130) ist behoben — die Symbole kommen über den Alias in `vite.config.ts` als echtes ES-Modul an — es gibt **keine** zurückgestellten Fälle mehr. T1–T13 bleiben Handarbeit, weil sie Rechte, Offline-Betrieb und echte Geräte prüfen. |
| PDF-Schriften (`ru`, `uk`, `zh-cn`) | Braucht eine Unicode-Schriftdatei über `report_font_path`; ohne sie kommt eine klare Fehlermeldung. |

## 9. Rückfall-Szenario

- Der Adapter schreibt **nur** in sein Datenverzeichnis (SQLite-Datei) und in seine eigenen ioBroker-Objekte.
  Eine bestehende Altanwendung bleibt unberührt und kann weiterlaufen.
- Rückfall: `iobroker stop zeiterfassung`, Datenbankdatei sichern, Altanwendung weiter betreiben.
- Vor jedem Testlauf eine Sicherung anlegen (T10) und die Datei **außerhalb** des Adapterverzeichnisses kopieren.

## 10. Ergebnis und nächste Schritte (nach dem Test)

- Offene Abweichungen als Liste in `PROJECT_PROMPT.md` (Abschnitt 13) ergänzen.
- Erst danach Version taggen (`npm run release -- patch|minor`) — der Deploy-Job veröffentlicht dann über
  npm (trusted publishing vorausgesetzt) und legt das GitHub-Release an.

## 11. Entwicklungshinweise (Web-Oberfläche)

**Browser-Tests** (`npm run e2e`, Ordner `e2e/`): Sie starten `e2e/server.mjs` — das ist die echte API auf einer
In-Memory-Datenbank mit den gebauten Web-Dateien aus `www/`. Kein ioBroker nötig, keine Netzverbindung. Vor dem
Lauf **muss** `npm run build:pwa` gelaufen sein; die Tests blockieren den Service Worker, sonst würde Workbox die
alten Dateien aus dem Precache ausliefern.

> **Wichtig:** Erst den Exit-Code des Builds prüfen, dann das Testergebnis lesen. Ein abgebrochener Build (z. B.
> unbenutzter Import) hinterlässt `www/` unverändert — die Tests laufen dann still gegen den **alten** Stand.

**Web-App gegen den laufenden Adapter entwickeln** (schnelle Rückmeldung, React im Entwicklungsmodus mit lesbaren
Fehlern):

```bash
npm --prefix src-pwa run dev     # Port 5173, holt /api/… über den Proxy von 127.0.0.1:8082
```

Zwei Fallstricke, die dabei Zeit gekostet haben:

- Der Proxy in `src-pwa/vite.config.ts` muss als **berechneter** Schlüssel `[API_PREFIX]` stehen. Mit `API_PREFIX:`
  wird der wörtliche Text verglichen, der Proxy greift nie und jede API-Anfrage landet im App-Gerüst (Login läuft
  dann ins Leere, `GET /api/auth/me` liefert die HTML-Datei zurück).
- `@mui/icons-material` 5.x liefert jedes Symbol zweimal: als CommonJS (`Menu.js`) und als ES-Modul
  (`esm/Menu.js`). Ohne den Alias in `vite.config.ts` kann der Default-Import als Modulobjekt `{ default: … }`
  ankommen — React bricht dann mit „Element type is invalid … got: object“ (React #130) ab, und zwar erst nach
  dem Anmelden, weil die Symbole nur in der Shell und in den Masken vorkommen.

Nach einer Änderung an `vite.config.ts` den Zwischenspeicher `src-pwa/node_modules/.vite` löschen, sonst antwortet
der Dev-Server mit `504 Outdated Optimize Dep`.

### Echte ioBroker-Instanz lokal (dev-server)

`npm run dev-server setup` (einmalig) und danach `npm run dev-server watch` legen unter `.dev-server/default` eine
vollständige ioBroker-Installation mit dem Adapter an. Die Web-App läuft dann unter `http://127.0.0.1:8082`, die
Admin-Oberfläche unter `http://127.0.0.1:8081`. Ohne Startpasswort in den Instanz-Einstellungen wird eines erzeugt
und **einmalig** ins Log geschrieben:

```text
warn: zeiterfassung.0 administrator "admin" created with the start password "Zf-…" - change it at the first login
```

> **Windows 11 ohne `wmic`:** `dev-server watch` bricht dort mit `spawn wmic.exe ENOENT` ab — das Werkzeug liest die
> Plattengröße über `wmic`, und dieser Fehler ist in der Version 0.8.0 unbehandelt (`wmic` wurde von Microsoft
> entfernt). Controller und Adapter sind zu diesem Zeitpunkt schon installiert; es genügt, den Controller direkt zu
> starten:
>
> ```powershell
> cd .dev-server\default
> node node_modules\iobroker.js-controller\controller.js                     # läuft im Vordergrund
> node node_modules\iobroker.js-controller\iobroker.js start zeiterfassung.0  # zweite Konsole
> node node_modules\iobroker.js-controller\iobroker.js start admin.0          # optional: Admin-Oberfläche
> ```
>
> Beenden mit `iobroker.js stop zeiterfassung.0` beziehungsweise Strg+C im Controller-Fenster. Auf diesem Weg gibt es
> keinen Hot-Reload: nach Änderungen `npm run build` (Adapter) beziehungsweise `npm run build:pwa` (Web-App)
> ausführen und die Instanz einmal neu starten.

Damit Änderungen an der Web-App ohne Neuinstallation ankommen, kann der ausgelieferte `www`-Ordner auf den des
Repositories zeigen (der Adapter liest die Dateien bei jeder Anfrage von der Platte):

```powershell
cd .dev-server\default\node_modules\iobroker.zeiterfassung
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
> Copy-Item build .dev-server\default\node_modules\iobroker.zeiterfassung\build -Recurse -Force
> ```

`.dev-server/` und `iobroker.*.tgz` sind bereits in `.gitignore` abgedeckt.

> **Beim Testen auf den Port achten:** `npm run test:integration` startet eine eigene ioBroker-Instanz und bindet
> denselben Port wie der Adapter (Standard `8082`). Läuft die eigene Instanz dabei, kann die Testinstanz ihre API
> nicht öffnen und die Prüfung scheitert mit „starts the HTTP API on the configured port“ — die eigene Instanz also
> vorher stoppen (`iobroker.js stop zeiterfassung.0`).


