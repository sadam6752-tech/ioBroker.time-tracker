/**
 * Info page of the administrator: the version of the web app and of the adapter.
 *
 * The two are released together, but they can part for a while: the browser keeps the app in its cache and may
 * still show the old one after the adapter was updated. The page tells that and offers the way out.
 */

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { AppShell } from "../components/AppShell";
import { Disclaimer } from "../components/Disclaimer";
import { ErrorAlert, Loading } from "../components/feedback";
import { hasPermission, useSession } from "../state/session";

/** Where the sources and the documentation of the adapter are. */
const REPOSITORY_URL = "https://github.com/sadam6752-tech/ioBroker.time-tracker";

/**
 * Loads the app again, without the copy the browser keeps: the service worker and its caches are removed first.
 *
 * @returns nothing; the page is replaced
 */
async function reloadFresh(): Promise<void> {
	try {
		const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
		await Promise.all(registrations.map(registration => registration.unregister()));
		const names = (await globalThis.caches?.keys()) ?? [];
		await Promise.all(names.map(name => globalThis.caches.delete(name)));
	} finally {
		globalThis.location.reload();
	}
}

/**
 * The page "Info": versions of the app and of the adapter.
 *
 * @returns the page
 */
export function Info(): React.JSX.Element {
	const { t } = useTranslation();
	const { permissions } = useSession();
	const allowed = hasPermission(permissions, "settings.edit");
	const info = useQuery({ queryKey: ["system", "info"], queryFn: () => api.systemInfo(), enabled: allowed });

	if (!allowed) {
		return (
			<AppShell title={t("info.title")}>
				<Alert severity="info">{t("admin.forbidden")}</Alert>
			</AppShell>
		);
	}

	const appVersion = __APP_VERSION__;
	const adapterVersion = info.data?.version;
	const differs = adapterVersion !== undefined && adapterVersion !== appVersion;

	return (
		<AppShell title={t("info.title")}>
			<ErrorAlert error={info.error} />
			{info.isLoading && <Loading />}
			{info.data && (
				<Card>
					<CardContent>
						<Stack spacing={2}>
							<Stack spacing={0.5}>
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{t("info.app")}
								</Typography>
								<Typography id="info-app-version">{appVersion}</Typography>
							</Stack>
							<Stack spacing={0.5}>
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{t("info.adapter")}
								</Typography>
								<Typography id="info-adapter-version">{adapterVersion}</Typography>
							</Stack>
							{differs ? (
								<Alert
									severity="warning"
									action={
										<Button
											color="inherit"
											size="small"
											onClick={() => void reloadFresh()}
										>
											{t("info.reload")}
										</Button>
									}
								>
									{t("info.mismatch")}
								</Alert>
							) : (
								<Alert severity="success">{t("info.same")}</Alert>
							)}
							<Link
								href={REPOSITORY_URL}
								target="_blank"
								rel="noopener noreferrer"
							>
								{t("info.source")}
							</Link>
							<Disclaimer />
						</Stack>
					</CardContent>
				</Card>
			)}
		</AppShell>
	);
}
