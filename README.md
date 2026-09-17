![Logo](admin/zeiterfassung.png)

# ioBroker.zeiterfassung

[![NPM version](https://img.shields.io/npm/v/iobroker.zeiterfassung.svg)](https://www.npmjs.com/package/iobroker.zeiterfassung)
[![Downloads](https://img.shields.io/npm/dm/iobroker.zeiterfassung.svg)](https://www.npmjs.com/package/iobroker.zeiterfassung)
![Number of Installations](https://iobroker.live/badges/zeiterfassung-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/zeiterfassung-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.zeiterfassung.png?downloads=true)](https://nodei.co/npm/iobroker.zeiterfassung/)

**Tests:** ![Test and Release](https://github.com/sadam6752-tech/ioBroker.zeiterfassung/workflows/Test%20and%20Release/badge.svg)

A punch clock for ioBroker. Employees clock in and out, the adapter calculates target time and balance, absences and
vacation are managed, and the monthly statement is downloaded as PDF or Excel. Everything runs in the browser —
installable as an app on a phone — and a shared tablet in the workshop or at the entrance punches with a badge or a
PIN. All data stays on your own ioBroker host: no cloud, no subscription.

## Features

- **Clock in and out** in the web app (phone, tablet, PC); installable as an app (PWA) and it keeps punches while offline
- **Terminal for everybody**: badge (RFID/NFC) or PIN on a shared tablet, plus a board that shows who is at work
- **Working time**: target time from weekly hours, employment level and working days; breaks (punched or by graduated rules), overtime models, carryover, vacation and public holidays
- **Absences and vacation**: requests and approvals, half days, and a preview of the days already planned
- **Corrections** by the administration (change, delete, add a punch or a whole day) — every change carries a reason and the history of a punch stays readable
- **Monthly statements** as PDF and Excel, for the own account and — with the right — for every employee; statistics and payouts included
- **Roles**: administrator, manager, employee; every decision is checked on the server
- **Automations**: aggregates, live events and commands as ioBroker states
- **Backups**: create, download, upload, restore on the next start, delete — with a retention window
- **11 languages**; every employee picks their own

## Requirements

- ioBroker with js-controller >= 6.0.11 and **Node.js >= 22** (required by the bundled SQLite driver)
- HTTPS for the app on a phone (the service worker needs it) — a reverse proxy with Let's Encrypt is recommended

## Installation

1. In the ioBroker admin: **Adapters → zeiterfassung → Install** (or `iobroker install iobroker.zeiterfassung`).
   An installation from Git does not work on its own: the web app in `www/` is built, so it is not part of the
   repository — either install the npm package or build it once in the adapter directory
   (`npm ci && npm run install:pwa && npm run build:pwa && npm run build`).
2. Start the instance and open the web app on the port of the instance settings (default **8092**):
   `http://<ioBroker host>:8092/`
3. Log in with the start password (see [First start](#first-start)) and create your employees.

## First start

The first start creates the database, the roles and the settings — and **one administrator account**, because
otherwise nobody could log in:

| Instance setting                            | Meaning                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Login of the first administrator            | login of that account, default `admin`                                                |
| Start password of the first administrator   | password of that account; empty = a random password is written to the adapter log once |

The account starts with “change the password”, so the start password opens the door exactly once and the app asks
for a new one right away. Accounts created later in the administration start the same way.

The start password appears **once in the ioBroker log**: open `Logs` in the admin and look for the line
`administrator "admin" created with the start password "…" - change it at the first login`. The instance settings
show the same hint — enter your own password there and nothing has to be searched.

After that the usual order is: create employees (**Administration → Employees**), set their working time
(**Arbeitsprofil** button of the row: employment level, weekly hours, working days, overtime model, vacation,
carryover, paid break minutes, own break rules), and — if a tablet is used — create a terminal and switch the kiosk on
(see [Terminal](#terminal-kiosk)).

## Configuration

The adapter is configured in the **instance settings** of the ioBroker admin:

| Setting                             | Meaning                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| Port                                | port of the HTTP server (web app, API, terminal)                 |
| Bind address                        | interface to listen on, picked from the local addresses (`0.0.0.0` = all) |
| Instance time zone                  | fallback time zone (IANA name), e.g. `Europe/Berlin`             |
| Default language for new users      | one of the 11 supported languages                                |
| Holiday country                     | country used to generate the public holidays (default `DE`)      |
| Database file                       | optional path; empty = adapter data directory                    |
| Enable kiosk terminal               | switches the shared badge/PIN terminal on                        |
| Trust the reverse proxy             | use `X-Forwarded-*` of a proxy (client address, HTTPS)           |
| Session secret                      | secret for CSRF tokens (encrypted at rest; empty = generated once) |
| Badge link secret (HMAC)            | secret for signed badge/NFC links (encrypted at rest)            |
| Session lifetime in minutes         | how long a login lasts                                           |
| Days users may edit on their own    | how far back an employee may correct own punches                 |
| Round quick punches to minutes      | rounding of the quick punch (0 = off)                            |
| Calculate absences only until today | future absences do not reduce the target time                    |
| Subtract working time from absences | lets vacation turn into overtime                                 |
| Keep database backups for days      | retention of the backups                                         |

These settings win over the values stored in the database and are applied on every start.

### Settings inside the app

Further settings are edited in the web app (**Administration → Settings**, right `settings.edit`):

| Setting                                     | Meaning                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pause rule (`auto` / `punched` / `staffel`)  | how the pause of a day is determined: the punched break (`auto`, default) or only the graduated rules           |
| Graduated break rules (Pausenstaffel)        | “from … to … minutes block length → so many minutes deducted”; the pause of a day **without** a punched break. The work profile of an employee can carry **own rules**: a rule with the same “from minutes” replaces the company rule for that person only |
| Paid break minutes (per employee)            | how much of a break is paid: `0` = not paid, `15` = a quarter of an hour, `1440` = any length (work profile)      |
| Company branding                             | logo, background picture and accent colour for the login screen, the header and the kiosk screens               |
| Unicode font for PDF statements              | `report_font_path`: needed for `ru`, `uk`, `zh-cn` and Polish, otherwise the export refuses with a clear message |

The pause of a day appears in the month view of the app and in the monthly statement — with the paid part next to it.

## Roles

| Role       | May                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------- |
| `employee` | punch, see the own month and year, request absences, edit own punches inside the edit window   |
| `manager`  | everything an employee may, plus statements and corrections for other employees                |
| `admin`    | everything: employees, roles, terminals, settings, backups                                     |

The **edit window** (`edit_window_days`, default 7 days) is what an `employee` is bound by: an older punch is
rejected with `edit_window_closed` and stays with the administration. Managers and admins are not bound by it.
Employees correct their own day right in the month view — the pencil beside a day opens its punches.

## Web app, terminal and API

Everything is served on the port of the instance settings:

| Path                      | Content                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/` (and all other paths) | the web app from `www/` — punch screen, month, year report, absences, profile  |
| `/api/...`                | the REST API (JSON; errors as `application/problem+json`)                      |
| `/api/stream`             | live events, so the app updates itself without a reload                        |
| `/terminal?token=…`       | the kiosk screen (badge and PIN)                                               |
| `/presence?token=…`       | the board “who is at work right now”                                            |

### Terminal (kiosk)

Switch **Enable kiosk terminal** on, then create the device in **Administration → Terminals** and copy the device
token — it is shown **exactly once**, because only its hash is stored. The ready-made address for the tablet stands
next to it:

```
http://<ioBroker host>:<port>/terminal?token=<device token>
```

The screen offers the badge field (scan or type, Enter punches), the employee list for the name plus PIN punch, the
clock and — after every punch — name, direction and the figures of that day for a few seconds. A device can be
limited to the employees that work there; without an assignment it shows everybody. **Employees need their PIN**
switches between “badge and PIN” and “badge only”. The token stays in the browser of the tablet, so the URL is only
needed for the first start.

## States

Punches stay in the database; the adapter publishes aggregates and controls:

| State                                                                                     | Type    | Purpose                                   |
| ----------------------------------------------------------------------------------------- | ------- | ----------------------------------------- |
| `zeiterfassung.0.info.connection`                                                          | boolean | adapter/service ready                     |
| `zeiterfassung.0.info.lastBackup`                                                          | number  | instant of the newest database backup     |
| `zeiterfassung.0.info.version` / `info.schemaVersion` / `info.dbSizeBytes` / `info.lastError` | —     | instance information                      |
| `zeiterfassung.0.users.<id>.displayName`                                                   | string  | name of the employee                      |
| `zeiterfassung.0.users.<id>.hasOpenEntry`                                                  | boolean | employee is clocked in                    |
| `zeiterfassung.0.users.<id>.lastPunch`                                                     | number  | instant of the last punch of today        |
| `zeiterfassung.0.users.<id>.todayWorkedMinutes`                                            | number  | minutes worked today                      |
| `zeiterfassung.0.users.<id>.todayBalanceMinutes`                                           | number  | balance of today in minutes               |
| `zeiterfassung.0.users.<id>.openConflicts`                                                 | number  | punches waiting for a decision            |
| `zeiterfassung.0.commands.punchUserId`                                                     | number  | employee the punch commands apply to      |
| `zeiterfassung.0.commands.punch`                                                           | boolean | punch in or out (button)                  |
| `zeiterfassung.0.commands.quickPunch`                                                      | boolean | punch with the configured quick rounding  |
| `zeiterfassung.0.commands.closeMonth`                                                      | string  | close a month, value `YYYY-MM`            |
| `zeiterfassung.0.commands.recalc`                                                          | string  | recalculate a period, `YYYY-MM` or `YYYY` |
| `zeiterfassung.0.commands.backup`                                                          | boolean | write a database backup (button)          |

## Reports

The month view and the year report of the app offer the statement of the shown period as **PDF** and **Excel**
(`.xlsx`) — with the day table, the numbers of the month, the absences and two signature lines in the PDF. The file
is generated in the language and the time zone of the employee; the administration can pick another employee and
download the same statement for them.

Next to the two buttons sits a third one: the **raw data as CSV**. It carries one row per punch (`date`, `time`,
`direction`, `source`, `note`), semicolon separated and UTF-8 with a byte order mark — so a spreadsheet opens it
directly and a payroll tool can read it without asking. The header is English on purpose, because the file is meant
for a machine.

For `ru`, `uk`, `zh-cn` and Polish the PDF needs a Unicode font: set `report_font_path` in the app settings to a
`.ttf`/`.otf` file that covers the script. Without it the export stops with a clear message
(`report_font_missing`) instead of drawing empty boxes.

## Backups

**Administration → Backups** creates a copy of the database with one click and lists what exists:

| Action        | What happens                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Create now    | writes a copy (`VACUUM INTO`) into the backup folder                                              |
| Download      | hands the file to the browser                                                                     |
| Upload        | takes a downloaded file back, checks it and queues it for the next start                           |
| Restore       | queues one of the listed files for the next start (with a reason)                                  |
| Delete        | removes a single file after a confirmation                                                         |

A restore needs a closed database, so it is applied **while the adapter starts** — the app says so, and the previous
database is kept next to it as `<database>.before-restore-<time>`. Backups older than the retention of the instance
settings are removed automatically; the newest one always stays.

## HTTPS and reverse proxy

The app on a phone needs **HTTPS** — a service worker only runs on a secure origin. Put nginx or caddy in front of
the adapter and switch **Trust the reverse proxy** on: the adapter then takes the client address from
`x-forwarded-for` for the rate limits and the audit trail, and `x-forwarded-proto: https` makes the session cookie
`Secure`. Without that switch both headers are ignored, because any client could send them.

## Troubleshooting

| Problem                                          | Cause and fix                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `/` answers `404 not_found`                      | the web app is missing: install the npm package or build it (`npm run install:pwa && npm run build:pwa`) |
| Not installable as an app on the phone           | the page is not reachable over HTTPS — see above                                                 |
| The PDF refuses or shows empty boxes             | `report_font_path` is missing — see [Reports](#reports)                                          |
| A restore seems to do nothing                    | it is applied on the next start: restart the instance                                            |
| An employee cannot log in                        | the start password has to be changed on first use; the administration can set a new one          |
| A punch is missing                               | it may wait in the offline queue or be marked as a conflict (see *Synchronisation* in the app)    |

## Languages

The admin UI, the app and the reports ship in **11 languages** — `en` (base and fallback), `de`, `ru`, `pt`, `nl`,
`fr`, `it`, `es`, `pl`, `uk`, `zh-cn` — and every employee picks their own. Dates, numbers and units are formatted
with `Intl`. Further translations are welcome: [`docs/i18n.md`](docs/i18n.md).

## Privacy

Everything runs on your own ioBroker host: no cloud service, no telemetry. Punches and personal data stay in the
local SQLite file, access is role-based, and every correction is written to an audit trail.

## Documentation

| Document                                             | Content                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/erste-schritte.md`](docs/erste-schritte.md)   | a walk through the first setup (German)                       |
| [`docs/kurzfassung-de.md`](docs/kurzfassung-de.md)   | the German summary of this README                             |
| [`docs/testplan.md`](docs/testplan.md)               | acceptance tests and what is still open                        |
| [`docs/entscheidungen.md`](docs/entscheidungen.md)   | the decisions behind the design (German)                      |
| [`docs/technik.md`](docs/technik.md)                 | internals: HTTP surface, sessions, live events, database       |
| [`docs/entwicklung.md`](docs/entwicklung.md)         | build, tests, release                                          |
| [`docs/i18n.md`](docs/i18n.md)                       | how the 11 languages are kept complete                        |
| [`docs/adapter-check.md`](docs/adapter-check.md)     | the local pre-check of the ioBroker adapter rules              |

## Links

- Repository: https://github.com/sadam6752-tech/ioBroker.zeiterfassung
- Issues: https://github.com/sadam6752-tech/ioBroker.zeiterfassung/issues
- ioBroker forum: https://forum.iobroker.net/

## Changelog

### **WORK IN PROGRESS**

### 0.0.15 (2026-09-17)

- (Alex) the **default port** is `8092` now — `8082` is the default of vis and web in ioBroker, so a fresh
  installation could not start beside them; the port field names that in its help text
- (Alex) the **default holiday country** is Germany (`DE`) now: new instances generate German public holidays,
  existing ones just pick the country in the instance settings
- (Alex) the instance settings point out the **start password** in two places now — a hint on the first tab and a
  header right above the fields — because the generated password appears exactly once in the ioBroker log

### 0.0.14 (2026-09-17)

- (Alex) the **bind address** of the instance is picked from the local addresses of the host now (a list in the
  admin settings instead of a free text field), and a value that carries a port cannot keep the server from starting

### 0.0.13 (2026-09-17)

- (Alex) graduated break rules can be **per employee** now: the work profile carries its own table, and a rule with
  the same "from minutes" replaces the company rule for that one person (only the administration edits it)
- (Alex) the **edit window** (`edit_window_days`) is enforced now: employees may change their own punches only
  inside it — an older one is rejected with `edit_window_closed` and stays the business of the administration
- (Alex) employees correct their own punches right in the month view: the pencil beside a day opens the punches of
  that day, a time can be fixed or a forgotten punch added (removing one needs `time.delete`)
- (Alex) the monthly report has a **raw data export as CSV** (button beside Excel and PDF): one row per punch with
  date, time, direction, source and note — semicolon separated, UTF-8 with BOM, so a spreadsheet opens it directly
- (Alex) internal: the README is a user guide now — what the adapter does, installation and first start, instance
  settings, roles, states, reports, backups, HTTPS and troubleshooting. The internals (HTTP surface, sessions,
  live events, database, breaks) moved to `docs/technik.md`, the build/test/release part to `docs/entwicklung.md`

### 0.0.12 (2026-09-17)

- (Alex) the month view of the web app shows the **pause** as well: the summary of the month carries `Pause` (with the
  paid part in brackets as soon as there is one) and every day row lists its pause beside worked and target time

### 0.0.11 (2026-09-17)

- (Alex) fix: the totals row of the PDF statement stays complete — every value of a column is measured now, so a
  total like `187:00` (wider than any single day) is not cut off at the end of its column any more
- (Alex) the backup screen covers the whole round trip: a copy can be **uploaded** again — the way back for a host
  that lost its data directory, because the file is checked before it is queued and only then replaces a restore
  that is already waiting — and a single copy can be **deleted** (after a confirmation, while the automatic
  retention keeps running in the background)
- (Alex) the pause of a day can be **measured**: a break that an employee punches is taken from the time sheet —
  the column “Pause” shows it instead of a flat rule deduction, while a day without a punched break keeps its
  graduated deduction, and a punched break is never deducted twice. The **work profile** is editable in the app
  now (employment level, weekly hours, working days, overtime model, vacation, carryovers) and got the number field
  **“Paid break minutes per day”**: that part of a break is credited as working time (`0` = the break is not paid,
  `1440` = any length), while the “Pause” column keeps documenting the whole break. Both statements carry a column
  **“of which paid”** with its own sum, and the **graduated break rules** (Pausenstaffel) have an editor in the
  settings at last — before that they had no writer at all, so a fresh instance could not deduct anything

### 0.0.10 (2026-09-17)

- (Alex) backups are now usable from the browser: the administration downloads a backup file with one click and
  restores a listed one for the **next start** of the adapter (the swap needs a closed database), so neither
  needs a shell on the host any more; a queued restore is announced in the screen and logged on the next start,
  and the previous database is kept next to it as `<database>.before-restore-<time>`

### 0.0.9 (2026-09-17)

- (Alex) fix: the PDF statement keeps its measured layout — the column headings define the width of their column,
  so "Arbeitszeit" and "Abwesenheit" stay on one line (and the English "02:00 AM" no longer falls apart); the two
  signature lines are level because the underscores became a ruled line; and the footer no longer starts a second
  page that carried nothing but the footer
- (Alex) fix: the PDF statement refuses Polish instead of drawing nonsense, because the built-in fonts cannot draw
  "Nieobecność", "święto" or "cały dzień" — `report_font_path` is needed there as well (the labels decide, so the
  same happens for any other language whose letters are outside the built-in set)

### 0.0.8 (2026-09-17)

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

Older entries are kept in [`CHANGELOG_OLD.md`](CHANGELOG_OLD.md).

## Provenance

This project is an independent implementation of the time tracking described in the internal specification.
Behaviour, calculation rules and data formats follow that specification; **no source code** was taken from any
other project. The verification record is kept outside this repository.

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
