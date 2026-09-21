![Logo](admin/time-tracker.png)

# ioBroker.time-tracker

[![NPM version](https://img.shields.io/npm/v/iobroker.time-tracker.svg)](https://www.npmjs.com/package/iobroker.time-tracker)
[![Downloads](https://img.shields.io/npm/dm/iobroker.time-tracker.svg)](https://www.npmjs.com/package/iobroker.time-tracker)
![Number of Installations](https://iobroker.live/badges/time-tracker-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/time-tracker-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.time-tracker.png?downloads=true)](https://nodei.co/npm/iobroker.time-tracker/)

**Tests:** ![Test and Release](https://github.com/sadam6752-tech/ioBroker.time-tracker/workflows/Test%20and%20Release/badge.svg)

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

1. In the ioBroker admin: *Adapters* → **“Install from custom URL”** → `iobroker.time-tracker`, or
   `iobroker install iobroker.time-tracker` on the command line. **The instance `time-tracker.0` is created
   automatically** — `iobroker add time-tracker` is only needed if you want the instance on its own.
   An installation from Git or from a checkout does not work on its own: `build/` and `www/` are built and not
   part of the repository. Either use the npm package, or build once in the adapter directory
   (`npm ci && npm run install:pwa && npm run build:pwa && npm run build`, then `iobroker install .`).
2. Start the instance and open the web app on the port of the instance settings (default **8092**):
   `http://<ioBroker host>:8092/`
3. Log in with the start password (see [First start](#first-start)) and create your employees.

## First start

The first start creates the database, the roles and the settings — and **one administrator account**, because
otherwise nobody could log in:

| Instance setting                          | Meaning                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Login of the first administrator          | login of that account, default `admin`                                                 |
| Start password of the first administrator | password of that account; empty = a random password is written to the adapter log once |

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

| Setting                             | Meaning                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Port                                | port of the HTTP server (web app, API, terminal)                                                                            |
| Bind address                        | interface to listen on, picked from the local addresses (`0.0.0.0` = all)                                                   |
| Instance time zone                  | fallback time zone (IANA name), e.g. `Europe/Berlin`                                                                        |
| Default language for new users      | one of the 11 supported languages                                                                                           |
| Holiday country                     | country used to generate the public holidays (default `DE`)                                                                 |
| Database file                       | optional path; empty = adapter data directory                                                                               |
| Enable kiosk terminal               | switches the shared badge/PIN terminal on                                                                                   |
| Trust the reverse proxy             | use `X-Forwarded-*` of a proxy (client address, HTTPS)                                                                      |
| Session secret                      | secret for CSRF tokens (encrypted at rest; empty = generated once)                                                          |
| Badge link secret (HMAC)            | secret for signed badge/NFC links (encrypted at rest); empty = generated on the first start and stored next to the database |
| Session lifetime in minutes         | how long a login lasts                                                                                                      |
| Days users may edit on their own    | how far back an employee may correct own punches                                                                            |
| Round quick punches to minutes      | rounding of the quick punch (0 = off)                                                                                       |
| Calculate absences only until today | future absences do not reduce the target time                                                                               |
| Subtract working time from absences | lets vacation turn into overtime                                                                                            |
| Keep database backups for days      | retention of the backups                                                                                                    |

These settings win over the values stored in the database and are applied on every start.

### Settings inside the app

Further settings are edited in the web app (**Administration → Settings**, right `settings.edit`):

| Setting                                     | Meaning                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause rule (`auto` / `punched` / `staffel`) | how the pause of a day is determined: the punched break (`auto`, default) or only the graduated rules                                                                                                                                                      |
| Graduated break rules (Pausenstaffel)       | “from … to … minutes block length → so many minutes deducted”; the pause of a day **without** a punched break. The work profile of an employee can carry **own rules**: a rule with the same “from minutes” replaces the company rule for that person only |
| Paid break minutes (per employee)           | how much of a break is paid: `0` = not paid, `15` = a quarter of an hour, `1440` = any length (work profile)                                                                                                                                               |
| Company branding                            | logo, background picture and background colour for the login screen, the header and the kiosk screens — the colour also tints the picture                                                                                                                  |
| Unicode font for PDF statements             | `report_font_path`: needed for `ru`, `uk`, `zh-cn` and Polish, otherwise the export refuses with a clear message                                                                                                                                           |

The pause of a day appears in the month view of the app and in the monthly statement — with the paid part next to it.

## Roles

| Role       | May                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------- |
| `employee` | punch, see the own month and year, request absences, edit own punches inside the edit window |
| `manager`  | everything an employee may, plus statements and corrections for other employees              |
| `admin`    | everything: employees, roles, terminals, settings, backups                                   |

The **edit window** (`edit_window_days`, default 7 days) is what an `employee` is bound by: an older punch is
rejected with `edit_window_closed` and stays with the administration. Managers and admins are not bound by it.
Employees correct their own day right in the month view — the pencil beside a day opens its punches.

## Web app, terminal and API

Everything is served on the port of the instance settings:

| Path                      | Content                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/` (and all other paths) | the web app from `www/` — punch screen, month, year report, absences, profile |
| `/api/...`                | the REST API (JSON; errors as `application/problem+json`)                     |
| `/api/stream`             | live events, so the app updates itself without a reload                       |
| `/terminal?token=…`       | the kiosk screen (badge and PIN)                                              |
| `/presence?token=…`       | the board “who is at work right now”                                          |

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

| State                                                                                          | Type    | Purpose                                    |
| ---------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| `time-tracker.0.info.connection`                                                              | boolean | adapter/service ready                      |
| `time-tracker.0.info.lastBackup`                                                              | number  | instant of the newest database backup      |
| `time-tracker.0.info.version` / `info.schemaVersion` / `info.dbSizeBytes` / `info.lastError`  | —       | instance information                       |
| `time-tracker.0.users.<id>.displayName`                                                       | string  | name of the employee                       |
| `time-tracker.0.users.<id>.hasOpenEntry`                                                      | boolean | employee is clocked in                     |
| `time-tracker.0.users.<id>.lastPunch`                                                         | number  | instant of the last punch of today         |
| `time-tracker.0.users.<id>.todayWorkedMinutes`                                                | number  | minutes worked today                       |
| `time-tracker.0.users.<id>.todayBalanceMinutes`                                               | number  | balance of today in minutes                |
| `time-tracker.0.users.<id>.openConflicts`                                                     | number  | punches waiting for a decision             |
| `time-tracker.0.commands.punchUserId`                                                         | number  | employee the punch commands apply to (`0` = the only one) |
| `time-tracker.0.commands.punch`                                                               | boolean | punch in or out (button)                   |
| `time-tracker.0.commands.quickPunch`                                                          | boolean | punch with the configured quick rounding   |
| `time-tracker.0.commands.closeMonth`                                                          | string  | close a month, value `YYYY-MM`             |
| `time-tracker.0.commands.recalc`                                                              | string  | recalculate a period, `YYYY-MM` or `YYYY`  |
| `time-tracker.0.commands.backup`                                                              | boolean | write a database backup (button)           |
| `time-tracker.0.users.<id>.monthWorkedMinutes` / `monthBalanceMinutes` / `yearBalanceMinutes` | number  | month and year figures                     |
| `time-tracker.0.company.presentCount`                                                         | number  | employees clocked in right now             |
| `time-tracker.0.company.present`                                                              | string  | their names, separated by a comma          |
| `time-tracker.0.company.openConflicts` / `company.lastPunch`                                  | number  | punches waiting for a decision, last punch |
| `time-tracker.0.events.lastAt` / `lastType` / `lastUser` / `lastDirection` / `lastSource`     | —       | newest event of the instance               |

### Commands (states)

A script, a Blockly block, a dashboard or another adapter drives the instance through states — no HTTP and no login
involved. The adapter writes such actions into the audit log as *system* (`actorId: 0`) and the log line says what
happened.

| State | Value | Effect |
| --- | --- | --- |
| `commands.punchUserId` | employee id, `0` = automatic | the employee the two punch buttons apply to |
| `commands.punch` | `true` | punches in or out — the direction comes from the punches of the day |
| `commands.quickPunch` | `true` | same, but the instant is rounded with *Round quick punches to minutes* |
| `commands.closeMonth` | `YYYY-MM` | closes the month (the log line reports balance and overtime) |
| `commands.recalc` | `YYYY-MM` or `YYYY` | recalculates the aggregates of that period |
| `commands.backup` | `true` | writes a database backup |

```js
setState("time-tracker.0.commands.punchUserId", 3);          // target employee (0 = the only one)
setState("time-tracker.0.commands.punch", true);             // punch in or out
setState("time-tracker.0.commands.quickPunch", true);        // punch with quick rounding
setState("time-tracker.0.commands.recalc", "2026-08");       // a month, or "2026" for a year
setState("time-tracker.0.commands.closeMonth", "2026-08");   // closing needs YYYY-MM
setState("time-tracker.0.commands.backup", true);            // write a backup now
```

Two things to know:

- **The buttons are stateless:** only `true` triggers them (every other value is ignored), and the adapter sets
  them back to `false` immediately — so never write `false` to “clock out”, use `punch` and let the adapter decide
  the direction.
- **Which employee?** The punch commands use the employee written into `commands.punchUserId`; the adapter mirrors
  the current choice back into that state on every refresh, and `0` means “the only employee”. With several
  employees and no choice the command refuses instead of guessing — the log then says
  `several employees exist - set command_punch_user_id or write users.<id> commands`.

Per employee, without any target: write `users.<id>.present` (`true` = clock in, `false` = clock out, idempotent —
see *First start*) or send a message (see *Messages (`sendTo`)* below).

Every command ends with a refreshed state tree (`users.*`, `company.*`, `events.*`), so a dashboard follows along.
A wrong period, an unknown or deactivated employee is answered with a warning in the adapter log — never with a
broken instance.

### Actions (trigger rules)

The ioBroker way of connecting hardware is a state: a fingerprint reader, a button, a door contact or a dashboard
writes it and the adapter does the rest. A rule is maintained in **Administration → Actions**:

| Field    | Meaning                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State    | the state of the other adapter, e.g. `fingerprint.0.lastMatch`                                                                                                  |
| Trigger  | _State carries the value_: the value has to equal _Value_ — or _Value is the employee_, where the value names the employee (id, login or shown name)            |
| Value    | the value that fires the rule (mode _State carries the value_) — `toggle` (or `*`) fires for **every** change, so a switch that goes on and off again works too |
| Employee | who is punched (mode _State carries the value_)                                                                                                                 |
| Action   | punch in or out, punch with the quick rounding, set to present, set to absent                                                                                   |
| Cooldown | seconds that have to pass before the rule may fire again                                                                                                        |

A rule fires only when the **value changes**, so a reader that repeats itself is harmless, and the cooldown keeps a
rapidly blinking state in check. Every punch appears in the audit trail with the note `trigger.<id>`, so its origin
stays traceable.

### Rules (automatic)

The adapter can act on its own as well — that table lives in **Administration → Settings**:

| Kind                    | What it does                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Clock out automatically | At the configured local time of the employee the open day is closed with a punch (note `auto.clockOut`) |
| Report a missing punch  | The same moment, but nothing is written — the instance only reports it                                  |
| Break reminder          | Reminds an employee whose running work block reached the configured length                              |

Every rule runs **at most once per employee and local date**; `automation_runs` holds that decision and doubles as
the log shown below the table. The events `automation.clockOut`, `automation.missingPunch` and
`automation.breakReminder` appear in `events.*` too, so a notification adapter can pick them up.

### Messages (`sendTo`)

A script, a Blockly block or another adapter drives the instance without HTTP:

```js
sendTo("time-tracker.0", "punch", { user: "anna", quick: true }, answer => log(answer.message));
sendTo("time-tracker.0", "present", { user: 2, present: false });
sendTo("time-tracker.0", "status", { user: "anna" }, answer => log(JSON.stringify(answer.data)));
sendTo("time-tracker.0", "report", { user: "anna", period: "2026-09", format: "pdf" }, answer =>
	writeFile("statement.pdf", Buffer.from(answer.data.base64, "base64")),
);
sendTo("time-tracker.0", "backup");
```

`user` is a user id, a login or the shown name. `report` answers with the file name, the MIME type and the file
itself as base64 (PDF or Excel), so it can be mailed or sent with a messenger adapter.

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

| Action     | What happens                                                             |
| ---------- | ------------------------------------------------------------------------ |
| Create now | writes a copy (`VACUUM INTO`) into the backup folder                     |
| Download   | hands the file to the browser                                            |
| Upload     | takes a downloaded file back, checks it and queues it for the next start |
| Restore    | queues one of the listed files for the next start (with a reason)        |
| Delete     | removes a single file after a confirmation                               |

A restore needs a closed database, so it is applied **while the adapter starts** — the app says so, and the previous
database is kept next to it as `<database>.before-restore-<time>`. Backups older than the retention of the instance
settings are removed automatically; the newest one always stays.

## HTTPS and reverse proxy

The app on a phone needs **HTTPS** — a service worker only runs on a secure origin. Put nginx or caddy in front of
the adapter and switch **Trust the reverse proxy** on: the adapter then takes the client address from
`x-forwarded-for` for the rate limits and the audit trail, and `x-forwarded-proto: https` makes the session cookie
`Secure`. Without that switch both headers are ignored, because any client could send them.

## Troubleshooting

| Problem                                | Cause and fix                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/` answers `404 not_found`            | the web app is missing: install the npm package or build it (`npm run install:pwa && npm run build:pwa`) |
| Not installable as an app on the phone | the page is not reachable over HTTPS — see above                                                         |
| The PDF refuses or shows empty boxes   | `report_font_path` is missing — see [Reports](#reports)                                                  |
| A restore seems to do nothing          | it is applied on the next start: restart the instance                                                    |
| An employee cannot log in              | the start password has to be changed on first use; the administration can set a new one                  |
| A punch is missing                     | it may wait in the offline queue or be marked as a conflict (see _Synchronisation_ in the app)           |

## Languages

The admin UI, the app and the reports ship in **11 languages** — `en` (base and fallback), `de`, `ru`, `pt`, `nl`,
`fr`, `it`, `es`, `pl`, `uk`, `zh-cn` — and every employee picks their own. Dates, numbers and units are formatted
with `Intl`. Further translations are welcome: [`docs/i18n.md`](docs/i18n.md).

## Privacy

Everything runs on your own ioBroker host: no cloud service, no telemetry. Punches and personal data stay in the
local SQLite file, access is role-based, and every correction is written to an audit trail.

## Documentation

| Document                                           | Content                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| [`docs/erste-schritte.md`](docs/erste-schritte.md) | a walk through the first setup (German)                  |
| [`docs/kurzfassung-de.md`](docs/kurzfassung-de.md) | the German summary of this README                        |
| [`docs/testplan.md`](docs/testplan.md)             | acceptance tests and what is still open                  |
| [`docs/entscheidungen.md`](docs/entscheidungen.md) | the decisions behind the design (German)                 |
| [`docs/technik.md`](docs/technik.md)               | internals: HTTP surface, sessions, live events, database |
| [`docs/entwicklung.md`](docs/entwicklung.md)       | build, tests, release                                    |
| [`docs/i18n.md`](docs/i18n.md)                     | how the 11 languages are kept complete                   |
| [`docs/adapter-check.md`](docs/adapter-check.md)   | the local pre-check of the ioBroker adapter rules        |

## Links

- Repository: https://github.com/sadam6752-tech/ioBroker.time-tracker
- Issues: https://github.com/sadam6752-tech/ioBroker.time-tracker/issues
- ioBroker forum: https://forum.iobroker.net/

## Changelog

### **WORK IN PROGRESS**

### 0.2.5 (2026-09-21)

- (Alex) docs: the installation chapter leads with the normal way now — install the npm package (`iobroker install
  iobroker.time-tracker` or the admin’s “Install from custom URL”), which creates the instance `time-tracker.0`
  automatically. Building from a checkout is only the developer path, and the chapter explains why a Git install
  reports `cannot find start file!` (`build/` and `www/` are not part of the repository)

### 0.2.4 (2026-09-21)

- (Alex) `commands.punchUserId` does what it promises now: writing an employee id selects the employee the punch
  buttons apply to (`0` = the only employee again), and the adapter mirrors the current choice back into the state.
  For the user the README has a new *Commands (states)* section and `docs/erste-schritte.md` explains all six command
  states — both with copy-ready examples and the two traps (buttons act on `true` only, a wrong period answers in the
  log)

### 0.2.3 (2026-09-20)

- (Alex) fix: a corrected object definition really reaches existing installations now — `ensureObject` merges the
  fields the adapter owns (`name`, `type`, `role`, `read`, `write`, `unit`) instead of only the name. An installation
  created before 0.2.2 kept its old `role: "value"` on `commands.punchUserId`, so the object structure check still
  reported `E1011`

### 0.2.2 (2026-09-20)

- (Alex) object structure check: every object name carries all **eleven languages** now (`E6001`) and the employee-id
  command uses the role **`level`** instead of `value` (`E1011`). The names live in one place
  (`src/lib/adapter/stateNames.ts`), a unit test keeps them complete, and existing installations receive the new
  names on the next start (`extendObject`)

### 0.2.1 (2026-09-20)

- (Alex) `common.news` starts fresh after the rename: the new npm package `iobroker.time-tracker` only carries 0.2.0,
  so the entries of 0.1.3 … 0.1.9 are removed again (the repository checker reports them as `E2004` — “do not exist
  at NPM”). The old release notes stay in this changelog; the history of the versions published under the former
  package name is noted in `CHANGELOG_OLD.md`

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
