# ioBroker.zeiterfassung

Time tracking (**clock-in/clock-out**) for ioBroker – self-hosted, multi-user, with an installable web app
(PWA), a badge/PIN terminal, absence and vacation management, and monthly reports.

> **Status: early development (Phase 0 – scaffolding).** There is no usable release yet: the adapter is
> generated in Phase 1, the PWA in Phase 5, so the package is not installable from npm at the moment.
> Public documentation of the adapter is this README; the detailed internal specification is **not** part
> of this repository.

## Features (planned)

| Area | Content |
|---|---|
| Punching | Web app (PWA, installable, offline-capable with queued sync), kiosk terminal with badge/PIN, NFC deep links, QR code fallback |
| Users & rights | Multi-user with roles (admin/manager/employee) and a full permission catalogue – all decisions server-side |
| Working time | Target time from weekly hours × employment level ÷ working days, break rules (graduated, applied per time pair), overtime models (monthly/yearly/cumulative), carryover, rounding for quick punch |
| Absences & vacation | Absence types with factors, half days, planned vacation preview, holidays incl. movable feasts |
| Reports | Monthly PDF timesheet, XLS export, statistics, payouts/compensation |
| ioBroker | Aggregates and events as states (`info.*`, `users.<id>.*`, `global.*`, `event.*`) and `command.*` for automations |
| Data | SQLite file (WAL) in the adapter's data directory; only aggregates are published as states |
| Migration | Import of existing **SMALL-Time** data (dry-run report plus golden-file verification) |

## Requirements

- ioBroker with js-controller >= 6 and Node.js >= 20
- HTTPS for the web app (required for PWA/service worker); a reverse proxy with Let's Encrypt is recommended
- Optional for migration: an existing SMALL-Time `Data` directory (read-only copy)

## Installation

Not yet available. Once released:

```bash
iobroker add zeiterfassung
```

## Configuration

Planned instance options (`native`): HTTP port, secrets (session/HMAC), database path, instance and user
time zones, optional legacy data directory for the import, holiday country, backup/retention settings.

## States (overview)

| State | Type | Purpose |
|---|---|---|
| `zeiterfassung.0.info.connection` | boolean | adapter/service ready |
| `zeiterfassung.0.users.<id>.working` | boolean | user currently clocked in |
| `zeiterfassung.0.users.<id>.today.workedMin` | number | minutes worked today |
| `zeiterfassung.0.users.<id>.year.overtimeMin` | number | accumulated overtime (minutes) |
| `zeiterfassung.0.global.presentCount` | number | users currently present |
| `zeiterfassung.0.event.lastPunch` | json | last punch (trigger for automations) |
| `zeiterfassung.0.command.punch` | boolean | button: set a punch |

Punch records themselves are **not** mirrored into states – they live in the SQLite database.

## Privacy

Everything runs on your own ioBroker host: no cloud service, no telemetry. Punch and personal data stay in
the local SQLite file; access is role-based and corrections are audited.

## Development

This repository is a monorepo:

```
adapter/   ioBroker adapter (TypeScript, Fastify, better-sqlite3) – generated in Phase 1
pwa/       Progressive Web App (Vite + React + MUI)
shared/    shared types and validation (zod) used by adapter and PWA
docs/      provenance record (and the generated clean-room report)
tools/     clean-room verification script
```

- Contributing rules: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Clean-room verification: `npm run cleanroom`
- Provenance and verification record: [`docs/provenance.md`](docs/provenance.md)

## Changelog

### 0.0.1 (unreleased)
- Repository scaffolding: MIT license, metadata, clean-room rules and verification script

## License

MIT – see [`LICENSE`](LICENSE).

## Provenance / acknowledgement

This project is an independent reimplementation. Behavior, calculation rules and data formats were
determined from a running SMALL-Time installation (SmallTime v0.9.205, © IT-Master, AGPL-3.0) so that
existing data can be reused. **No source code** was taken from that project. Details and the verification
record: [`docs/provenance.md`](docs/provenance.md).

## Kurzfassung (Deutsch)

Zeiterfassung für ioBroker: Stempeln über die installierbare Web-App (PWA) oder ein Kiosk-Terminal mit
Badge/PIN, Rollen und Rechte, Soll-/Pausen-/Überstunden- und Ferienregeln, Monatsberichte (PDF/XLS),
Abwesenheiten sowie Veröffentlichung von Aggregaten als ioBroker-States – alle Daten lokal in SQLite.
Eigenständige Neuimplementierung unter MIT-Lizenz; der Import bestehender SMALL-Time-Daten ist vorgesehen.
**Status:** frühe Entwicklungsphase (Phase 0), noch keine installierbare Version.

