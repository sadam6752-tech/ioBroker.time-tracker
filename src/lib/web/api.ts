/**
 * REST API of the adapter.
 *
 * The endpoints are registered on the server agnostic router, so the same table can later be mounted on an own
 * HTTP server (`native.port`) or handed to the web extension of a `web` instance.
 *
 * Conventions:
 *  - the paths follow the API specification (section 4): `/auth/...`, `/punch...`, `/entries...`, `/absences...`,
 *    `/aggregates/{day,month,year}`; the server mounts all of them below the prefix `/api`;
 *  - the session token travels in the `x-session-token` header, the CSRF token in `x-csrf-token`;
 *  - `?userId=` selects another employee and requires the matching `…_other` permission (otherwise the caller
 *    only sees their own data);
 *  - every write answers with the stored record and, where it matters, with the refreshed aggregates;
 *  - reads recalculate the requested period, so a report is always up to date.
 *
 * The routes live in `routes/`, one module per area; this file puts them together.
 */

import { json } from "./router";
import { createApiContext } from "./routes/context";
import type { Api, ApiDeps } from "./routes/shared";
import { registerAuthRoutes } from "./routes/auth";
import { registerTimeRoutes } from "./routes/time";
import { registerAbsenceRoutes } from "./routes/absences";
import { registerSettingsRoutes } from "./routes/settings";
import { registerCorrectionRoutes } from "./routes/corrections";
import { registerUserRoutes } from "./routes/users";
import { registerPayoutRoutes } from "./routes/payouts";
import { registerStatisticsRoutes } from "./routes/statistics";
import { registerTerminalRoutes } from "./routes/terminal";
import { registerRfidRoutes } from "./routes/rfid";
import { registerReportRoutes } from "./routes/reports";
import { registerBackupRoutes } from "./routes/backup";

export {
	MAX_BACKUP_UPLOAD_BYTES,
	type Api,
	type ApiDeps,
	type ApiRoute,
	type PublicTerminalPayload,
	type PublicUserPayload,
} from "./routes/shared";

/**
 * Creates the API.
 *
 * The router takes the first route that matches, so the modules are called in the order their routes were
 * written; moving one in front of another can change which route answers a request.
 *
 * @param deps - data sources
 * @returns router, route table and event bus
 */
export function createApi(deps: ApiDeps): Api {
	const ctx = createApiContext(deps);
	const { route, settings, now, registered } = ctx;

	registerAuthRoutes(ctx);
	registerTimeRoutes(ctx);
	registerAbsenceRoutes(ctx);
	registerSettingsRoutes(ctx);
	registerCorrectionRoutes(ctx);
	registerUserRoutes(ctx);
	registerPayoutRoutes(ctx);
	registerStatisticsRoutes(ctx);
	registerTerminalRoutes(ctx);
	registerRfidRoutes(ctx);
	registerReportRoutes(ctx);
	registerBackupRoutes(ctx);

	// system

	route("GET", "/health", { public: true }, () =>
		json(200, {
			status: "ok",
			holidayCountry: settings.get("holiday_country") ?? "DE",
			time: now(),
		}),
	);

	route("GET", "/routes", { public: true }, () => json(200, { routes: registered }));

	return { router: ctx.router, routes: () => registered.slice(), events: ctx.events };
}
