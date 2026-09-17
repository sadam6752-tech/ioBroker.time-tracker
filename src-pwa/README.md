# src-pwa/ – Progressive Web App

React 18 + MUI 5 + Vite + React Query, Service Worker über Workbox, installierbar auf Smartphone
und Desktop, offlinefähiges Stempeln mit Sync-Warteschlange. Der Build wird nach `www/` geschrieben und vom
Adapter auf dem konfigurierten Port ausgeliefert (siehe [`../src/lib/web/static.ts`](../src/lib/web/static.ts)).

**Schnittstelle zum Adapter**

| Was               | Wo                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Statische Dateien | `www/` im Paketwurzelverzeichnis; der Adapter liefert sie ab Auslieferungswurzel `/` aus                                         |
| API               | immer unter dem Präfix `/api` (z. B. `POST /api/auth/login`), Session im Header `x-session-token`, CSRF im Header `x-csrf-token` |
| Client-Routing    | unbekannte Pfade liefern `index.html` (Fallback im Adapter), daher **kein** `HashRouter` nötig                                   |
| Basis-URL         | relativ halten (`base: "./"`), damit die App auch als Web-Extension unter einem Unterpfad läuft                                  |

**Befehle** (im Adapter-Wurzelverzeichnis)

```bash
npm run install:pwa     # Abhängigkeiten der PWA (eigenes node_modules)
npm run build:pwa       # Typprüfung + Vite-Build nach www/
npm run dev:pwa         # Entwicklungsserver auf :5173, /api wird auf die Instanz (127.0.0.1:8092) geleitet
npm run lint:pwa        # ESLint mit denselben Regeln wie der Adapter
```

Ohne `www/` läuft der Adapter weiter und bietet nur die API an; die Tests der Auslieferung
(`src/lib/web/pwa.test.ts`) werden dann übersprungen.

**Aufbau**

| Pfad                      | Inhalt                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/api/client.ts`       | REST-Client: Session in `localStorage`, CSRF-Header, Problem-Dokumente als `ApiError` mit stabilem Code |
| `src/api/types.ts`        | Antwortformen der API (Spiegel des JSON: Zeiten in UTC-Sekunden, Dauer in Minuten)                      |
| `src/offline/queue.ts`    | Warteschlange im `localStorage`, jeder Stempel mit UUID als `idempotencyKey`                            |
| `src/offline/useSync.tsx` | sendet die Warteschlange über `POST /api/entries/sync`, reagiert auf `online`/`offline`                 |
| `src/state/session.tsx`   | Anmeldung, Berechtigungen (nur Anzeige – entschieden wird serverseitig), Sprache des Benutzers          |
| `src/screens/`            | Login, Dashboard (Stempeln), Monat, Berichte, Abwesenheiten, Abgleich, Profil                           |
| `src/i18n/`               | 11 Sprachdateien; **Basis ist `en.json`**, neue Texte nur dort ergänzen und danach `npm run translate`  |

**Offline-Verhalten:** Der Stempeldruck schreibt zuerst in die lokale Warteschlange und sendet sofort; ohne Netz
bleibt der Eintrag liegen und wird beim nächsten `online`-Ereignis (oder über den Knopf im Abgleich-Bildschirm)
gesendet. Der Server erkennt Wiederholungen am `idempotencyKey`, Konflikte landen in
`GET /api/entries/conflicts` und werden dort entschieden.

**Clean Room:** kein Code und keine Bezeichner aus anderen Projekten (siehe
[`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

Verbindliche Details (Endpunkte, Feldnamen, Fehlercodes) stehen in der internen Spezifikation, die
außerhalb dieses Repositories liegt und nicht veröffentlicht wird.
