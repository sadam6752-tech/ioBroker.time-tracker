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
> backups with a tested restore. The package is published on npm by the CI (with a provenance attestation) and is
> installed from there — see [Installation](#installation) and, for what is still open, [Still open](#still-open).

## Features

Everything in this table is implemented unless it is marked as open. The remaining work is listed under
[Development](#development).

| Area                | Content                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Punching            | Web app (PWA, installable, offline-capable with queued sync), kiosk terminal with badge/PIN, NFC deep links                                                                                       |
| Users & rights      | Multi-user with roles (admin/manager/employee) and a full permission catalogue – all decisions server-side                                                                                        |
| Working time        | Target time from weekly hours / employment level / working days, break rules (graduated, applied per time pair), overtime models (monthly/yearly/cumulative), carryover, rounding for quick punch |
| Absences & vacation | Absence types with factors, half days, planned vacation preview, holidays incl. movable feasts                                                                                                    |
| Corrections         | Administration fixes punches (change, delete, add a single punch or a whole day); every change carries a reason, and the history of a punch (who changed it and why) is shown in the app          |
| Reports             | Monthly PDF timesheet and XLS export for the own account **and for any employee** (administration), statistics, payouts/compensation                                  |
| ioBroker            | Aggregates and events as states (`info.*`, `users.<id>.*`, `global.*`, `event.*`) and `command.*` for automations                                                                                 |
| Data                | SQLite file (WAL) in the adapter's data directory; only aggregates are published as states                                                                                                        |

## Requirements

- ioBroker with js-controller >= 6.0.11 and **Node.js >= 22** (required by the bundled SQLite driver `better-sqlite3`)
- HTTPS for the web app (required for PWA/service worker); a reverse proxy with Let's Encrypt is recommended

## Installation

The adapter is published on npm and is installed from there:

```bash
iobroker install iobroker.zeiterfassung
```

An installation **from Git** (`iobroker url https://github.com/sadam6752-tech/ioBroker.zeiterfassung`) does **not**
work on its own: the web app in `www/` is generated and therefore not part of the repository. Either install the
package from npm or build it once inside the adapter directory:

```bash
npm ci && npm run install:pwa && npm run build:pwa && npm run build
```

## Configuration

The adapter is configured in the instance settings:

| Setting                             | Meaning                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Port                                | Port of the built-in HTTP server (web app, API, terminal)                                              |
| Bind address                        | Interface to listen on (`0.0.0.0` = all)                                                               |
| Instance time zone                  | Fallback time zone (IANA name), e.g. `Europe/Berlin`                                                   |
| Default language for new users      | One of the 11 supported languages                                                                      |
| Holiday country                     | Country used to generate public holidays                                                               |
| Database file                       | Optional path; empty = adapter data directory                                                          |
| Enable kiosk terminal               | Switches the shared badge/PIN terminal on                                                              |
| Trust the reverse proxy             | Use `X-Forwarded-*` of a proxy (client address, HTTPS)                                                 |
| Session secret                      | Secret for CSRF tokens (**encrypted at rest**; empty = generated once and stored next to the database) |
| Badge link secret (HMAC)            | Secret for signed badge/NFC links (**encrypted at rest**)                                              |
| Session lifetime in minutes         | Session TTL                                                                                            |
| Days users may edit on their own    | Retroactive editing window for employees                                                               |
| Round quick punches to minutes      | Quick-time rounding (0 = off)                                                                          |
| Calculate absences only until today | Future absences are not deducted from the target time                                                  |
| Subtract working time from absences | May convert vacation into overtime                                                                     |
| Keep database backups for days      | Retention of `VACUUM INTO` backups                                                                     |

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
(`report_font_missing`) instead of drawing empty boxes. The same happens for a language whose letters are outside
the set the built-in fonts know — Polish ("Nieobecność", "święto", "cały dzień") needs `report_font_path` as well.
The web app offers both files as buttons in the month
view and in the year report, so nobody has to build a URL by hand. With `&userId=` and the right
`report.view_other` the same routes deliver the statement of an employee: the year report has an employee
picker and the name of a month opens that month in full, so the accounting department does not have to open a
profile for every statement.

The web app itself covers the punch screen, the month calendar, the year report (including the two downloads
and, for the administration, the picker for an employee), absences, the offline queue with its conflict view and
the profile. Callers holding `user.view` or `backup.run`
additionally get an **administration** entry in the menu: employees (create, activate/deactivate, badge PIN) and
database backups (list, retention, "create now").

### Kiosk terminal

With **Enable kiosk terminal** switched on, a tablet in the workshop or at the entrance can punch for everybody
without logging in. Create the device in the administration of the web app (**Administration → Terminals**; the
API below it is `POST /api/terminals` with the permission `terminal.manage`). The device token is shown **exactly
once** — copy it right away, because only its hash is stored — and the screen also offers the ready-made address
for the tablet. Then open it on the device:

```
http://<adapter host>:<port>/terminal?token=<device token>
```

The screen keeps the token in the browser, so the URL is only needed for the first start. Afterwards it shows the
badge field (scan or type, Enter punches), the list of active employees for the name plus PIN punch, the server
clock and — after every punch — the name, the direction and the figures of that day for eight seconds. While the
kiosk is switched off the screen says so and nothing else happens; a revoked token sends it back to the setup
form. For the name/PIN path an employee needs a badge PIN (`POST /api/users/:id/pin`, 4–8 digits), for scanning an
RFID card id (`rfidCard`).

A device stands for one place, so it can be limited to the people that work there: the administration offers the
employees of the device when it is created and later through the **Employees** button of its row
(`POST /api/terminals` with `userIds`, `PUT /api/terminals/:id/users`). A device without an assignment shows
everybody, so the behaviour of an existing installation does not change.

**Employees need their PIN** is a switch per device. With it switched on a badge **and** the personal PIN are
required; with it switched off the badge alone is enough and a name picked from the list punches right away. A
wrong PIN is refused on both kinds of device, and the lock after too many wrong attempts stays active.

The same device serves two screens: `/terminal` is the classic kiosk described above, `/presence` shows the
employees as tiles with their picture and the state of the day — the screen for “who is at the workplace right
now”. Both keep the device token in the browser of the tablet.

### Branding

The installation can carry its own look: the administration (**Administration → Settings → Company branding**) takes
a **logo**, a **background picture** and an accent colour and applies them to the login screen, the header and the
kiosk screens. The pictures are kept with the settings but delivered through their own cacheable routes
(`GET /api/branding/logo`, `GET /api/branding/background`), so the payload of the settings API stays small.

A picture straight from a phone is scaled down in the browser (longest edge 2560 px, JPEG in several quality steps)
until it fits the 512 KiB the API accepts; the field reports the resulting size. The twelve preset colours are all
light tones that keep the dark text readable, and every background picture gets a light veil (75 % white) — so the
dark text of the app stays readable on a dark photo as well.

### Reverse proxy and HTTPS

HTTPS is required for the service worker (PWA installation), so put nginx or caddy in front of the adapter and
switch on **Trust the reverse proxy** in the instance settings. The adapter then uses the client address the proxy
appends to `x-forwarded-for` for the rate limits and the audit trail, and `x-forwarded-proto: https` makes the
session cookie `Secure`. Without that switch both headers are ignored — every client may send them, so a single
client could otherwise move itself into another rate limit bucket. Only the hop directly in front is evaluated:
with `x-forwarded-for: client, proxy` the rightmost entry counts, because the left part is client controlled.

The sessions of the web app travel in an `httpOnly` cookie (`SameSite=Lax`, `Secure` behind HTTPS), so a script
injected into the page cannot read them. The web app itself only keeps the CSRF token and the user in its
`localStorage`; the session token never leaves the cookie. Sessions that were opened before that switch stored a
token as well — they keep working and are moved over with the next login. State changing requests additionally
need the `x-csrf-token` header, which `GET /api/auth/me` hands out for the own session (that is also how a browser
that only holds the cookie learns it again after a reload). Integration clients keep using the `x-session-token`
header from the login response; that path needs no CSRF token, because a foreign page cannot equip a request with
a header of its own. Point the proxy at the whole adapter: the web app, `/api` and the WebSocket `/api/stream`
live on the same port — the stream accepts the cookie too, so the browser needs no token in the URL.

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

| Setting                                     | Meaning                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Login of the first administrator`          | login of that account, default `admin`                                                 |
| `Start password of the first administrator` | password of that account; empty = a random password is written to the adapter log once |

The account is created with `must_change_pw`, so the start password opens the door exactly once and the web
app asks for a new password right after the login. Accounts created later in the admin area start the same way.

The instance settings of the ioBroker admin are applied on every start and **win over the values stored in the
database** — holiday country, time zone (also the time zone of new accounts), default language for new users,
edit window, quick rounding, session lifetime, backup retention and the absence switches. `PUT /api/settings`
stays for the keys the admin UI does not offer; an empty field never wipes a stored value. The adapter also
publishes `info.version`, `info.schemaVersion`, `info.dbSizeBytes` and `info.lastError`.

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
docs/         operator and translator guide
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
| `npm run coverage`         | Unit tests plus a coverage report (text and `coverage/`, HTML and LCOV)      |
| `npm run translate`        | Keep the 11 translation files in sync                                       |
| `npm run check:i18n`       | Verify that all 11 languages are complete                                   |
| `npm run check:adapter`    | Local pre-check of the ioBroker adapter rules (see `docs/adapter-check.md`) |
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

- **Acceptance run on real hardware:** the sign-off of the layouts and of the PDF rendering for `ru`, `uk` and
  `zh-cn` (they need a Unicode font through `report_font_path`). The **legacy import** of the predecessor system is
  not part of the scope — the record of that decision is [`docs/entscheidungen.md`](docs/entscheidungen.md) (German).
- **Publication:** the package is on npm (currently `0.0.7`, published by the CI through npm trusted publishing
  with a provenance attestation) and `bluefox` is entered as an npm owner, so the local pre-check reports no
  error. Open after that: the entry in `ioBroker.repositories`.
- **Smaller gaps:** the NFC comfort in the admin area (reading and writing a badge link with a phone); the language
  files of the web app are machine translated and wait for a review by native speakers.

Working rules (see [`CONTRIBUTING.md`](CONTRIBUTING.md)): specification first, then tests, then
flags must follow the official role rules; secrets only via `encryptedNative`/`protectedNative`.

## Changelog

### **WORK IN PROGRESS**

### 0.0.8 (2026-09-17)

- (Alex) fix: the PDF statement keeps its measured layout — the column headings define the width of their column,
  so "Arbeitszeit" and "Abwesenheit" stay on one line (and the English "02:00 AM" no longer falls apart); the two
  signature lines are level because the underscores became a ruled line; and the footer no longer starts a second
  page that carried nothing but the footer
- (Alex) fix: the PDF statement refuses Polish instead of drawing nonsense, because the built-in fonts cannot draw
  "Nieobecność", "święto" or "cały dzień" — `report_font_path` is needed there as well (the labels decide, so the
  same happens for any other language whose letters are outside the built-in set)
- (Alex) the administration downloads the monthly statement of any employee from the year report: the screen has
  an employee picker (it appears with `report.view_other` and `user.view`), the Excel and PDF buttons follow the
  selection, and the name of a month opens that month in full — the accounting department no longer has to open
  a profile for every statement
- (Alex) internal: the status sections of the README and of the German summary describe the state of the
  publication again (`0.0.7` on npm, `bluefox` as npm owner, 450 unit / 60 package / 10 integration / 17 browser
  tests)
- (Alex) internal: the decision against the legacy import of the predecessor system states its reason
  (`docs/entscheidungen.md`)
- (Alex) fix: the texts of the nine translated languages show their values again — `{{minutes}}`, `{{date}}` and
  `{{conflicts}}` had been translated, so the variable was never filled and the placeholder appeared on screen
  (`reports.paidOut`, `sync.done`, `sync.conflictOf`, plus one text each in Dutch and Polish)
- (Alex) fix: wrong machine translations of the core terms are corrected — “punch” as a fist punch (`ru`, `uk`,
  `pt`, `pl`, `zh-cn`), “day share” as a campaign or as sharing (`ru`, `pt`, `nl`, `fr`, `it`, `es`, `zh-cn`),
  “taper” instead of the absence type (`fr`), 地位 (“social rank”) instead of the status (`zh-cn`),
  `reports.overtime` as “after a while” (`ru`), signing in/out instead of punching (`pl`) and `nav.sync` as a
  verb instead of a noun (seven languages)
- (Alex) fix: the same kind of mistake in the admin settings is corrected as well — a harbour instead of the
  port (`nl`, `zh-cn`), blows instead of punches (`it`, `es`, `nl`), a vacation country instead of the country
  whose public holidays are used (all nine languages) and field names that read like an instruction
  (`Bind address` in `ru`, `uk`, `fr`, `it`, `es`, `pl`)
- (Alex) internal: `npm run check:i18n` compares the placeholder names with the base file, including their
  order, so a translated `{{name}}` fails the check instead of reaching the screen; `docs/i18n.md` records the
  review state of every language and `docs/testplan.md` names the fonts that were verified with a real statement
  (`arial.ttf` for `ru`/`uk`, Malgun Gothic for `zh-cn`)

### 0.0.7 (2026-09-16)

- (Alex) fix: the published package contains the web app again — `www/` is generated and was missing from every
  release up to 0.0.6, so `http://<host>:<port>/` answered `404 not_found`; the release job now builds the web app,
  and `prepack` refuses to publish a package without `build/` or `www/`
- (Alex) internal: the installation section of the README describes the way that works (npm) and why an
  installation from Git needs a build of its own

### 0.0.6 (2026-09-16)

- (Alex) fix: the buttons of a list row — employees, terminals, holidays, badges, absences and the correction list —
  no longer cover the names on a phone, and an absence names its type again (the API hands the code out with the
  record)
- (Alex) internal: `npm run coverage` reports figures again (the coverage runner used a type checking compiler,
  which failed on the adapter types; `npm run check` stays the gate for the types)
- (Alex) internal: the unit tests cover the negative cases of the API (invalid instants, flags, whole minutes and
  punch directions, settings that cannot be changed, the picture route without a session, a foreign and a missing
  absence, a broken employee id in a payout query, tag links without a secret) and the failure paths of the backup
  service, the HTTP server and the event stream — 434 to 450 unit tests, branch coverage 80.9 to 83.3 %
- (Alex) internal: the browser tests cover the forced password change of a start password, the month view, the PDF
  statement as a download, an absence request and the geometry of every list row — 12 to 17 cases
- (Alex) internal: the README and the acceptance plan describe the current state again, and the dropped legacy
  import of the predecessor system is recorded as a decision (`docs/entscheidungen.md`)

### 0.0.5 (2026-09-16)

<!--
	Platzhalter für die nächste Version (am Zeilenanfang):
	### **WORK IN PROGRESS**
-->

- (Alex) the four settings of the first administrator are now translated in all 11 languages
- (Alex) internal: the adapter checker findings are resolved (news lists published versions only, the generated build output is marked as not-in-git, releases rebuild the web app)

### 0.0.4 (2026-09-16)

- (Alex) fix: the unit tests get a generous timeout (30 s), so cleaning up temporary directories cannot fail them on a slow runner

Older entries are kept in [`CHANGELOG_OLD.md`](CHANGELOG_OLD.md).

## Provenance

This project is an independent implementation of the time tracking described in the internal specification.
Behaviour, calculation rules and data formats follow that specification; **no source code** was taken from any
other project. The verification record is kept outside this repository.

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
