# Older changelog entries

The README keeps the last five versions; everything older is listed here — the published versions from 0.0.4 on
as well as the development milestones before the first npm publication.

Versions up to 0.1.9 were published as the npm package `iobroker.zeiterfassung`. Since 0.2.0 the adapter is called
`ioBroker.time-tracker`, because ioBroker requires English adapter names (see the 0.2.0 entry in the README). The
`common.news` list therefore starts with 0.2.0 — the older entries would be reported as `E2004` (“do not exist at
NPM”), as they only exist under the former package name.

### 0.4.4 (2026-09-23)

- (Alex) fix: the browser tests moved from `e2e/` to `test/e2e/`. The repository checker looks at the imported
  packages of the sources and skips the `test` directory only, so `@playwright/test` (a dev dependency that the specs
  use) was reported as `W5042` “used but not found in dependencies”. `playwright.config.ts`, the e2e workflow and the
  docs follow the new path, the test server computes the repository root one level deeper, and the root
  `tsconfig.json` leaves the browser tests to their own `test/e2e/tsconfig.json` — they need the DOM types the
  adapter does not have

### 0.4.3 (2026-09-22)

- (Alex) change: “active” of an absence type now reads “**visible for everybody**” and means exactly that. Switched on,
  the employees pick the type in the app and request it (vacation, further training); switched off, the type belongs to
  the administration alone (sickness, accident, military service — such a note reaches a company on the same day and is
  booked, not requested). The server refuses an employee a type that is not public (`403`), the administration sees
  every type in its own lists, and sickness, accident and military service start switched off (migration 22)

### 0.4.2 (2026-09-22)

- (Alex) fix: the roles appear in the language of the display (the database keeps “Administrator”, “Manager” and
  “Employee”, the app translates them now), the two date fields of “enter an absence” no longer overlap with their
  label, an absence type can be removed again as long as no absence uses it (new `DELETE /absence-types/:id` with a
  confirmation that names the type), and an inactive type stays in the lists of the administration while the employees
  no longer see it in their picker (`GET /absence-types?includeInactive=true`)

### 0.4.1 (2026-09-22)

- (Alex) docs: the installation chapter no longer carries the build steps for work on the sources — they live in
  `CONTRIBUTING.md` and `docs/entwicklung.md`, so the README stays a manual for users

### 0.4.0 (2026-09-22)

- (Alex) new: the administration decides about absences. A request of an employee waits as `requested` and counts for
  nothing until somebody approves or rejects it — the new tab **Abwesenheiten** shows the open requests (with a reason
  for the decision), lets the administration enter dates for an employee (approved right away) and answers “who is
  away”. Only approved days reach the working time and the vacation balance, the state of a request is marked in the
  app and a rejection carries its reason back (migration 21, `POST /absences/:id/approval`)

### 0.3.4 (2026-09-22)

- (Alex) feat: the absence types can be maintained in the admin now — one row per type and the form in a dialog, with
  code, name, paid, factor and the vacation deduction. The type that uses up the vacation allowance is marked in the
  lists and in the picker, so “F – Ferien” reads as vacation at one glance

### 0.3.3 (2026-09-22)

- (Alex) fix: the installation chapter no longer points to the dialog that installs an adapter from a URL — the
  repository checker reports that as `E6013` (“suggests to install the adapter directly from GitHub, directly from npm
  or using npm commands”). It now leads with the normal way through the adapter list of the ioBroker admin, names the
  registry for a machine without the admin and keeps the build steps in a clearly marked note for work on the sources.
  The troubleshooting row for a missing web app no longer carries npm commands either

### 0.3.2 (2026-09-22)

- (Alex) fix: the automation rules are a **list** now — one row per rule with its caption, kind, time, target and
  weekdays, plus the buttons for *active*, *edit* and *delete* on the right. The form only opens in a dialog, for a
  new or an edited rule, so the list stays readable. The save button of the card says “**Regeln speichern**” (it
  carried the caption of the break rules before). New texts in all 11 languages, and an end-to-end test keeps both
  findings

### 0.3.1 (2026-09-22)

