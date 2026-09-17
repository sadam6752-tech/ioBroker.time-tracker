# Technik (Interna)

Dieses Dokument sammelt die technischen Einzelheiten, die früher im [README](../README.md) standen: HTTP-Oberfläche,
Sitzungen und Sicherheit, Live-Ereignisse, die Offline-Warteschlange der App und die Datenbank. Zum Benutzen des
Adapters genügt das README; hier steht, wie es innen aussieht.

## HTTP-Oberfläche

- `/api` ist der einzige API-Präfix — die Web-App besitzt alle anderen Pfade (Client-Routing).
- Fehler kommen als `application/problem+json` (RFC 9457) mit stabilem `code`; die App übersetzt die Codes.
- Downloads sind echte Dateien (`content-disposition: attachment`), kein JSON: `/api/reports/pdf` und
  `/api/reports/xls`.
- `/api/stream` ist der WebSocket für Live-Ereignisse. Er akzeptiert das Sitzungscookie, der Browser braucht also
  kein Token in der URL; ein Mitarbeiter sieht nur die eigenen Ereignisse.
- Fehlt `www/`, läuft der Adapter weiter und bedient nur die API — eine Logzeile sagt, welcher Fall gilt.

## Sitzungen, CSRF und Ratenlimits

Die Sitzungen der Web-App reisen in einem `httpOnly`-Cookie (`SameSite=Lax`, `Secure` hinter HTTPS), damit ein in
die Seite eingeschleustes Skript sie nicht lesen kann. Die App selbst hält nur das CSRF-Token und den Benutzer im
`localStorage`; das Sitzungstoken verlässt das Cookie nie. Zustandsändernde Anfragen brauchen zusätzlich den Header
`x-csrf-token`, den `GET /api/auth/me` für die eigene Sitzung herausgibt (so findet ihn auch ein Browser nach einem
Neuladen wieder). Integrationsclients nutzen weiter den Header `x-session-token` aus der Login-Antwort — dieser Weg
braucht kein CSRF-Token, weil eine fremde Seite einen eigenen Header nicht setzen kann.

Die Ratenlimits und der Audit-Trail rechnen mit der Client-Adresse. Steht ein Proxy davor, wird sie nur mit
eingeschaltetem **Trust the reverse proxy** aus `x-forwarded-for` gelesen, und es zählt der **rechteste** Eintrag
(`x-forwarded-for: client, proxy`), weil der linke Teil vom Client kommt.

## Offline-Warteschlange

Die Web-App legt Stempel ohne Verbindung in eine lokale Warteschlange (`pending`) und schickt sie beim nächsten
Kontakt nach; was nicht eindeutig zuzuordnen ist, landet als Konflikt in der Ansicht *Abgleich* und wird von der
Verwaltung entschieden. Solange ein Stempel `pending` oder `conflict` ist, zählt er in keiner Rechnung: die
Paarbildung (`src/lib/domain/punch.ts`) lässt ihn weg.

## Datenbank

SQLite über `better-sqlite3`, im WAL-Modus, im Datenverzeichnis des Adapters. Schema-Änderungen gibt es
ausschließlich als versionierte Migration in `src/lib/db/migrations.ts` (`schema_migrations`); Migrationen sind
append-only, jede Änderung ist eine neue Nummer. Nur Aggregate und Steuerbefehle werden als States veröffentlicht —
Stempel selbst bleiben in der Datenbank.

## Pausen

Die Pause eines Tages kommt aus `src/lib/domain/breaks.ts`: gestempelte Pausen sind die Lücken zwischen den
Stempelpaaren, die Pausenstaffel zieht je Block (erster bis letzter Stempel) feste Minuten ab, und der Modus
`pause_mode` entscheidet, was gilt (`auto` = gestempelt, sonst Staffel). Vom bezahlten Anteil
(`work_profiles.pause_paid_minutes`) wird höchstens die Pause selbst angerechnet. Beide Werte landen je Tag in
`day_aggregates` und damit im Monatsnachweis.
