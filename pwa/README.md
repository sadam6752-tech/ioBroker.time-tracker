# pwa/ – Progressive Web App

React 18 + MUI 5 + Vite + React Query, Service Worker über Workbox, installierbar auf Smartphone
und Desktop, offlinefähiges Stempeln mit Sync-Warteschlange.

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

