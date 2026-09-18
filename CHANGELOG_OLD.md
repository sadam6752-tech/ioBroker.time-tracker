# Older changelog entries

The README keeps the last five versions; everything older is listed here — the published versions from 0.0.4 on
as well as the development milestones before the first npm publication.

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
