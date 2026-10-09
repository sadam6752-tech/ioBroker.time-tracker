# src-www/ – progressive web app

React 18 + MUI 5 + Vite + React Query, service worker through Workbox, installable on smartphone and desktop, punching
that works offline with a sync queue. The build is written to `www/` and delivered by the adapter on the configured port
(see [`../src/lib/web/static.ts`](../src/lib/web/static.ts)).

**Interface to the adapter**

| What            | Where                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Static files    | `www/` in the package root; the adapter delivers them from the delivery root `/`                                                         |
| API             | always below the prefix `/api` (e.g. `POST /api/auth/login`), session in the header `x-session-token`, CSRF in the header `x-csrf-token` |
| Client routing  | unknown paths deliver `index.html` (fallback in the adapter), so **no** `HashRouter` is needed                                           |
| Base URL        | keep it relative (`base: "./"`), so that the app also runs as a web extension below a sub path                                           |

**Commands** (in the adapter root)

```bash
npm run install:pwa     # dependencies of the PWA (own node_modules)
npm run build:pwa       # type check + Vite build into www/
npm run dev:pwa         # development server on :5173, /api is forwarded to the instance (127.0.0.1:8092)
npm run lint:pwa        # ESLint with the same rules as the adapter
```

Without `www/` the adapter keeps running and offers only the API; the tests of the delivery (`src/lib/web/pwa.test.ts`)
are skipped then.

**Structure**

| Path                      | Content                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/api/client.ts`       | REST client: session in `localStorage`, CSRF header, problem documents as `ApiError` with a stable code    |
| `src/api/types.ts`        | answer shapes of the API (mirror of the JSON: times in UTC seconds, durations in minutes)                  |
| `src/offline/queue.ts`    | queue in `localStorage`, every punch with a UUID as `idempotencyKey`                                       |
| `src/offline/useSync.tsx` | sends the queue through `POST /api/entries/sync`, reacts to `online`/`offline`                             |
| `src/state/session.tsx`   | sign-in, permissions (display only – the server decides), language of the user                             |
| `src/screens/`            | login, dashboard (punching), month, reports, absences, sync, profile, administration, info                 |
| `src/i18n/`               | 11 language files; **the base is `en.json`**, add new texts only there and then run `npm run translate`   |

**Offline behaviour:** Pressing the punch button writes to the local queue first and sends at once; without a network the
entry stays and is sent at the next `online` event (or through the button on the sync screen). The server recognises
repetitions by the `idempotencyKey`, conflicts land in `GET /api/entries/conflicts` and are decided there.

**Clean room:** no code and no identifiers from other projects (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

Binding details (endpoints, field names, error codes) are in the internal specification, which lives outside this
repository and is not published.