- (Alex) fix: the presence board shows the **real running** time of the day now. Two things kept it frozen:
  `/terminal/users` answered with the stored day aggregate, which only changes on a punch (it counts finished
  pairs), and the tile “ticker” measured the seconds since the last server answer — a refresh every 60 s never let
  it grow beyond 0. The API adds the minutes of an open punch to its answer now, the tile shows that value directly,
  and the board refreshes every 20 s (was 60 s). The API test moves the clock ten minutes and expects the open punch
  in the answer

### 0.3.0 (2026-09-22)

- (Alex) new: the presence board can show the working time of today on the employee tiles — `1:23` next to
  `Present`/`Away` (`0:00` before the first punch), and the tile keeps counting while the employee is present. It is
  switched on **per employee** in the work profile (*Arbeitszeit auf der Anwesenheitskarte*, off by default), because
  the board is visible before the PIN is entered — the decision is made on the server, the API only sends the minutes
  for employees who agreed (`/terminal/users` and `/terminal/punch`). The new column
  `work_profiles.show_worked_time` arrives with migration 20

### 0.2.7 (2026-09-22)

- (Alex) fix: **every** punch path reaches `events.*` and the web app now. Besides the presence state (0.2.6) the
  `commands.punch`/`quickPunch` buttons, a `sendTo` message (`punch`, `present`) and the trigger rules (Actions) wrote
  the punch and refreshed the figures but never published an event — the event states kept the punch before. The
  results carry `userId` and `direction` now, and `punchEvent` (like `presenceEvent`) builds the bus event for them;
  the automation rules send the direction with their `automation.*` event
- (Alex) test: the end-to-end suite is deterministic again — the correction spec anchors its “forgotten day” inside the
  local day (`now - 8h` fell on the day before when the suite ran shortly after midnight and left the employee
  present for the specs that follow), and the presence spec puts its employee into a known state before it asserts

### 0.2.6 (2026-09-22)

- (Alex) fix: a punch from the presence state (`users.<id>.present`) is published like every other one now — it shows
  up in `events.*` (`lastType`, `lastUser`, `lastDirection`, `lastSource`) and reaches the web app live. The punch was
  stored in the database but never sent to the event bus, so the event states kept the previous punch

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

### 0.2.0 (2026-09-20)

- (Alex) **renamed to `ioBroker.time-tracker`**: ioBroker requires English adapter names, so the adapter, its npm
  package and the GitHub repository are called `time-tracker` from now on. The instance id becomes `time-tracker.0`
  and the database is created as `time-tracker.sqlite` — existing installations keep their data by pointing
  “Database file” at the old file or by renaming it (before 0.2.0 it was `zeiterfassung.sqlite`). German UI texts
  stay German; `common.titleLang` keeps all 11 languages

### 0.1.9 (2026-09-19)

- (Alex) ioBroker repository: two findings of the repository checker are fixed — `common.title` is removed (it is
  deprecated, `common.titleLang` replaced it, E1084) and the `common.news` entry of 0.1.7 is gone, because that version
  never reached npm (E2004, its pipeline was red). `npm run version:check` watches both rules from now on: it refuses
  `common.title` and every version in the news list has to exist on npm

### 0.1.8 (2026-09-19)

- (Alex) fix: the pipeline of 0.1.7 failed in the ioBroker package test — `common.license` was added next to the
  existing `common.licenseInformation`, and the test refuses both together (“common.license should not exist together
  with common.licenseInformation”). The field is removed again, `npm run test:package` is part of the release checklist
  from now on, and `docs/entwicklung.md` records the rule

### 0.1.7 (2026-09-19)

- (Alex) ioBroker repository: `common.title` was missing in `io-package.json` and is set now (“Time tracking”);
  `docs/entwicklung.md` explains the checker warnings that come from the web app having its own `package.json` (the
  adapter itself does not load any of it)

### 0.1.6 (2026-09-19)

- (Alex) admin: the raw instance settings show a readable label now — in the language of the display — with the
  technical name in the small line below it, which is what the block promises. The labels are kept short enough that
  the fields do not cut them off
- (Alex) admin: the block “All instance settings” is much shorter — three fields per line on a wide screen (two on a
  tablet, one on a phone) and the time zone on a line of its own, because its value is the longest
- (Alex) **rules (automatic)**: the kind **“Clock in automatically”** joins them — an employee who is still missing at
  the configured time gets a punch in (the rule keeps quiet when somebody is clocked in already). Migration 18 rebuilds
  the rule table for the new kind and copies the run log first, because dropping the parent would take it with it
