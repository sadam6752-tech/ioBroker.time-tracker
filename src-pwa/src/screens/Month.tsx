/**
 * Month view: the days of a month with worked, target and balance.
 */

import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
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
import { api, formatMinutes, formatWeekday } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert, Loading } from "../components/feedback";
import { ReportDownloads } from "../components/ReportDownloads";
import { useSession } from "../state/session";

/**
 * Builds the first and the last day of a month.
 *
 * @param year - year
 * @param month - month, 1 based
 * @returns inclusive range of local dates
 */
function monthRange(year: number, month: number): { from: string; to: string } {
	const from = `${year}-${String(month).padStart(2, "0")}-01`;
	// day 0 of the next month is the last day of this one
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return { from, to: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * Shows the calendar days of a month.
 *
 * @returns the month screen
 */
export function Month(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { session } = useSession();
	const [cursor, setCursor] = useState(() => {
		const now = new Date();
		const timeZone = session?.user.timezone;
		const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(now);
		const [year, month] = parts.split("-");
		return { year: Number(year), month: Number(month) };
	});

	const range = monthRange(cursor.year, cursor.month);
	const days = useQuery({
		queryKey: ["days", range.from, range.to],
		queryFn: () => api.days(range.from, range.to),
	});

	/**
	 * Moves the shown month.
	 *
	 * @param delta - months to move
	 */
	function move(delta: number): void {
		const next = new Date(Date.UTC(cursor.year, cursor.month - 1 + delta, 1));
		setCursor({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 });
	}

	const monthLabel = new Intl.DateTimeFormat(i18n.language, {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${range.from}T12:00:00Z`));

	return (
		<AppShell title={t("month.title")}>
			<Card sx={{ mb: 2 }}>
				<Stack
					direction="row"
					alignItems="center"
					justifyContent="space-between"
					sx={{ p: 1 }}
				>
					<IconButton
						onClick={() => move(-1)}
						title={t("month.previous")}
					>
						<ChevronLeftIcon />
					</IconButton>
					<Typography variant="h6">{monthLabel}</Typography>
					<IconButton
						onClick={() => move(1)}
						title={t("month.next")}
					>
						<ChevronRightIcon />
					</IconButton>
				</Stack>
			</Card>

			<ErrorAlert error={days.error} />
			{/* the statement of the shown month can be downloaded as Excel or PDF */}
			<Box sx={{ mb: 2 }}>
				<ReportDownloads
					year={cursor.year}
					month={cursor.month}
				/>
			</Box>
			{days.isLoading ? (
				<Loading />
			) : (
				<>
					<Stack
						direction="row"
						spacing={3}
						sx={{ px: 1, mb: 1 }}
					>
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("month.worked")}: {formatMinutes(days.data?.workedMin ?? 0)}
						</Typography>
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("month.target")}: {formatMinutes(days.data?.targetMin ?? 0)}
						</Typography>
						<Typography
							variant="body2"
							color={(days.data?.balanceMin ?? 0) < 0 ? "error" : "text.secondary"}
						>
							{t("month.balance")}: {formatMinutes(days.data?.balanceMin ?? 0)}
						</Typography>
					</Stack>

					<Card>
						<List dense>
							{(days.data?.days ?? []).map(day => (
								<ListItem
									key={day.localDate}
									secondaryAction={
										<Typography
											variant="body2"
											color={day.balanceMin < 0 ? "error" : "text.secondary"}
										>
											{formatMinutes(day.balanceMin)}
										</Typography>
									}
								>
									<ListItemText
										primary={formatWeekday(day.localDate, i18n.language)}
										secondary={[
											`${t("month.worked")} ${formatMinutes(day.workedMin)}`,
											`${t("month.target")} ${formatMinutes(day.targetMin)}`,
											day.isHoliday ? t("month.holiday") : null,
											day.absenceCode ? `${t("month.absence")}: ${day.absenceCode}` : null,
											day.hasOpenEntry ? t("month.open") : null,
										]
											.filter(Boolean)
											.join(" · ")}
									/>
								</ListItem>
							))}
						</List>
						{(days.data?.days ?? []).length === 0 && (
							<Box sx={{ p: 2 }}>
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{t("month.empty")}
								</Typography>
							</Box>
						)}
					</Card>
				</>
			)}
		</AppShell>
	);
}
