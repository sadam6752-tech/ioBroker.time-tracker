/**
 * Reports: the months of a year and the totals of the year.
 */

import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api, formatMinutes } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert, Loading } from "../components/feedback";
import { hasPermission, useSession } from "../state/session";

/**
 * Shows the monthly and yearly figures.
 *
 * @returns the reports screen
 */
export function Reports(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const [year, setYear] = useState(() => new Date().getFullYear());
	const { permissions } = useSession();
	const maySeePayouts = hasPermission(permissions, "payout.view");
	const report = useQuery({
		queryKey: ["months", year],
		queryFn: () => api.months(year),
	});
	// the endpoint needs `payout.view`, so it is only asked for when the right is granted
	const payouts = useQuery({
		queryKey: ["payouts", year],
		queryFn: () => api.payouts(year),
		enabled: maySeePayouts,
		retry: false,
	});

	const months = report.data?.months ?? [];
	const monthName = (month: number): string =>
		new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(
			new Date(Date.UTC(year, month - 1, 15)),
		);

	return (
		<AppShell title={t("reports.title")}>
			<Card sx={{ mb: 2 }}>
				<Stack
					direction="row"
					alignItems="center"
					justifyContent="space-between"
					sx={{ p: 1 }}
				>
					<IconButton
						onClick={() => setYear(value => value - 1)}
						title={t("month.previous")}
					>
						<ChevronLeftIcon />
					</IconButton>
					<Typography variant="h6">
						{t("reports.year")} {year}
					</Typography>
					<IconButton
						onClick={() => setYear(value => value + 1)}
						title={t("month.next")}
					>
						<ChevronRightIcon />
					</IconButton>
				</Stack>
			</Card>

			<ErrorAlert error={report.error} />
			{report.isLoading ? (
				<Loading />
			) : (
				<>
					<Grid
						container
						spacing={2}
						sx={{ mb: 2 }}
					>
						<Grid
							item
							xs={6}
						>
							<Card>
								<CardContent>
									<Typography
										variant="body2"
										color="text.secondary"
									>
										{t("reports.yearTotals")}
									</Typography>
									<Typography variant="h5">
										{formatMinutes(report.data?.year.workedMin ?? 0)}
									</Typography>
									<Typography
										variant="body2"
										color="text.secondary"
									>
										{t("month.target")}: {formatMinutes(report.data?.year.targetMin ?? 0)}
									</Typography>
								</CardContent>
							</Card>
						</Grid>
						<Grid
							item
							xs={6}
						>
							<Card>
								<CardContent>
									<Typography
										variant="body2"
										color="text.secondary"
									>
										{t("reports.overtime")}
									</Typography>
									<Typography
										variant="h5"
										color={(report.data?.year.overtimeMin ?? 0) < 0 ? "error" : "text.primary"}
									>
										{formatMinutes(report.data?.year.overtimeMin ?? 0)}
									</Typography>
									<Typography
										variant="body2"
										color="text.secondary"
									>
										{t("reports.vacation", {
											used: report.data?.year.vacationUsed ?? 0,
											total:
												(report.data?.year.vacationCarryover ?? 0) +
												(report.data?.year.vacationDays ?? 0),
										})}
									</Typography>
									{maySeePayouts && (
										<Typography
											variant="body2"
											color="text.secondary"
										>
											{t("reports.paidOut", {
												minutes: formatMinutes(payouts.data?.totalMinutes ?? 0),
											})}
										</Typography>
									)}
								</CardContent>
							</Card>
						</Grid>
					</Grid>

					<Card>
						<List dense>
							{months.map((month, index) => (
								<ListItem
									key={index}
									secondaryAction={
										<Typography
											variant="body2"
											color={(month?.balanceMin ?? 0) < 0 ? "error" : "text.secondary"}
										>
											{formatMinutes(month?.balanceMin ?? 0)}
										</Typography>
									}
								>
									<ListItemText
										primary={monthName(index + 1)}
										secondary={
											month
												? `${t("month.worked")} ${formatMinutes(month.workedMin)} · ${t("month.target")} ${formatMinutes(month.targetMin)}`
												: t("reports.empty")
										}
									/>
								</ListItem>
							))}
						</List>
						{months.length === 0 && (
							<Box sx={{ p: 2 }}>
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{t("reports.empty")}
								</Typography>
							</Box>
						)}
					</Card>
				</>
			)}
		</AppShell>
	);
}
