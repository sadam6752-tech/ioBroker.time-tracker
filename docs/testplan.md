# Abnahme- und Testplan (erste reale Tests)

Dieses Dokument ist die Arbeitsanleitung für die **ersten Tests auf einer echten ioBroker-Installation**.
Es beschreibt Voraussetzungen, Testdaten, die Testfälle T1–T18 mit Erwartung und die Abnahmekriterien.
Die öffentliche `README.md` bleibt englisch (Vorgabe des Adapter-Checkers) — dieses Betriebsdokument ist
bewusst deutsch, wie `docs/adapter-check.md`.

## 1. Ziel

Nachweisen, dass der Adapter im produktiven Betrieb das tut, was die Spezifikation (Abschnitte 3, 4, 9)
verlangt: stempeln (online, offline, Terminal), rechnen (Soll, Pausen, Saldo, Ferien, Feiertage),
berichten (Excel, PDF), Rechte serverseitig durchsetzen, sichern und wiederherstellen.

**Nicht** Teil dieser Runde: der Import von Altdaten (Phase 9) — dafür gibt es Abschnitt 8.

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
4. Ein **Terminal** anlegen (Name „Werkstatt"), PIN vergeben.
   Danach die Kiosk-Ansicht auf dem Gerät öffnen: `http://<Adapter-Host>:<Port>/terminal?token=<Gerätetoken>`
   (den Token zeigt die Anlage **einmalig**; das Gerät merkt ihn sich für den nächsten Start).
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
| T18 | Legacy-Import | Kommando `commands.import` setzen: (a) `{"baseDir":"…/smalltime","mode":"dry-run"}`, (b) danach mit `"mode":"commit"`, (c) denselben Commit ein zweites Mal (mit `"resetImport":true`), (d) Report in `info.lastImport` und in `import_runs` prüfen | (a) Bericht mit Zählern und Warnungen, aber **keine** neuen Zeilen in `time_entries`/`absences`/`payouts`; (b) Import erfolgreich, `status` nicht `mismatch`, Monatswerte reproduzieren `Timetable/<Jahr>` auf ±0,01 h; (c) keine zusätzlichen Zeilen (Idempotenz); (d) `info.lastImport` enthält den Bericht, `import_runs` je Lauf eine Zeile mit Modus, Status, Zählern und Warnungen |

Ein Hinweis zu T18: Der Import wird gegen das synthetische Fixture (`fixtures/smalltime`) geprüft. Für die Abnahme
am realen Bestand ist eine Kopie des produktiven `Data`-Verzeichnisses nötig (Abschnitt 2.9.11) — erst damit sind
die heute offenen Feldbedeutungen (Zeitzone der Stempel, Felder 2/4 der Monatsdatei, Feld 1 in `A<Jahr>`)
verbindlich zu bestätigen.

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
| **Import der Altdaten** (Phase 9) | Der Test läuft mit frischen Testdaten. Altdaten können noch **nicht** übernommen werden. |
| Statistik-Ansicht in der Web-App | Die API `/reports/statistics` liefert Zahlen, die Oberfläche zeigt sie noch nicht. |
| Adminbereich-Ausbau | Rollenwechsel pro Zeile, Terminal-Verwaltung und Einstellungen laufen über ioBroker-Objekte bzw. die API. |
| 9 Sprachen maschinell übersetzt | Kernbegriffe (Stempeln, PIN) sind von Hand korrigiert; Fachjargon beim Test notieren. |
| Keine E2E-Tests (Playwright) | Die Prüfung erfolgt manuell nach diesem Plan; die Automatik deckt Unit-, Paket- und Integrationstests ab (inklusive Kiosk-Terminal-Vertrag `/terminal/status`, `403 kiosk_disabled` und `/terminal`-Deep-Link in `test/integration.js`). |
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