- (Alex) **holidays**: the seeded days are shown in the language of the display — each one carries a stable key
  (`newYear`, `goodFriday`, …) and the app translates it; a day somebody added by hand keeps its own name
- (Alex) admin: the two “first start” hints are easier to read — they are rendered as HTML with a larger font

### 0.1.5 (2026-09-19)

- (Alex) **rules (automatic)**: a rule can be limited to **weekdays** (Monday to Friday for a company rule, the
  weekend for another) and it can be set to act **once a week** instead of once a day — the guard counts the ISO week
  then, so a reminder that fires every Monday still fires next Monday. The days come from `Intl`, so their names are
  spelled in the language of the display
- (Alex) **badges (RFID/NFC)**: the link of a fresh badge is shown as a **QR code** next to the link itself, so it can
  be scanned or copied onto a tag with a writer app. The code is drawn in the browser (the `qrcode` package is bundled
  with the web app), so it works offline and no service ever sees the link
- (Alex) docs: `docs/i18n.md` now records who settles the translations — German and Russian are kept by the owner, for
  the other nine languages no native speaker is available, so they stay machine translation with the technical pass

### 0.1.4 (2026-09-18)

- (Alex) **badges (RFID/NFC)**: a badge can be edited (employee, label, validity) and given a **new link** — for one
  that was lost, expired or revoked and should work again. A new employee or a new validity re-signs the link, so the
  answer carries it and the link handed out before stops working immediately (a label on its own leaves it alone)
- (Alex) translations: a second technical pass, this time with a helper (`tools/check-i18n-review.mjs`) that looks for
  what `check:i18n` cannot see — wrong script, copies between languages, texts much longer or shorter than English.
  It found real gaps: `brandingHint` had lost its second sentence in nine languages, `brandColorHint` its “empty for
  the default” in seven, and `admin.user.pinTitle` was a Russian sentence in the Ukrainian file. `docs/i18n.md` lists
  what stays with a native speaker

### 0.1.3 (2026-09-18)

- (Alex) fix: the badge (RFID/NFC) tab builds the link from the address the administration is **currently** open
  with — scheme, host and port come from the browser, so the link works on a plain HTTP instance and behind a reverse
  proxy alike, and no server side guess can point at a scheme the instance does not serve
- (Alex) fix: the badge (RFID/NFC) tab shows the state of every badge — active, expired or revoked — and when it was
  last used. A revoked badge now offers “Remove permanently” instead of failing with “not found”: the old entry
  disappears from the list, while the audit trail keeps the trace of it
- (Alex) translations: a technical review pass over the 11 languages — the punch, break, absence, badge and overtime
  text families were compared with each other. Five wrong `reports.overtime` labels were corrected (`pt`, `fr`, `it`,
  `es`, `zh-cn` said “over time” instead of overtime), and the Polish punch labels now use the same root as the badge
  texts. `docs/i18n.md` records the method and what a native speaker still has to settle

### 0.1.2 (2026-09-18)

- (Alex) fix: a badge (RFID/NFC) link points to the address the administration itself is reached with — the scheme
  comes from the request (and from a trusted reverse proxy) instead of a fixed `https://` that pointed nowhere on a
  plain HTTP instance. A badge created before only needs the right prefix, the token in it stays valid
- (Alex) **rules (automatic)**: the adapter can clock out at a local time, report a missing punch or remind about a
  break — maintained in **Administration → Settings** (`GET`/`PUT /api/automation-rules` and the run log
  `GET /api/automation-rules/runs`), at most once per employee and day, with the events `automation.*` in the state
  tree so a notification can pick them up

### 0.1.1 (2026-09-18)

- (Alex) fix: the tab “Badges (RFID/NFC)” creates a badge again — the HMAC secret that signs the links is generated
  on the first start and stored next to the database (like the session secret) instead of refusing the request with
  “not configured”
- (Alex) the hint above the actions names `toggle` now: with that value a rule fires on **every** change, so a
  switch that goes on and off again works too
- internal: the automation rules are in place (migration 16 with `automation_rules` and `automation_runs`, the
  repository with its “once a day per employee” guard, the pure decision logic, the minute check in the adapter and
  the events `automation.clockOut`/`missingPunch`/`breakReminder`) — the administration, the API and the texts follow

### 0.1.0 (2026-09-18)

