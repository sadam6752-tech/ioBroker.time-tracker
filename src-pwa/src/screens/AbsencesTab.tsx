/**
 * Absences: the administration decides about requests, enters dates for an employee and sees who is away.
 *
 * An employee requests an absence in the app; it waits as `requested` until somebody decides here. The administration
 * books dates for an employee straight away (`approved`). Only approved days count for the working time and the
 * vacation balance, which the server enforces — this screen only drives it.
 */

import { useState } from "react";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, formatDate } from "../api/client";
import type { Absence } from "../api/types";
import { ActionRow } from "../components/ActionRow";
import { ErrorAlert, Loading } from "../components/feedback";

/**
 * Local date of the installation, shifted by a number of days.
 *
 * @param offsetDays - days to add (negative for the past)
 * @returns the date as `YYYY-MM-DD`
 */
function localDate(offsetDays = 0): string {
	const date = new Date();
	date.setDate(date.getDate() + offsetDays);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Shows the absences of all employees and the decisions that belong to them.
 *
 * @param props - language of the display
 * @param props.language - language the dates are formatted in
 * @returns the tab
 */
export function AbsencesTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	// a month back and half a year ahead: the open requests of yesterday and the vacation of the summer
	const from = localDate(-31);
	const to = localDate(183);

	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const types = useQuery({ queryKey: ["absence-types"], queryFn: () => api.absenceTypes() });
	const list = useQuery({
		queryKey: ["absences", "overview", from, to],
		queryFn: () => api.absencesOverview(from, to),
	});

	/** The request the dialog decides about, `null` while the dialog is closed. */
	const [decision, setDecision] = useState<{ absence: Absence; approve: boolean } | null>(null);
	const [reason, setReason] = useState("");
	/** True while the dialog for a new absence of an employee is open. */
	const [formOpen, setFormOpen] = useState(false);
	const [draft, setDraft] = useState({ userId: 0, typeCode: "", dateFrom: localDate(), dateTo: "", note: "" });

	const invalidate = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["absences", "overview"] });
	};

	const decide = useMutation({
		mutationFn: (input: { id: number; approval: "approved" | "rejected"; note?: string }) =>
			api.decideAbsence(input.id, input.approval, input.note),
		onSuccess: async () => {
			setDecision(null);
			setReason("");
			await invalidate();
		},
	});

	const create = useMutation({
		mutationFn: () =>
			api.createAbsence({
				userId: draft.userId,
				typeCode: draft.typeCode,
				dateFrom: draft.dateFrom,
				...(draft.dateTo ? { dateTo: draft.dateTo } : {}),
				...(draft.note ? { note: draft.note } : {}),
			}),
		onSuccess: async () => {
			setFormOpen(false);
			await invalidate();
		},
	});

	const all = list.data ?? [];
	const nameOf = (userId: number): string =>
		people.data?.find(person => person.id === userId)?.displayName ?? `#${userId}`;

	/**
	 * Decides whether an absence covers a given day.
	 *
	 * @param absence - the absence
	 * @param date - local date
	 * @returns true when the day lies inside the absence
	 */
	const covers = (absence: Absence, date: string): boolean => absence.dateFrom <= date && absence.dateTo >= date;

	/**
	 * The period of an absence as one text.
	 *
	 * @param absence - the absence
	 * @returns a single date, or `from – to` for a range
	 */
	const range = (absence: Absence): string =>
		absence.dateFrom === absence.dateTo
			? formatDate(absence.dateFrom, language)
			: `${formatDate(absence.dateFrom, language)} – ${formatDate(absence.dateTo, language)}`;

	const open = all.filter(absence => absence.approval === "requested");
	const today = localDate();
	const away = all
		.filter(absence => absence.approval === "approved" && covers(absence, today))
		.sort((left, right) => nameOf(left.userId).localeCompare(nameOf(right.userId)));

	return (
		<>
			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.absences.pending")}
					</Typography>
					<ErrorAlert error={list.error ?? decide.error} />
					{list.isLoading ? (
						<Loading />
					) : (
						<>
							<List
								dense
								data-testid="absence-requests"
							>
								{open.map(absence => (
									<ActionRow
										key={absence.id}
										primary={`${nameOf(absence.userId)}: ${absence.typeCode} — ${range(absence)}`}
										secondary={
											absence.note ?? t("admin.absences.portion", { portion: absence.dayPortion })
										}
									>
										<Button
											size="small"
											startIcon={<CheckIcon />}
											data-testid={`absence-approve-${absence.id}`}
											onClick={() => {
												setReason("");
												setDecision({ absence, approve: true });
											}}
										>
											{t("admin.absences.approve")}
										</Button>
										<Button
											size="small"
											color="warning"
											startIcon={<CloseIcon />}
											data-testid={`absence-reject-${absence.id}`}
											onClick={() => {
												setReason("");
												setDecision({ absence, approve: false });
											}}
										>
											{t("admin.absences.reject")}
										</Button>
									</ActionRow>
								))}
							</List>
							{open.length === 0 && (
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{t("admin.absences.pendingEmpty")}
								</Typography>
							)}
						</>
					)}
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction="row"
						spacing={1}
						sx={{ alignItems: "center" }}
					>
						<Typography
							variant="subtitle1"
							sx={{ flexGrow: 1 }}
						>
							{t("admin.absences.away", { date: formatDate(today, language) })}
						</Typography>
						<Button
							size="small"
							startIcon={<AddIcon />}
							data-testid="absence-add"
							onClick={() => {
								setDraft({
									userId: people.data?.[0]?.id ?? 0,
									typeCode: (types.data ?? [])[0]?.code ?? "",
									dateFrom: today,
									dateTo: "",
									note: "",
								});
								setFormOpen(true);
							}}
						>
							{t("admin.absences.add")}
						</Button>
					</Stack>
					<List
						dense
						data-testid="absence-away"
					>
						{away.map(absence => (
							<ActionRow
								key={absence.id}
								primary={`${nameOf(absence.userId)}: ${absence.typeCode} — ${absence.typeName ?? ""}`}
								secondary={range(absence)}
							>
								<Chip
									size="small"
									label={absence.typeName ?? absence.typeCode}
								/>
							</ActionRow>
						))}
					</List>
					{away.length === 0 && (
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("admin.absences.awayEmpty")}
						</Typography>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.absences.all")}
					</Typography>
					<List
						dense
						data-testid="absence-all"
					>
						{all.map(absence => (
							<ActionRow
								key={absence.id}
								primary={`${nameOf(absence.userId)}: ${absence.typeCode} — ${range(absence)}`}
								secondary={absence.typeName ?? ""}
							>
								<Chip
									size="small"
									label={t(`absences.state.${absence.approval}`)}
									color={
										absence.approval === "approved"
											? "success"
											: absence.approval === "rejected"
												? "default"
												: "warning"
									}
									variant={absence.approval === "approved" ? "filled" : "outlined"}
								/>
							</ActionRow>
						))}
					</List>
					{all.length === 0 && (
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("admin.absences.allEmpty")}
						</Typography>
					)}
				</CardContent>
			</Card>

			<Dialog
				open={decision !== null}
				onClose={() => setDecision(null)}
				fullWidth
				maxWidth="xs"
			>
				<DialogTitle>
					{decision?.approve ? t("admin.absences.approveTitle") : t("admin.absences.rejectTitle")}
				</DialogTitle>
				<DialogContent>
					<Stack
						spacing={2}
						sx={{ mt: 1 }}
					>
						<ErrorAlert error={decide.error} />
						<Typography variant="body2">
							{decision
								? `${nameOf(decision.absence.userId)}: ${decision.absence.typeCode} — ${range(decision.absence)}`
								: ""}
						</Typography>
						<TextField
							label={decision?.approve ? t("admin.absences.reasonOptional") : t("admin.absences.reason")}
							value={reason}
							size="small"
							multiline
							minRows={2}
							onChange={event => setReason(event.target.value)}
						/>
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDecision(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						color={decision?.approve ? "primary" : "warning"}
						data-testid="absence-decide-save"
						disabled={decide.isPending}
						onClick={() =>
							decision &&
							decide.mutate({
								id: decision.absence.id,
								approval: decision.approve ? "approved" : "rejected",
								...(reason.trim() ? { note: reason.trim() } : {}),
							})
						}
					>
						{decision?.approve ? t("admin.absences.approve") : t("admin.absences.reject")}
					</Button>
				</DialogActions>
			</Dialog>

			<Dialog
				open={formOpen}
				onClose={() => setFormOpen(false)}
				fullWidth
				maxWidth="xs"
			>
				<DialogTitle>{t("admin.absences.addTitle")}</DialogTitle>
				<DialogContent>
					<Stack
						spacing={2}
						sx={{ mt: 1 }}
					>
						<ErrorAlert error={create.error} />
						<TextField
							select
							label={t("admin.absences.employee")}
							value={String(draft.userId)}
							size="small"
							onChange={event => setDraft({ ...draft, userId: Number(event.target.value) })}
						>
							{(people.data ?? []).map(person => (
								<MenuItem
									key={person.id}
									value={String(person.id)}
								>
									{person.displayName}
								</MenuItem>
							))}
						</TextField>
						<TextField
							select
							label={t("admin.absences.type")}
							value={draft.typeCode}
							size="small"
							onChange={event => setDraft({ ...draft, typeCode: event.target.value })}
						>
							{(types.data ?? []).map(type => (
								<MenuItem
									key={type.id}
									value={type.code}
								>
									{type.code} – {type.name}
									{type.reduceVacation ? ` (${t("absences.vacationTag")})` : ""}
								</MenuItem>
							))}
						</TextField>
						<TextField
							label={t("admin.absences.from")}
							type="date"
							value={draft.dateFrom}
							size="small"
							// a date field shows its own placeholder, so the label has to shrink or it overlaps it
							InputLabelProps={{ shrink: true }}
							onChange={event => setDraft({ ...draft, dateFrom: event.target.value })}
						/>
						<TextField
							label={t("admin.absences.to")}
							type="date"
							value={draft.dateTo}
							size="small"
							InputLabelProps={{ shrink: true }}
							onChange={event => setDraft({ ...draft, dateTo: event.target.value })}
						/>
						<TextField
							label={t("admin.absences.note")}
							value={draft.note}
							size="small"
							onChange={event => setDraft({ ...draft, note: event.target.value })}
						/>
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setFormOpen(false)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						data-testid="absence-create-save"
						disabled={
							create.isPending || draft.userId === 0 || draft.typeCode === "" || draft.dateFrom === ""
						}
						onClick={() => create.mutate()}
					>
						{t("common.save")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}
