# shared/ – gemeinsame Typen und Validierung

Hier liegen die Artefakte, die Adapter und PWA gemeinsam nutzen:

- TypeScript-Typen für API-Nutzlasten (Stempel, Einträge, Abwesenheiten, Aggregate, Einstellungen)
- zod-Schemata für Ein- und Ausgaben (eine Quelle für Servervalidierung und Client-Formulare)
- Konstanten und Formatierungshilfen, z. B. Einheiten (Minuten), Datums-/Zeitformate (`tsUtc`,
  `localDate`, `localTime`) und stabile API-Fehlercodes
- Berechnungsbausteine, die in beiden Welten identisch sein müssen (z. B. Tages-/Monatssaldo-Anzeige)

**Regeln**

- Keine Server-Abhängigkeiten (kein `@iobroker/*`, kein SQLite) und keine Browser-Abhängigkeiten.
- Keine Geschäftslogik, die nur serverseitig entschieden werden darf (Rechte, Sitzungen, Salden-Wahrheit).
- Clean Room: kein Code/keine Bezeichner aus dem Legacy-Baum (siehe [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

Verbindliche Feldnamen und Formate stehen in der internen Spezifikation, die außerhalb dieses
Repositories liegt und nicht veröffentlicht wird.

