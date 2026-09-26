/**
 * Absences: the list of a year and a simple request form.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate } from "../api/client";
import type { Absence } from "../api/types";
import { AppShell } from "../components/AppShell";
import { ActionRow } from "../components/ActionRow";
import { ErrorAlert, Loading } from "../components/feedback";
import { hasPermission, useSession } from "../state/session";

/**
 * Shows and requests absences.
 *
 * @returns the absence screen
 */
export function Absences(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { permissions } = useSession();
	const queryClient = useQueryClient();
	const [year, setYear] = useState(() => new Date().getFullYear());
	const [typeCode, setTypeCode] = useState("");
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [created, setCreated] = useState(false);

	const mayRequest = hasPermission(permissions, "absence.request");
	const list = useQuery({ queryKey: ["absences", year], queryFn: () => api.absences(year) });
	const types = useQuery({
		queryKey: ["absence-types"],
		queryFn: () => api.absenceTypes(),
		// the list shows the names of the types even to people who may not request absences
		enabled: true,
		staleTime: 5 * 60_000,
	});
	const availableTypes = types.data ?? [];

	/**
	 * Names a type for the list, marking the one that uses up the vacation allowance.
	 *
	 * @param code - the type code of an absence
	 * @returns the suffix for the row, empty when the type is unknown
	 */
	const typeSuffix = (code: string): string => {
		const type = availableTypes.find(candidate => candidate.code === code);
		if (!type) {
			return "";
		}
		return ` · ${type.name}${type.reduceVacation ? ` (${t("absences.vacationTag")})` : ""}`;
	};

	/** Reloads the list of the shown year. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["absences", year] });
	};

	const create = useMutation({
		mutationFn: () =>
			api.createAbsence({
				typeCode: typeCode.trim(),
				dateFrom,
				...(dateTo ? { dateTo } : {}),
			}),
		onSuccess: () => {
			setTypeCode("");
			setDateFrom("");
			setDateTo("");
			setCreated(true);
			void reload();
		},
	});

	/**
	 * The row the dialog works on, `null` while it is closed.
	 *
	 * `withdraw` takes an own request back, `cancel` asks for the cancellation of an approved absence and
	 * `cancelWithdraw` takes that wish back again.
	 */
	const [asking, setAsking] = useState<{ absence: Absence; kind: "withdraw" | "cancel" | "cancelWithdraw" } | null>(
		null,
	);
	const [cancelNote, setCancelNote] = useState("");

	/** An own request that nobody decided about yet simply goes away. */
	const withdraw = useMutation({
		mutationFn: (id: number) => api.deleteAbsence(id),
		onSuccess: async () => {
			setAsking(null);
			await reload();
		},
	});

	/** An approved absence stays booked until the administration answers this wish. */
	const cancelAsk = useMutation({
		mutationFn: (input: { id: number; note?: string }) => api.requestAbsenceCancel(input.id, input.note),
		onSuccess: async () => {
			setAsking(null);
			setCancelNote("");
			await reload();
		},
	});

	const cancelWithdraw = useMutation({
		mutationFn: (id: number) => api.withdrawAbsenceCancel(id),
		onSuccess: async () => {
			setAsking(null);
			await reload();
		},
	});

	/** Runs the action the dialog was opened for. */
	const confirmAsking = (): void => {
		if (!asking) {
			return;
		}
		if (asking.kind === "withdraw") {
			withdraw.mutate(asking.absence.id);
			return;
		}
		if (asking.kind === "cancelWithdraw") {
			cancelWithdraw.mutate(asking.absence.id);
			return;
		}
		cancelAsk.mutate({
			id: asking.absence.id,
			...(cancelNote.trim() ? { note: cancelNote.trim() } : {}),
		});
	};

	/**
	 * The period of an absence as one text.
	 *
	 * @param absence - the absence
	 * @returns a single date, or `from – to` for a range
	 */
	const periodOf = (absence: Absence): string =>
		absence.dateTo && absence.dateTo !== absence.dateFrom
			? `${formatDate(absence.dateFrom, i18n.language)} – ${formatDate(absence.dateTo, i18n.language)}`
			: formatDate(absence.dateFrom, i18n.language);

	/** The own subscription link, `null` while nobody asked for it. */
	const [feedUrl, setFeedUrl] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const calendar = useMutation({
		mutationFn: (rotate: boolean) => api.calendarToken(rotate),
		onSuccess: (token: string) => {
			setFeedUrl(`${window.location.origin}/api/calendar.ics?token=${encodeURIComponent(token)}`);
			setCopied(false);
		},
	});

	/**
	 * Sends the form.
	 *
	 * @param event - form event
	 */
	function submit(event: FormEvent): void {
		event.preventDefault();
		setCreated(false);
		create.mutate();
	}

	return (
		<AppShell title={t("absences.title")}>
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
					<Typography variant="h6">{year}</Typography>
					<IconButton
						onClick={() => setYear(value => value + 1)}
						title={t("month.next")}
					>
						<ChevronRightIcon />
					</IconButton>
				</Stack>
			</Card>

			<ErrorAlert error={list.error} />
			{list.isLoading ? (
				<Loading />
			) : (
				<Card sx={{ mb: 3 }}>
					<List dense>
						{(list.data ?? []).map(absence => (
							<ActionRow
								key={absence.id}
								primary={`${absence.typeCode}: ${periodOf(absence)}${typeSuffix(absence.typeCode)}`}
								secondary={`${t("absences.portion")}: ${absence.dayPortion}${
									absence.approval === "rejected" && absence.decisionNote
										? ` · ${t("absences.reason")}: ${absence.decisionNote}`
										: ""
								}${
									absence.cancelRequestedAt
										? ` · ${t("absences.cancelPending")}${
												absence.cancelNote ? `: ${absence.cancelNote}` : ""
											}`
										: ""
								}`}
							>
								{absence.approval === "requested" && (
									<Button
										size="small"
										data-testid={`absence-withdraw-${absence.id}`}
										onClick={() => setAsking({ absence, kind: "withdraw" })}
									>
										{t("absences.withdraw")}
									</Button>
								)}
								{absence.approval === "approved" && !absence.cancelRequestedAt && (
									<Button
										size="small"
										color="warning"
										data-testid={`absence-cancel-${absence.id}`}
										onClick={() => setAsking({ absence, kind: "cancel" })}
									>
										{t("absences.cancelAsk")}
									</Button>
								)}
								{absence.cancelRequestedAt ? (
									<Button
										size="small"
										data-testid={`absence-cancel-withdraw-${absence.id}`}
										onClick={() => setAsking({ absence, kind: "cancelWithdraw" })}
									>
										{t("absences.cancelWithdraw")}
									</Button>
								) : null}
								<Chip
									size="small"
									color={
										absence.approval === "approved"
											? "success"
											: absence.approval === "rejected"
												? "default"
												: "warning"
									}
									variant={absence.approval === "approved" ? "filled" : "outlined"}
									label={t(`absences.state.${absence.approval}`)}
								/>
							</ActionRow>
						))}
					</List>
					{(list.data ?? []).length === 0 && (
						<Box sx={{ p: 2 }}>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("absences.empty")}
							</Typography>
						</Box>
					)}
				</Card>
			)}

			{mayRequest && (
				<Card>
					<CardContent>
						<Typography
							variant="h6"
							gutterBottom
						>
							{t("absences.create")}
						</Typography>
						{created && <Alert severity="success">{t("absences.created")}</Alert>}
						<ErrorAlert error={create.error} />
						<Box
							component="form"
							onSubmit={submit}
						>
							<Stack spacing={2}>
								{availableTypes.length > 0 ? (
									<TextField
										select
										label={t("absences.type")}
										value={typeCode}
										required
										size="small"
										onChange={event => setTypeCode(event.target.value)}
									>
										{availableTypes.map(type => (
											<MenuItem
												key={type.id}
												value={type.code}
											>
												{type.code} – {type.name}
												{type.reduceVacation ? ` (${t("absences.vacationTag")})` : ""}
											</MenuItem>
										))}
									</TextField>
								) : (
									<TextField
										label={t("absences.type")}
										value={typeCode}
										required
										size="small"
										helperText={t("absences.typeHint")}
										onChange={event => setTypeCode(event.target.value)}
									/>
								)}
								<TextField
									label={t("absences.from")}
									type="date"
									value={dateFrom}
									required
									size="small"
									InputLabelProps={{ shrink: true }}
									onChange={event => setDateFrom(event.target.value)}
								/>
								<TextField
									label={t("absences.to")}
									type="date"
									value={dateTo}
									size="small"
									InputLabelProps={{ shrink: true }}
									onChange={event => setDateTo(event.target.value)}
								/>
								<Button
									type="submit"
									variant="contained"
									disabled={create.isPending}
								>
									{t("common.save")}
								</Button>
							</Stack>
						</Box>
					</CardContent>
				</Card>
			)}
			<Card sx={{ mb: 3 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("absences.calendar")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						sx={{ mb: 1 }}
					>
						{t("absences.calendarHint")}
					</Typography>
					{feedUrl !== null && (
						<TextField
							fullWidth
							size="small"
							value={feedUrl}
							InputProps={{ readOnly: true }}
							sx={{ mb: 1 }}
							data-testid="calendar-url"
						/>
					)}
					<Stack
						direction="row"
						spacing={1}
						flexWrap="wrap"
					>
						<Button
							size="small"
							variant="outlined"
							disabled={calendar.isPending}
							data-testid="calendar-request"
							onClick={() => calendar.mutate(false)}
						>
							{t(feedUrl === null ? "absences.calendarShow" : "absences.calendarReload")}
						</Button>
						{feedUrl !== null && (
							<>
								<Button
									size="small"
									data-testid="calendar-copy"
									onClick={() => {
										void navigator.clipboard.writeText(feedUrl);
										setCopied(true);
									}}
								>
									{copied ? t("absences.calendarCopied") : t("absences.calendarCopy")}
								</Button>
								<Button
									size="small"
									color="warning"
									disabled={calendar.isPending}
									data-testid="calendar-rotate"
									onClick={() => calendar.mutate(true)}
								>
									{t("absences.calendarRotate")}
								</Button>
							</>
						)}
					</Stack>
					<ErrorAlert error={calendar.error} />
				</CardContent>
			</Card>

			<Dialog
				open={asking !== null}
				onClose={() => setAsking(null)}
				fullWidth
				maxWidth="xs"
			>
				<DialogTitle>
					{asking?.kind === "withdraw"
						? t("absences.withdrawTitle")
						: asking?.kind === "cancel"
							? t("absences.cancelTitle")
							: t("absences.cancelWithdrawTitle")}
				</DialogTitle>
				<DialogContent>
					<Stack
						spacing={2}
						sx={{ mt: 1 }}
					>
						<ErrorAlert error={withdraw.error ?? cancelAsk.error ?? cancelWithdraw.error} />
						<Typography variant="body2">
							{asking ? `${asking.absence.typeCode}: ${periodOf(asking.absence)}` : ""}
						</Typography>
						{asking?.kind === "cancel" && (
							<TextField
								label={t("absences.cancelNote")}
								value={cancelNote}
								size="small"
								multiline
								minRows={2}
								onChange={event => setCancelNote(event.target.value)}
							/>
						)}
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setAsking(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						data-testid="absence-ask-save"
						disabled={withdraw.isPending || cancelAsk.isPending || cancelWithdraw.isPending}
						onClick={confirmAsking}
					>
						{asking?.kind === "cancel" ? t("absences.cancelAsk") : t("absences.withdraw")}
					</Button>
				</DialogActions>
			</Dialog>
		</AppShell>
	);
}
