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
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, formatMinutes } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert, Loading } from "../components/feedback";
import { ReportDownloads } from "../components/ReportDownloads";
import { hasPermission, useSession } from "../state/session";

/**
 * Shows the monthly and yearly figures.
 *
 * @returns the reports screen
 */
export function Reports(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const [year, setYear] = useState(() => new Date().getFullYear());
	const [employeeId, setEmployeeId] = useState<number | undefined>(undefined);
	const { permissions, session } = useSession();
	const maySeePayouts = hasPermission(permissions, "payout.view");
	// looking at another employee needs `report.view_other`; the names behind the picker need `user.view`
	const mayPickEmployee = hasPermission(permissions, "report.view_other") && hasPermission(permissions, "user.view");
	const employees = useQuery({
		queryKey: ["employees"],
		queryFn: () => api.users(),
		enabled: mayPickEmployee,
	});
	const report = useQuery({
		queryKey: ["months", year, employeeId],
		queryFn: () => api.months(year, employeeId),
	});
	// the endpoint needs `payout.view` and knows only the own account, so it is only asked for without a selection
	const payouts = useQuery({
		queryKey: ["payouts", year],
		queryFn: () => api.payouts(year),
		enabled: maySeePayouts && employeeId === undefined,
		retry: false,
	});

	const months = report.data?.months ?? [];
	// label of the selected employee, used as the title of the month view it links to
	const selectedName =
		employeeId === undefined
			? ""
			: ((employees.data ?? []).find(person => person.id === employeeId)?.displayName ?? "");
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

			{/* the administration can look at the figures and the statements of every employee */}
			{mayPickEmployee && (
				<Card sx={{ mb: 2 }}>
					<CardContent>
						<TextField
							select
							fullWidth
							size="small"
							label={t("statistics.employee")}
							value={employeeId ?? ""}
							onChange={event =>
								setEmployeeId(event.target.value === "" ? undefined : Number(event.target.value))
							}
						>
							<MenuItem value="">{session?.user.displayName ?? t("profile.user")}</MenuItem>
							{(employees.data ?? [])
								.filter(person => person.isActive)
								.map(person => (
									<MenuItem
										key={person.id}
										value={person.id}
									>
										{person.displayName}
									</MenuItem>
								))}
						</TextField>
					</CardContent>
				</Card>
			)}

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
									{maySeePayouts && employeeId === undefined && (
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
									// the balance and the download buttons stay beside the text: MUI's absolutely positioned
									// `secondaryAction` reserves the width of one icon only, so they ran over the text on a phone
									sx={{ "& .MuiListItemText-root": { minWidth: 0 } }}
								>
									<ListItemText
										primary={
											employeeId === undefined ? (
												monthName(index + 1)
											) : (
												<Typography
													component={RouterLink}
													to={`/month?year=${year}&month=${index + 1}&userId=${employeeId}&name=${encodeURIComponent(selectedName)}`}
													title={t("month.title")}
													sx={{
														color: "primary.main",
														textDecoration: "none",
														"&:hover": { textDecoration: "underline" },
													}}
												>
													{monthName(index + 1)}
												</Typography>
											)
										}
										secondary={
											month
												? `${t("month.worked")} ${formatMinutes(month.workedMin)} · ${t("month.target")} ${formatMinutes(month.targetMin)}`
												: t("reports.empty")
										}
									/>
									<Stack
										direction="row"
										spacing={1}
										alignItems="center"
										sx={{ flexShrink: 0 }}
									>
										<Typography
											variant="body2"
											color={(month?.balanceMin ?? 0) < 0 ? "error" : "text.secondary"}
										>
											{formatMinutes(month?.balanceMin ?? 0)}
										</Typography>
										{/* the statement of this month, for the months that have one */}
										{month && (
											<ReportDownloads
												year={year}
												month={index + 1}
												userId={employeeId}
												compact
											/>
										)}
									</Stack>
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
