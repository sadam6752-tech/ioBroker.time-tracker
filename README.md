![Logo](admin/zeiterfassung.png)
# ioBroker.zeiterfassung

[![NPM version](https://img.shields.io/npm/v/iobroker.zeiterfassung.svg)](https://www.npmjs.com/package/iobroker.zeiterfassung)
[![Downloads](https://img.shields.io/npm/dm/iobroker.zeiterfassung.svg)](https://www.npmjs.com/package/iobroker.zeiterfassung)
![Number of Installations](https://iobroker.live/badges/zeiterfassung-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/zeiterfassung-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.zeiterfassung.png?downloads=true)](https://nodei.co/npm/iobroker.zeiterfassung/)

**Tests:** ![Test and Release](https://github.com/sadam6752-tech/ioBroker.zeiterfassung/workflows/Test%20and%20Release/badge.svg)

## zeiterfassung adapter for ioBroker

Time tracking (**clock-in/clock-out**) for ioBroker – self-hosted, multi-user, with an installable web app
(PWA), a badge/PIN terminal, absence and vacation management, and monthly reports.

> **Status: early development.** The project scaffolding (Phase 0) exists, the adapter logic follows
> step by step. The package is therefore **not installable from npm** yet and there are no stable states.

## Features (planned)

| Area | Content |
|---|---|
| Punching | Web app (PWA, installable, offline-capable with queued sync), kiosk terminal with badge/PIN, NFC deep links, QR code fallback |
| Users & rights | Multi-user with roles (admin/manager/employee) and a full permission catalogue – all decisions server-side |
| Working time | Target time from weekly hours / employment level / working days, break rules (graduated, applied per time pair), overtime models (monthly/yearly/cumulative), carryover, rounding for quick punch |
| Absences & vacation | Absence types with factors, half days, planned vacation preview, holidays incl. movable feasts |
| Reports | Monthly PDF timesheet, XLS export, statistics, payouts/compensation |
| ioBroker | Aggregates and events as states (`info.*`, `users.<id>.*`, `global.*`, `event.*`) and `command.*` for automations |
| Data | SQLite file (WAL) in the adapter's data directory; only aggregates are published as states |
| Migration | Import of existing **SMALL-Time** data (dry-run report plus golden-file verification) |

## Requirements

- ioBroker with js-controller >= 6.0.11 and **Node.js >= 22** (required by the bundled SQLite driver `better-sqlite3`)
- HTTPS for the web app (required for PWA/service worker); a reverse proxy with Let's Encrypt is recommended
- Optional for migration: an existing SMALL-Time `Data` directory (read-only copy)

## Installation

Not yet available. Once released:

```bash
iobroker add zeiterfassung
```

## Configuration

The adapter is configured in the instance settings:

| Setting | Meaning |
|---|---|
| Port | Port of the built-in HTTP server (web app, API, terminal) |
| Bind address | Interface to listen on (`0.0.0.0` = all) |
| Instance time zone | Fallback time zone (IANA name), e.g. `Europe/Zurich` |
| Default language for new users | One of the 11 supported languages |
| Holiday country | Country used to generate public holidays |
| Database file | Optional path; empty = adapter data directory |
| Enable kiosk terminal | Switches the shared badge/PIN terminal on |
| Session secret | Secret for session cookies/tokens (**encrypted at rest**) |
| Badge link secret (HMAC) | Secret for signed badge/NFC links (**encrypted at rest**) |
| Session lifetime in minutes | Session TTL |
| Days users may edit on their own | Retroactive editing window for employees |
| Round quick punches to minutes | Quick-time rounding (0 = off) |
| Calculate absences only until today | Future absences are not deducted from the target time |
| Subtract working time from absences | Legacy behaviour – may convert vacation into overtime |
| Legacy data directory for import | Read-only source directory of the old system |
| Keep database backups for days | Retention of `VACUUM INTO` backups |

## Web interface and API

The adapter runs its own HTTP server on the configured port and serves two things from it:

| Path | Content |
|---|---|
| `/` and all other paths | the built web app from `www/` (`index.html`, assets; unknown paths fall back to the page for client side routing) |
| `/api/...` | the REST API (JSON, errors as `application/problem+json`) |

The API is deliberately mounted below `/api`, so the web app owns every other path. If no `www/` folder is
part of the installation (for example while the web app is still being developed), the adapter keeps running
and only the API is reachable — a log line states which of both applies.

## States (overview)

| State | Type | Role | Purpose |
|---|---|---|---|
| `zeiterfassung.0.info.connection` | boolean | indicator.connected | adapter/service ready |
| `zeiterfassung.0.users.<id>.working` | boolean | indicator | user currently clocked in |
| `zeiterfassung.0.users.<id>.today.workedMin` | number | value | minutes worked today |
| `zeiterfassung.0.users.<id>.year.overtimeMin` | number | value | accumulated overtime (minutes) |
| `zeiterfassung.0.global.presentCount` | number | value | users currently present |
| `zeiterfassung.0.event.lastPunch` | string | json | last punch (JSON text, trigger for automations) |
| `zeiterfassung.0.command.punch` | boolean | button | button: set a punch |

Punch records themselves are **not** mirrored into states – they live in the SQLite database.

## Languages

The adapter's admin UI, the web app and the generated reports are shipped in **11 languages**
(the ioBroker standard set):

`en` (base and fallback), `de`, `ru`, `pt`, `nl`, `fr`, `it`, `es`, `pl`, `uk`, `zh-cn`

- Admin UI: `admin/i18n/<lang>.json`, kept in sync with the `io-package.json` metadata by `translate-adapter`
- Web app: `src-pwa/src/i18n/<lang>.json` (`i18next`), using the same keys
- Reports (PDF/XLS) use the language of the respective user; the instance language is the fallback
- Dates, numbers, currencies and units are formatted with `Intl` and the user's time zone
- Additional translations are welcome – see [`docs/i18n.md`](docs/i18n.md)
- The API returns stable error **codes** instead of translated messages; the client translates them
- This README is maintained in English with a German summary at the end

## Privacy

Everything runs on your own ioBroker host: no cloud service, no telemetry. Punch and personal data stay in
the local SQLite file; access is role-based and corrections are audited.

## Links

- Repository: https://github.com/sadam6752-tech/ioBroker.zeiterfassung
- Issues: https://github.com/sadam6752-tech/ioBroker.zeiterfassung/issues
- ioBroker forum: https://forum.iobroker.net/

## Development

This repository is the adapter itself; the web app is a sub-project:

```
src/          adapter sources (TypeScript)
src-pwa/      Progressive Web App (Vite + React + MUI) – built into www/
src-shared/   types and validation shared by adapter and web app
admin/        jsonConfig configuration and translations (11 languages)
test/         package and integration tests (@iobroker/testing)
tools/        clean-room and i18n verification scripts
docs/         provenance record and translator guide
```

| Script | Description |
|---|---|
| `npm run build` | Compile the TypeScript sources |
| `npm run watch` | Compile and watch for changes |
| `npm run lint` | ESLint with `@iobroker/eslint-config` |
| `npm run check` | TypeScript type check |
| `npm run test:ts` | Unit tests for the adapter sources |
| `npm run test:package` | Validate `package.json` / `io-package.json` |
| `npm run test:integration` | Adapter startup against a real js-controller |
| `npm run translate` | Keep the 11 translation files in sync |
| `npm run check:i18n` | Verify that all 11 languages are complete |
| `npm run cleanroom` | Verify that no source was copied from the legacy project |
| `npm run release` | Create a release (version, changelog, tag) |
| `dev-server watch` | Run and debug the adapter locally |

Working rules (see [`CONTRIBUTING.md`](CONTRIBUTING.md)): specification first, then tests, then
implementation; no code, comments or identifiers from the legacy project; state roles, types and access
flags must follow the official role rules; secrets only via `encryptedNative`/`protectedNative`.

## Changelog

### **WORK IN PROGRESS**
* (Alex) project scaffolding: adapter skeleton (TypeScript + jsonConfig), 11-language metadata, admin
  configuration fields, CI workflow (@iobroker/testing, Node 20/22/24), clean-room and i18n checks

### 0.0.1
* initial release (not published yet)

## License

MIT License

Copyright (c) 2026 Alex <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

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
**Status:** frühe Entwicklungsphase, noch keine installierbare Version.
