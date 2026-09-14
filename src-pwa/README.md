# src-pwa/ – Progressive Web App

React 18 + MUI 5 + Vite + React Query, Service Worker über Workbox, installierbar auf Smartphone
und Desktop, offlinefähiges Stempeln mit Sync-Warteschlange. Der Build wird nach `www/` übernommen
und vom Adapter auf dem konfigurierten Port ausgeliefert.

**Schnittstelle zum Adapter**

| Was | Wo |
|---|---|
| Statische Dateien | `www/` im Paketwurzelverzeichnis; der Adapter liefert sie ab Auslieferungswurzel `/` aus |
| API | immer unter dem Präfix `/api` (z. B. `POST /api/auth/login`), Session im Header `x-session-token`, CSRF im Header `x-csrf-token` |
| Client-Routing | unbekannte Pfade liefern `index.html` (Fallback im Adapter), daher **kein** `HashRouter` nötig |
| Basis-URL | relativ halten (`base: "./"`), damit die App auch als Web-Extension unter einem Unterpfad läuft |

**Geplant in Phase 5.** Wesentliche Vorgaben:

- **Offline-Stempeln:** UUID je Stempel, Batch-Sync über `POST /api/entries/sync`, sichtbarer
  Sync-Status und Konfliktauflösung.
- **Rollen/Rechte:** ausschließlich serverseitige Entscheidungen; die UI blendet nur aus, was das
  Backend ohnehin verbietet.
- **Zeiten:** Anzeige in der Benutzer-Zeitzone, Berechnung/Übergabe in UTC bzw. Minuten.
- **Screens:** Login, Dashboard (Stempeln), Monatskalender, Berichte/Exporte, Abwesenheiten,
  Profil, Adminbereich, Kiosk-/Terminal-Ansicht.
- **Clean Room:** kein Code/keine Bezeichner aus dem Legacy-Baum (siehe [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

Verbindliche Details (Endpunkte, Feldnamen, Fehlercodes) stehen in der internen Spezifikation, die
außerhalb dieses Repositories liegt und nicht veröffentlicht wird.

