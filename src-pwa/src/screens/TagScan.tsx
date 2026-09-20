/**
 * Badge scan screen.
 *
 * A badge or NFC tag carries a link `/?tag=<token>`. That link is opened on the phone, the screen below redeems
 * it and shows the result. It sits **outside** the login guard on purpose: the tag proves itself — its signature
 * is checked on the server — so a scan works without a session, exactly like the kiosk screen.
 *
 * The token is taken out of the address bar immediately and remembered for the running browser session, so a
 * reload does not punch a second time.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, formatTime, type ScanResult } from "../api/client";
import { errorKey } from "../components/feedback";

/** Where the scanned token is remembered for the running browser session. */
const STORAGE_KEY = "time-tracker.scan";

/**
 * Reads the token of the scanned tag: from the URL or from this browser session.
 *
 * @returns the token or `null`
 */
function readTagToken(): string | null {
	const params = new URLSearchParams(window.location.search);
	const fromUrl = params.get("tag");
	if (fromUrl?.trim()) {
		try {
			window.sessionStorage.setItem(STORAGE_KEY, fromUrl.trim());
		} catch {
			// storage may be forbidden; the token is still in the hand of this page
		}
		params.delete("tag");
		const rest = params.toString();
		window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
		return fromUrl.trim();
	}
	try {
		return window.sessionStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/**
 * Renders the badge scan.
 *
 * @returns the scan screen
 */
export function TagScan(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const token = useRef(readTagToken());
	const [result, setResult] = useState<ScanResult | null>(null);
	const [problem, setProblem] = useState<unknown>(null);
	const [started, setStarted] = useState(false);

	useEffect(() => {
		if (started) {
			return;
		}
		setStarted(true);
		void (async () => {
			try {
				setResult(await api.scanTag(token.current ?? ""));
			} catch (error) {
				setProblem(error);
			}
		})();
	}, [started]);

	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	return (
		<Box sx={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", p: 2 }}>
			<Card sx={{ maxWidth: 520, width: "100%" }}>
				<CardContent>
					<Typography
						variant="h6"
						gutterBottom
					>
						{t("scan.title")}
					</Typography>

					{!result && !problem && (
						<Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
							<CircularProgress size={20} />
							<Typography>{t("common.loading")}</Typography>
						</Box>
					)}

					{result && (
						<Alert severity="success">
							{t("scan.done", {
								name: result.user?.displayName ?? "",
								time: formatTime(result.entry?.tsUtc ?? null, timeZone, i18n.language),
							})}
						</Alert>
					)}

					{problem ? (
						<Alert severity="error">{t("scan.failed", { reason: t(errorKey(problem)) })}</Alert>
					) : null}

					<Button
						sx={{ mt: 2 }}
						variant="contained"
						href="/"
					>
						{t("nav.dashboard")}
					</Button>
				</CardContent>
			</Card>
		</Box>
	);
}
