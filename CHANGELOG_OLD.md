# Older changelog entries

The versions below were development milestones of this project and were never published on npm; the first
version published on npm is 0.0.4. `common.news` in `io-package.json` therefore only lists published versions.

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