- (Alex) fix: a trigger rule fires for **every change** when its value is `toggle` (or `*`) — a switch that goes
  from `true` to `false` punches too, the fixed value only reacted in one direction. The field in the
  administration names that now
- (Alex) fix: the published figures follow a punch from the web app within a second — the API of the same process
  reports every change (punch, correction, badge, absence) over the event bus and the adapter republishes the
  states instead of waiting for the five minute timer. That is what made `users.<id>.present` and
  `company.presentCount` lag behind

### 0.0.19 (2026-09-18)

- internal: the browser tests wait longer for the slower runner of the pipeline and put the branding back when the
  file is done, so it can run again and in any order; the end-to-end workflow uses the current majors of
  `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` (the old ones still target Node 20, which
  the runner deprecates)

- (Alex) ioBroker comfort: **actions** (trigger rules) — a state of another adapter like a fingerprint reader, a
  button or a door contact punches or sets the presence. The table lives in the administration
  (`GET`/`PUT /api/trigger-rules`), a rule fires only when the value changes and honours a cooldown, and every
  punch carries the note `trigger.<id>` in the audit trail
- (Alex) **`sendTo` messages** — `punch`, `present`, `status`, `report` (PDF or Excel as base64) and `backup`, so a
  script or a Blockly block drives the instance without HTTP
- (Alex) more states for dashboards and notifications: `company.presentCount`/`present`/`openConflicts`/`lastPunch`,
  per employee `monthWorkedMinutes`/`monthBalanceMinutes`/`yearBalanceMinutes` and `events.lastAt`/`lastType`/
  `lastUser`/`lastDirection`/`lastSource`

### 0.0.18 (2026-09-18)

- (Alex) fix: an uploaded background picture can be taken away again — every picture field has a “Remove picture”
  button (the logo as well), and “Default” resets the colour and the background picture in one click
- internal: the settings dialog shows the stored logo and background picture again (a read leaves the large pictures
  out on purpose, so the preview and the remove button come from the branding route)
- (Alex) internal: the release flow asks the owner before the version commit and the tag — the question “may I push,
  or do you have remarks?” comes first and only a “go” leads to commit, tag and push; `CONTRIBUTING.md` documents
  the step and `npm run push:approve` reminds of it
- internal: the lint ignores the generated report of the browser tests (it carried a bundled viewer and made a local
  `npm run lint` crash)

### 0.0.17 (2026-09-18)

- (Alex) fix: the **background colour** of the branding is visible again when a background picture is set — the
  colour now tints the veil in front of the picture instead of hiding behind it, and the suggestions have a second,
  darker block of shades (the colour field and the “default” button work as before)
- (Alex) internal: `npm run version:check` watches the two lists now as well — `common.news` may keep at most seven
  entries (the ioBroker repository builder truncates at seven, finding E1032) and the README changelog at most five
  versions; it also names a version that is in neither the README nor `CHANGELOG_OLD.md`

### 0.0.16 (2026-09-17)

- (Alex) internal: the linter is clean — the 31 missing JSDoc comments are written (fields of inline types and the
  `createApi` entry point, which had no comment at all), and `npm run lint` refuses warnings from now on, so the
  list cannot grow back
- (Alex) internal: `CONTRIBUTING.md` documents the release flow — after a green workflow wait another 5 to 10
  minutes before checking npm (measured: green run 17:37, npm 17:42), and never delete and re-push the tag of a
  published version (it removes the GitHub release and npm refuses the second publication)

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

### 0.0.3 (2026-09-16)

- (Alex) fix: the integration tests read the version from `package.json`, so a version bump cannot break them

### 0.0.2 (2026-09-16)

- (Alex) project scaffolding: adapter skeleton (TypeScript + jsonConfig), 11-language metadata, admin configuration fields, CI workflow (@iobroker/testing, Node 22/24/26), i18n checks
- (Alex) kiosk terminals: employees per device, optional PIN duty per device, on-screen keypad, presence screen with pictures
- (Alex) branding: company logo, background picture and accent colour for the web app and the kiosk (scaled down in the browser, delivered through cacheable routes)
- (Alex) session secret: generated once and stored next to the database when the instance settings do not define one
- (Alex) fixes from the first field test: large picture uploads (body limit), terminals without PIN duty, integration tests on a free port

### 0.0.1

- initial release (not published yet)
