# Erste Schritte und Erststart-Test

Diese Anleitung führt einmal durch die Installation bis zum ersten Stempel. Sie ist bewusst knapp und nennt an
jeder Stelle, woran man erkennt, dass der Schritt geklappt hat. Der vollständige Abnahmetest steht in
`docs/testplan.md`.

## 1. Voraussetzungen

- ioBroker-Instanz mit js-controller (die CI prüft gegen den echten Controller), Node ≥ 22
- ein freier TCP-Port (Standard `8082`)
- für die **installierbare PWA** und den Service Worker: HTTPS über einen Reverse Proxy (nginx/caddy) — siehe
  README, Abschnitt „Reverse proxy and HTTPS". Für den reinen Funktionstest genügt `http://<host>:8082`
- optional: Tablet/Handy für das Kiosk-Terminal, NFC-Tag für T14/T15

## 2. Bauen und installieren

```bash
npm install
npm run build          # Adapter (build/)
npm run build:pwa      # Web-App (www/)
npm pack               # erzeugt iobroker.zeiterfassung-0.0.1.tgz
```

Danach das Paket in die ioBroker-Installation bringen:

```bash
iobroker install ./iobroker.zeiterfassung-0.0.1.tgz
iobroker add zeiterfassung        # legt die Instanz zeiterfassung.0 an
```

**Erfolgskontrolle:** im Log steht `web interface found at …/www`, `API listening on http://127.0.0.1:8082/api`
und `API routes: …`; der Zustand `zeiterfassung.0.info.connection` ist `true`.

## 3. Instanz einstellen

In den Instanz-Einstellungen (Reiter *General*, *Security*, *Migration and backup*):

1. **Session secret** und **Badge link secret (HMAC)** setzen (beide werden verschlüsselt gespeichert; ohne
   HMAC-Secret sind signierte Badge-Links abgeschaltet).
2. Port/Bind prüfen (`127.0.0.1` = nur lokal, `0.0.0.0` = LAN — bewusst opt-in).
3. Zeitzone (`Europe/Berlin`), Standardsprache und Feiertagsland kontrollieren.
4. **Startpasswort des Erst-Administrators** setzen — oder leer lassen: dann wird ein Zufallspasswort **einmalig
   ins Log** geschrieben (`info.lastError` bleibt leer, wenn nichts schiefging).
5. Optional: **Enable kiosk terminal**, **Legacy data directory for import**, Aufbewahrung der Backups.
6. Bei Betrieb hinter einem Proxy: **Trust the reverse proxy** einschalten (sonst werden `X-Forwarded-*`
   ignoriert).

## 4. Erster Login

Web-App öffnen (`http://<host>:8082/`), mit dem Admin-Login und dem Startpasswort anmelden. Der Server verlangt
sofort einen **Passwortwechsel** — die PWA zeigt dafür einen eigenen Bildschirm. Danach:

1. **Verwaltung → Benutzer**: Mitarbeiter anlegen (Login, Name, Passwort, Rolle), jedem eine **Badge-PIN**
   (4–8 Ziffern) setzen, wenn er am Kiosk per PIN stempeln soll.
2. **Verwaltung → Terminals**: Terminal anlegen (PIN-Pflicht an), **Geräte-Token kopieren** und die angezeigte
   Adresse `…/terminal?token=…` am Tablet öffnen — das war der Kiosk-Schritt aus T4.
3. **Verwaltung → Einstellungen**: `report_font_path` auf eine Unicode-`.ttf`/`.otf` setzen, wenn Ausweise in
   **ru**, **uk** oder **zh-cn** gedruckt werden sollen (sonst lehnt der Export mit `report_font_missing` ab).

## 5. Erste Stempel und Prüfungen

- In der Web-App stempeln (Kommen/Gehen), Monatsansicht öffnen, Bericht als XLS und PDF laden.
- Laststichprobe (T17) gegen die laufende Instanz:

  ```bash
  npm run load-smoke -- --login <Benutzer> --password '<Passwort>' --count 5
  ```

  Erwartet: `OK: kein Fehler, alle Stempel vorhanden, Antwortzeiten im Sekundenbereich.` (Code 0).
- Offline-Probe: WLAN trennen, stempeln, wieder verbinden — der Stempel wird nachgereicht (`Sync`-Ansicht).
- Verwaltung → **Backups**: „create now" drücken; der Zustand `zeiterfassung.0.info.lastBackup` springt an.
- Sicherung und Rücksicherung einmal durchspielen: Instanz stoppen, Sicherungsdatei **außerhalb** des
  Adapterverzeichnisses kopieren, Instanz starten.

## 6. Altdaten importieren (T18)

1. **Verwaltung → Import**: Altdaten-Verzeichnis eintragen (nur lesend!), Modus **Probelauf**, starten. Der
   Bericht zeigt Zähler und Warnungen — es wird **nichts** geschrieben.
2. Erst wenn der Bericht plausibel ist, auf **Import** umschalten und starten. Der Lauf landet in
   `import_runs` und in `info.lastImport`; die Monatswerte müssen `Timetable/<Jahr>` auf ±0,01 h treffen.
3. Wiederholung derselben Daten nur mit **„Bereits importierten Datenbestand wiederholen"** (Idempotenz-Test).

## 7. Wenn etwas klemmt

| Symptom | Erste Anlaufstelle |
| --- | --- |
| Web-App nicht erreichbar | Log `API listening on …`, Zustand `info.connection` |
| PWA lässt sich nicht installieren | HTTPS nötig (Reverse Proxy), Service-Worker-Scope im Log prüfen |
| Bericht fehlt/leer in `ru`/`uk`/`zh-cn` | `report_font_path` setzen (Verwaltung → Einstellungen) |
| Kiosk nimmt keine PIN | Zustand `info.lastError`, Kontosperre nach 5 Fehlversuchen (15 Minuten) |
| Import bricht ab | Bericht in `info.lastImport` und Zeile in `import_runs` lesen |
| Alles unklar | `npm run test:ts`, `npm run test:package`, `npm run test:integration` lokal ausführen |

Die Abnahmekriterien und das Protokollblatt stehen in `docs/testplan.md` (T1–T18); der jeweilige Stand der
Restarbeiten in `PROJECT_PROMPT.md`.
