/**
 * Dashboard: current status, punch button and the figures of the day.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import LoginIcon from "@mui/icons-material/Login";
import LogoutIcon from "@mui/icons-material/Logout";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatMinutes, formatTime } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert } from "../components/feedback";
import { hasPermission, useSession } from "../state/session";
import { useSync } from "../offline/useSync";

/**
 * Shows the punch button and the figures of the day.
 *
 * @returns the dashboard
 */
export function Dashboard(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { session, permissions } = useSession();
	const { pending, record, outcome } = useSync();
	const queryClient = useQueryClient();
	const [note, setNote] = useState("");
	const [queued, setQueued] = useState(false);
	/** The administrator account belongs to nobody and does not punch (`time.punch`). */
	const mayPunch = hasPermission(permissions, "time.punch");

	const timeZone = session?.user.timezone ?? "UTC";
	const status = useQuery({ queryKey: ["status"], queryFn: () => api.status(), enabled: mayPunch });

	// after a successful synchronisation the figures and the status are stale
	useEffect(() => {
		if (outcome) {
			void queryClient.invalidateQueries({ queryKey: ["status"] });
		}
	}, [outcome, queryClient]);

	/**
	 * Records the next punch.
	 *
	 * @param quick - true to use the quick rounding of the instance
	 */
	function punch(quick: boolean): void {
		record({ tsUtc: Math.floor(Date.now() / 1000), ...(note ? { note } : {}), quick });
		setNote("");
		setQueued(true);
	}

	const data = status.data;
	const open = data?.hasOpenEntry ?? false;

	// an account without the punch right administers the employees: it has no working time of its own
	if (!mayPunch) {
		return (
			<AppShell title={t("nav.dashboard")}>
				<Card>
					<CardContent>
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("dashboard.adminOnly")}
						</Typography>
					</CardContent>
				</Card>
			</AppShell>
		);
	}

	return (
		<AppShell title={t("nav.dashboard")}>
			<ErrorAlert error={status.error} />
			{queued && pending.length > 0 && <Alert severity="warning">{t("punch.queued")}</Alert>}

			<Card sx={{ mb: 3 }}>
				<CardContent>
					<Typography
						variant="h6"
						component="p"
						gutterBottom
					>
						{open
							? t("punch.open", {
									time: formatTime(data?.lastEntry?.tsUtc ?? null, timeZone, i18n.language),
								})
							: t("punch.closed")}
					</Typography>
					{data?.lastEntry && (
						<Typography
							variant="body2"
							color="text.secondary"
							gutterBottom
						>
							{t("punch.last", {
								time: formatTime(data.lastEntry.tsUtc, timeZone, i18n.language),
							})}
						</Typography>
					)}

					<Stack
						spacing={2}
						sx={{ mt: 2 }}
					>
						<TextField
							label={t("punch.note")}
							value={note}
							size="small"
							onChange={event => setNote(event.target.value)}
						/>
						<Button
							variant="contained"
							size="large"
							startIcon={data?.nextDirection === "out" ? <LogoutIcon /> : <LoginIcon />}
							disabled={status.isLoading}
							onClick={() => punch(false)}
						>
							{data?.nextDirection === "out" ? t("punch.out") : t("punch.in")}
						</Button>
						<Button
							variant="outlined"
							onClick={() => punch(true)}
							disabled={status.isLoading}
						>
							{t("punch.quick")}
						</Button>
					</Stack>
				</CardContent>
			</Card>

			<Grid
				container
				spacing={2}
			>
				<Grid
					item
					xs={12}
					sm={4}
				>
					<Card>
						<CardContent>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("punch.worked")}
							</Typography>
							<Typography variant="h5">{formatMinutes(data?.day.workedMin ?? 0)}</Typography>
						</CardContent>
					</Card>
				</Grid>
				<Grid
					item
					xs={12}
					sm={4}
				>
					<Card>
						<CardContent>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("punch.target")}
							</Typography>
							<Typography variant="h5">{formatMinutes(data?.day.targetMin ?? 0)}</Typography>
						</CardContent>
					</Card>
				</Grid>
				<Grid
					item
					xs={12}
					sm={4}
				>
					<Card>
						<CardContent>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("punch.balance")}
							</Typography>
							<Typography
								variant="h5"
								color={(data?.day.balanceMin ?? 0) < 0 ? "error" : "text.primary"}
							>
								{formatMinutes(data?.day.balanceMin ?? 0)}
							</Typography>
						</CardContent>
					</Card>
				</Grid>
			</Grid>

			<Box sx={{ mt: 2 }}>
				<Button
					variant="text"
					onClick={() => void status.refetch()}
					disabled={status.isFetching}
				>
					{t("common.refresh")}
				</Button>
			</Box>
		</AppShell>
	);
}
