# src-shared/ – shared types and validation

This folder is reserved for the artifacts that the adapter and the PWA share. At the moment it holds only this note; the
API types live in the adapter (`src/lib/web/`) and in the web app (`src-www/src/api/types.ts`).

What belongs here:

- TypeScript types for API payloads (punches, entries, absences, aggregates, settings)
- schemas for inputs and outputs (one source for server validation and client forms)
- constants and formatting helpers, e.g. units (minutes), date/time formats (`tsUtc`, `localDate`, `localTime`) and
  stable API error codes
- calculation building blocks that have to be identical in both worlds (e.g. the display of the day/month balance)

**Rules**

- No server dependencies (no `@iobroker/*`, no SQLite) and no browser dependencies.
- No business logic that may only be decided on the server (permissions, sessions, the truth of the balances).
- Clean room: no code or identifiers from other projects (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

Binding field names and formats are in the internal specification, which lives outside this repository and is not
published.
