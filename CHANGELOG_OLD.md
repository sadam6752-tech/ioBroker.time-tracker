# Older changelog entries

The README keeps the last five versions; everything older is listed here — the published versions from 0.0.4 on
as well as the development milestones before the first npm publication.

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
