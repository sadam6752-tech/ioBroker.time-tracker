/**
 * Statistics screen: the figures of a date range, per employee and in total.
 *
 * The range defaults to the current month; the server recalculates every day of every employee, so it refuses
 * ranges longer than a year. Reading the figures of somebody else needs `report.statistics` plus
 * `report.view_other` — the server decides, the screen only shows what it gets.
 */

import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert, Loading } from "../components/feedback";

/**
 * Builds the first day of the current month.
 *
 * @returns date as `YYYY-MM-DD`
 */
function firstOfMonth(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Builds the last day of the current month.
 *
 * @returns date as `YYYY-MM-DD`
 */
function lastOfMonth(): string {
	const now = new Date();
	const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
	return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
}

/**
 * Formats minutes as hours with the units of the display language.
 *
 * @param minutes - value in minutes
 * @param language - language of the display
 * @returns formatted value, e.g. `7.5 h`
 */
function hours(minutes: number, language: string): string {
	return new Intl.NumberFormat(language, { style: "unit", unit: "hour", maximumFractionDigits: 2 }).format(
		minutes / 60,
	);
}

/**
 * Renders the statistics.
 *
 * @returns the screen
 */
export function Statistics(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const [from, setFrom] = useState(firstOfMonth);
	const [to, setTo] = useState(lastOfMonth);
	const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

	const report = useQuery({
		queryKey: ["statistics", from, to],
		queryFn: () => api.statistics(from, to),
		enabled: valid,
	});

	if (report.isLoading) {
		return (
			<AppShell title={t("nav.statistics")}>
				<Loading />
			</AppShell>
		);
	}

	/**
	 * Describes one row of the table.
	 *
	 * @param workedMin - worked minutes
	 * @param targetMin - target minutes
	 * @param balanceMin - balance in minutes
	 * @param openDays - days that are still open
	 * @returns the description
	 */
	const line = (workedMin: number, targetMin: number, balanceMin: number, openDays: number): string =>
		`${t("statistics.worked")} ${hours(workedMin, i18n.language)} · ${t("statistics.target")} ${hours(
			targetMin,
			i18n.language,
		)} · ${t("statistics.balance")} ${hours(balanceMin, i18n.language)} · ${t("statistics.openDays")} ${openDays}`;

	const totals = report.data?.totals;

	return (
		<AppShell title={t("nav.statistics")}>
			<ErrorAlert error={report.error} />

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
					>
						<TextField
							label={t("statistics.from")}
							value={from}
							onChange={event => setFrom(event.target.value)}
						/>
						<TextField
							label={t("statistics.to")}
							value={to}
							onChange={event => setTo(event.target.value)}
						/>
					</Stack>
				</CardContent>
			</Card>

			<Card>
				<List dense>
					{(report.data?.users ?? []).map(row => (
						<ListItem
							key={row.userId}
							divider
						>
							<ListItemText
								primary={row.displayName}
								secondary={line(row.workedMin, row.targetMin, row.balanceMin, row.openDays)}
							/>
						</ListItem>
					))}
					{totals && (
						<ListItem>
							<ListItemText
								primary={
									<Typography
										variant="body1"
										sx={{ fontWeight: 600 }}
									>
										{t("statistics.totals")}
									</Typography>
								}
								secondary={line(totals.workedMin, totals.targetMin, totals.balanceMin, totals.openDays)}
							/>
						</ListItem>
					)}
				</List>
			</Card>
		</AppShell>
	);
}
