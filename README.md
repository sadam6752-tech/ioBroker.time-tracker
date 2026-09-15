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

> **Status: work in progress.** The adapter is implemented and tested: database with migrations, domain logic
> (time pairs, breaks, target time, overtime models, vacation, holidays), REST API with roles and permissions,
> web app (PWA) incl. offline queue, badge/PIN terminal, RFID scan, monthly reports (PDF/XLS), live events and
> backups with a tested restore. Still missing before the first release: the migration of existing SMALL-Time
> data, the acceptance tests and the publication itself. The package is therefore **not installable from npm**
> yet and there are no stable states.

## Features

Everything in this table is implemented unless it is marked as open. The remaining work is listed under
[Development](#development).

| Area                | Content                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Punching            | Web app (PWA, installable, offline-capable with queued sync), kiosk terminal with badge/PIN, NFC deep links                                                                                       |
| Users & rights      | Multi-user with roles (admin/manager/employee) and a full permission catalogue – all decisions server-side                                                                                        |
| Working time        | Target time from weekly hours / employment level / working days, break rules (graduated, applied per time pair), overtime models (monthly/yearly/cumulative), carryover, rounding for quick punch |
| Absences & vacation | Absence types with factors, half days, planned vacation preview, holidays incl. movable feasts                                                                                                    |
| Reports             | Monthly PDF timesheet, XLS export, statistics, payouts/compensation                                                                                                                               |
| ioBroker            | Aggregates and events as states (`info.*`, `users.<id>.*`, `global.*`, `event.*`) and `command.*` for automations                                                                                 |
| Data                | SQLite file (WAL) in the adapter's data directory; only aggregates are published as states                                                                                                        |
| Migration           | Import of existing **SMALL-Time** data (dry-run report plus golden-file verification) – **still open**                                                                                            |

## Requirements

- ioBroker with js-controller >= 6.0.11 and **Node.js >= 22** (required by the bundled SQLite driver `better-sqlite3`)
- HTTPS for the web app (required for PWA/service worker); a reverse proxy with Let's Encrypt is recommended
- Optional for migration: an existing SMALL-Time `Data` directory (read-only copy)

## Installation

Not published yet: the adapter is neither on npm nor in the official repository list. To run the current
state, build it locally (see [Development](#development)) and start it with the dev server:

```bash
npm ci && npm run install:pwa && npm run build:pwa && npm run build
```

Once released:

```bash
iobroker add zeiterfassung
```

## Configuration

The adapter is configured in the instance settings:

| Setting                             | Meaning                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| Port                                | Port of the built-in HTTP server (web app, API, terminal) |
| Bind address                        | Interface to listen on (`0.0.0.0` = all)                  |
| Instance time zone                  | Fallback time zone (IANA name), e.g. `Europe/Berlin`      |
| Default language for new users      | One of the 11 supported languages                         |
| Holiday country                     | Country used to generate public holidays                  |
| Database file                       | Optional path; empty = adapter data directory             |
| Enable kiosk terminal               | Switches the shared badge/PIN terminal on                 |
| Session secret                      | Secret for session cookies/tokens (**encrypted at rest**) |
| Badge link secret (HMAC)            | Secret for signed badge/NFC links (**encrypted at rest**) |
| Session lifetime in minutes         | Session TTL                                               |
| Days users may edit on their own    | Retroactive editing window for employees                  |
| Round quick punches to minutes      | Quick-time rounding (0 = off)                             |
| Calculate absences only until today | Future absences are not deducted from the target time     |
| Subtract working time from absences | Legacy behaviour – may convert vacation into overtime     |
| Legacy data directory for import    | Read-only source directory of the old system              |
| Keep database backups for days      | Retention of `VACUUM INTO` backups                        |

Instance settings (editable through `PUT /api/settings`, permission `settings.edit`) complement the
configuration; `report_font_path` is one of them: the path of a `.ttf`/`.otf` file used for PDF statements.
It is only needed for languages the built-in PDF fonts cannot display (`ru`, `uk`, `zh-cn`); everything else
works without an additional file.

## Web interface and API

The adapter runs its own HTTP server on the configured port and serves two things from it:

| Path                    | Content                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/` and all other paths | the built web app from `www/` (`index.html`, assets; unknown paths fall back to the page for client side routing) |
| `/api/...`              | the REST API (JSON, errors as `application/problem+json`)                                                         |
| `/api/stream`           | live events over a WebSocket (session token as query parameter)                                                   |

The API is deliberately mounted below `/api`, so the web app owns every other path. If no `www/` folder is
part of the installation (for example while the web app is still being developed), the adapter keeps running
and only the API is reachable — a log line states which of both applies.

Downloads are real files, not JSON: `GET /api/reports/xls?year=&month=` returns the monthly work time
statement of the caller as an Excel workbook (`.xlsx`) and `GET /api/reports/pdf?year=&month=` the same
statement as a PDF — both with `content-disposition: attachment`, generated in the language and time zone of
the employee. The PDF is one page per month with the day table, the totals, the absences and two signature
lines; for `ru`, `uk` and `zh-cn` a Unicode font has to be configured (`report_font_path`), because the
built-in PDF fonts only cover Latin-1 — the export refuses such a language with a clear message
(`report_font_missing`) instead of drawing empty boxes. The web app offers both files as buttons in the month
view and in the year report, so nobody has to build a URL by hand.

The web app itself covers the punch screen, the month calendar, the year report (including the two downloads),
absences, the offline queue with its conflict view and the profile. Callers holding `user.view` or `backup.run`
additionally get an **administration** entry in the menu: employees (create, activate/deactivate, badge PIN) and
database backups (list, retention, "create now").

### Kiosk terminal

With **Enable kiosk terminal** switched on, a tablet in the workshop or at the entrance can punch for everybody
without logging in. Create a terminal in the instance settings (`POST /api/terminals`, permission
`terminal.manage`); the response contains the device token **exactly once** — copy it, because only its hash is
stored. Then open it on the device:

```
http://<adapter host>:<port>/terminal?token=<device token>
```

The screen keeps the token in the browser, so the URL is only needed for the first start. Afterwards it shows the
badge field (scan or type, Enter punches), the list of active employees for the name plus PIN punch, the server
clock and — after every punch — the name, the direction and the figures of that day for eight seconds. While the
kiosk is switched off the screen says so and nothing else happens; a revoked token sends it back to the setup
form. For the name/PIN path an employee needs a badge PIN (`POST /api/users/:id/pin`, 4–8 digits), for scanning an
RFID card id (`rfidCard`).

## States (overview)

| State                                            | Type    | Role                | Purpose                                   |
| ------------------------------------------------ | ------- | ------------------- | ----------------------------------------- |
| `zeiterfassung.0.info.connection`                | boolean | indicator.connected | adapter/service ready                     |
| `zeiterfassung.0.info.lastBackup`                | number  | value.time          | instant of the newest database backup     |
| `zeiterfassung.0.users.<id>.displayName`         | string  | info.name           | name of the employee                      |
| `zeiterfassung.0.users.<id>.hasOpenEntry`        | boolean | indicator.working   | employee is clocked in                    |
| `zeiterfassung.0.users.<id>.lastPunch`           | number  | value.time          | instant of the last punch of today        |
| `zeiterfassung.0.users.<id>.todayWorkedMinutes`  | number  | value               | minutes worked today                      |
| `zeiterfassung.0.users.<id>.todayBalanceMinutes` | number  | value               | balance of today in minutes               |
| `zeiterfassung.0.users.<id>.openConflicts`       | number  | value               | punches waiting for a decision            |
| `zeiterfassung.0.commands.punchUserId`           | number  | value               | employee the punch commands apply to      |
| `zeiterfassung.0.commands.punch`                 | boolean | button              | punch in or out                           |
| `zeiterfassung.0.commands.quickPunch`            | boolean | button              | punch with the configured quick rounding  |
| `zeiterfassung.0.commands.closeMonth`            | string  | text                | close a month, value `YYYY-MM`            |
| `zeiterfassung.0.commands.recalc`                | string  | text                | recalculate a period, `YYYY-MM` or `YYYY` |
| `zeiterfassung.0.commands.backup`                | boolean | button              | write a database backup                   |

Punch records themselves are **not** mirrored into states – they live in the SQLite database.

## First start

The first start creates the database, the roles, the settings — and, when the instance has no administrator
yet, **one administrator account**, because otherwise nobody could log in:

| Setting | Meaning |
| --- | --- |
| `Login of the first administrator` | login of that account, default `admin` |
| `Start password of the first administrator` | password of that account; empty = a random password is written to the adapter log once |

The account is created with `must_change_pw`, so the start password opens the door exactly once and the web
app asks for a new password right after the login. Accounts imported from the old system work the same way:
their legacy SHA-1 is verified **once**, replaced by a modern hash during that login and deleted immediately
afterwards.

The instance settings of the ioBroker admin are applied on every start and **win over the values stored in the
database** — holiday country, time zone (also the time zone of new accounts), default language for new users,
edit window, quick rounding, session lifetime, backup retention and the absence switches. `PUT /api/settings`
stays for the keys the admin UI does not offer; an empty field never wipes a stored value. The adapter also
publishes `info.version`, `info.schemaVersion`, `info.dbSizeBytes` and `info.lastError`.

## Legacy import (SMALL-Time)

An existing installation can take its data over from the old PHP system (**SMALL-Time v0.9.205**). The import
reads the `Data` directory read-only and is started with the `commands.import` state:

```json
{ "baseDir": "/opt/smalltime", "mode": "dry-run" }
```

| Value | Meaning |
| --- | --- |
| `baseDir` | installation folder (containing `Data` and `include`) or the `Data` folder itself |
| `mode` | `dry-run` (default) counts and checks everything without writing, `commit` writes |
| `resetImport` | `true` allows a commit into a database that already holds entries, absences or payouts |
| `timezone` | time zone the legacy punch instants are read in, default `Europe/Berlin` |

What the import takes over:

- users, roles, work profiles, surcharge windows and badge codes from `Data/users.txt`, `Data/group.txt` and
  `Data/<user>/userdaten.txt` (group 1 becomes `admin`, everyone else `employee`)
- punch instants from `Data/<user>/Timetable/<year>.<month>`; the idempotency key `import:<user>:<epoch>` keeps
  a second run a no-op
- absences from `Timetable/A<year>` and payouts from `Timetable/auszahlungen`
- absence types of `absenz.txt`, the break rules of `include/Settings/pausen.txt` and the settings of
  `include/Settings/settings.txt` that the new system still uses
- after the import **all** aggregates are computed from the imported raw data — the legacy monthly values are
  never taken over, they only serve as a **golden reference**: a month that deviates by more than ±0.01 h makes
  the run end with `mismatch`

Every run is documented in the `import_runs` table (mode, status, counters, warnings, deviations), the last
report is published in `info.lastImport`. Folders that are deliberately not migrated (`Rapport/`,
`Dokumente/`, `img/`) are only counted in the report.

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

| Script                     | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm run build`            | Compile the TypeScript sources                                              |
| `npm run watch`            | Compile and watch for changes                                               |
| `npm run install:pwa`      | Install the dependencies of the web app (`src-pwa`, own `node_modules`)     |
| `npm run build:pwa`        | Type check and build the web app into `www/`                                |
| `npm run dev:pwa`          | Vite dev server with `/api` proxied to the running instance                 |
| `npm run lint`             | ESLint with `@iobroker/eslint-config` (adapter and web app)                 |
| `npm run lint:pwa`         | ESLint for the web app only                                                 |
| `npm run check`            | TypeScript type check (adapter and web app)                                 |
| `npm run test:ts`          | Unit tests for the adapter sources                                          |
| `npm run test:package`     | Validate `package.json` / `io-package.json`                                 |
| `npm run test:integration` | Adapter startup against a real js-controller (packs `build/` and `www/`)    |
| `npm run translate`        | Keep the 11 translation files in sync                                       |
| `npm run check:i18n`       | Verify that all 11 languages are complete                                   |
| `npm run check:adapter`    | Local pre-check of the ioBroker adapter rules (see `docs/adapter-check.md`) |
| `npm run cleanroom`        | Verify that no source was copied from the legacy project                    |
| `npm run release`          | Create a release (version, changelog, tag)                                  |
| `dev-server watch`         | Run and debug the adapter locally                                           |

The web app is built into `www/`, which the adapter serves on its own port (`/` = app, `/api` = REST). Both
steps are needed for a release:

```bash
npm run install:pwa
npm run build:pwa
npm run build
```

`node tools/make-pwa-icons.mjs` regenerates the app icons (checked in, no image library required).

### Still open

- **Migration** of existing SMALL-Time data (specification 2.9): parsers, re-hashing of legacy passwords,
  dry-run report and the golden comparison against `Timetable/<year>` — requires a real `Data` directory.
- **Acceptance:** end-to-end tests (Playwright), load smoke test, documented security verification, review of
  the layouts in all 11 languages and PDF rendering for `ru`, `uk` and `zh-cn` with a Unicode font.
- **Publication:** npm package, entry in `ioBroker.repositories`, official adapter checker, first release.
- **Smaller gaps:** statistics screen in the web app, role change / terminal management / settings in the admin
  area, and the nine web app language files that still contain English texts (structure is complete).

Working rules (see [`CONTRIBUTING.md`](CONTRIBUTING.md)): specification first, then tests, then
implementation; no code, comments or identifiers from the legacy project; state roles, types and access
flags must follow the official role rules; secrets only via `encryptedNative`/`protectedNative`.

## Changelog

### **WORK IN PROGRESS**

- (Alex) project scaffolding: adapter skeleton (TypeScript + jsonConfig), 11-language metadata, admin
  configuration fields, CI workflow (@iobroker/testing, Node 22/24/26), clean-room and i18n checks

### 0.0.1

- initial release (not published yet)

## Provenance / acknowledgement

This project is an independent reimplementation. Behavior, calculation rules and data formats were
determined from a running SMALL-Time installation (SmallTime v0.9.205, © IT-Master, AGPL-3.0) so that
existing data can be reused. **No source code** was taken from that project. Details and the verification
record: [`docs/provenance.md`](docs/provenance.md).

## German summary

A short summary in German (and why the README itself is English-only) is in
[`docs/kurzfassung-de.md`](docs/kurzfassung-de.md).

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
